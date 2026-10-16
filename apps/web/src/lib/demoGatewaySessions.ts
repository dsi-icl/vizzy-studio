import '@tanstack/react-start/server-only';
import { randomBytes } from 'node:crypto';

import type { DemoGatewayKind } from './demoGatewayPaths';

interface DemoGrantBase {
    projectId: string;
    kind: DemoGatewayKind;
    slug: string;
    entryPath: string;
}

export type DemoGrant = DemoGrantBase &
    (
        | {
              access: 'wall';
              wallId: string;
              scopeId: number;
          }
        | {
              access: 'admin-preview';
          }
    );

type StoredGrant = DemoGrant & { expiresAt: number; routeId?: string };

const LAUNCH_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const ADMIN_PREVIEW_TTL_MS = 15 * 60_000;
const launches = new Map<string, StoredGrant>();
const sessions = new Map<string, StoredGrant>();

function token(): string {
    return randomBytes(32).toString('base64url');
}

function prune(map: Map<string, StoredGrant>): void {
    const now = Date.now();
    for (const [key, grant] of map) {
        if (grant.expiresAt <= now) map.delete(key);
    }
}

export function issueDemoLaunch(grant: DemoGrant): { ticket: string; expiresAt: number } {
    prune(launches);
    const ticket = token();
    const expiresAt = Date.now() + LAUNCH_TTL_MS;
    launches.set(ticket, { ...grant, expiresAt });
    return { ticket, expiresAt };
}

export function consumeDemoLaunch(ticket: string): DemoGrant | null {
    const grant = launches.get(ticket);
    launches.delete(ticket);
    if (!grant || grant.expiresAt <= Date.now()) return null;
    const { expiresAt: _, ...rest } = grant;
    return rest;
}

export function issueDemoSession(grant: DemoGrant): {
    token: string;
    routeId: string;
    expiresAt: number;
} {
    prune(sessions);
    const sessionToken = token();
    const routeId = randomBytes(16).toString('base64url');
    const expiresAt =
        Date.now() + (grant.access === 'admin-preview' ? ADMIN_PREVIEW_TTL_MS : SESSION_TTL_MS);
    sessions.set(sessionToken, { ...grant, expiresAt, routeId });
    return { token: sessionToken, routeId, expiresAt };
}

export function getDemoSession(sessionToken: string): DemoGrant | null {
    const grant = sessions.get(sessionToken);
    if (!grant) return null;
    const now = Date.now();
    if (grant.expiresAt <= now) {
        sessions.delete(sessionToken);
        return null;
    }
    if (grant.access === 'wall') grant.expiresAt = now + SESSION_TTL_MS;
    const { expiresAt: _, routeId: __, ...rest } = grant;
    return rest;
}

export function getDemoSessionRouteId(sessionToken: string): string | null {
    if (!getDemoSession(sessionToken)) return null;
    return sessions.get(sessionToken)?.routeId ?? null;
}

function revokeWhere(predicate: (grant: StoredGrant) => boolean): void {
    for (const map of [launches, sessions]) {
        for (const [key, grant] of map) {
            if (predicate(grant)) map.delete(key);
        }
    }
}

export function revokeDemoSessionsForWall(wallId: string): void {
    revokeWhere((grant) => grant.access === 'wall' && grant.wallId === wallId);
}

export function revokeDemoSessionsForScope(scopeId: number): void {
    revokeWhere((grant) => grant.access === 'wall' && grant.scopeId === scopeId);
}
