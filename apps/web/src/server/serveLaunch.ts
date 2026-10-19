import '@tanstack/react-start/server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '@repo/env';

import { collections } from '~/server/collections';

import type { ServeActor } from './serveCookie';

const LAUNCH_TTL_MS = 60_000;
const launches = collections.serveLaunches;
let indexReady: Promise<string> | null = null;

function signingSecret(): string {
    if (!env.SERVER_AUTH_SECRET) throw new Error('SERVER_AUTH_SECRET is required for demo launch');
    return env.SERVER_AUTH_SECRET;
}

function sign(value: string): string {
    return createHmac('sha256', signingSecret())
        .update('serve-launch-v1:')
        .update(value)
        .digest('base64url');
}

function ticketHash(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

interface LaunchPayload {
    v: 1;
    projectId: string;
    routeId: string;
    entry: 'screen' | 'control';
    actor: ServeActor;
    id: string;
    exp: number;
}

function isLaunchPayload(value: unknown): value is LaunchPayload {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Partial<LaunchPayload>;
    const actor = payload.actor as Partial<ServeActor> | undefined;
    return (
        payload.v === 1 &&
        typeof payload.projectId === 'string' &&
        /^[a-f\d]{24}$/i.test(payload.projectId) &&
        typeof payload.routeId === 'string' &&
        /^[A-Za-z\d_-]{22}$/.test(payload.routeId) &&
        (payload.entry === 'screen' || payload.entry === 'control') &&
        typeof payload.id === 'string' &&
        /^[A-Za-z\d_-]{43}$/.test(payload.id) &&
        typeof payload.exp === 'number' &&
        Number.isFinite(payload.exp) &&
        !!actor &&
        (actor.surface === 'wall' || actor.surface === 'control'
            ? typeof actor.wallId === 'string' &&
              typeof actor.scopeId === 'number' &&
              typeof actor.bindingId === 'string' &&
              /^[A-Za-z\d_-]{22}$/.test(actor.bindingId)
            : actor.surface === 'preview-screen' || actor.surface === 'preview-control')
    );
}

export async function issueServeLaunch(input: {
    projectId: string;
    entry: 'screen' | 'control';
    actor: ServeActor;
}): Promise<{ ticket: string; routeId: string }> {
    indexReady ??= launches
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        .catch((error) => {
            indexReady = null;
            throw error;
        });
    await indexReady;
    const payload: LaunchPayload = {
        v: 1,
        ...input,
        routeId: randomBytes(16).toString('base64url'),
        id: randomBytes(32).toString('base64url'),
        exp: Date.now() + LAUNCH_TTL_MS
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    await launches.insertOne({ _id: ticketHash(payload.id), expiresAt: new Date(payload.exp) });
    return { ticket: `${encoded}.${sign(encoded)}`, routeId: payload.routeId };
}

export async function consumeServeLaunch(ticket: string): Promise<LaunchPayload | null> {
    if (ticket.length > 1024) return null;
    const [encoded, signature, extra] = ticket.split('.');
    if (!encoded || !signature || extra) return null;
    const expected = Buffer.from(sign(encoded));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!isLaunchPayload(parsed) || parsed.exp <= Date.now()) return null;
    const consumed = await launches.findOneAndDelete({
        _id: ticketHash(parsed.id),
        expiresAt: { $gt: new Date() }
    });
    return consumed ? parsed : null;
}
