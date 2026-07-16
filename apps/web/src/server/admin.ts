import '@tanstack/react-start/server-only';
import { auth } from '@repo/auth/auth';
import { createSmtpTransport } from '@repo/auth/smtp';
import { getSmtpConfig, listConfigEntries, setConfigValue } from '@repo/db/config';
import type { AuthContext } from '@repo/db/documents';
import type { CollaboratorRole } from '@repo/db/schema';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { ObjectId } from 'mongodb';

import {
    getBusRuntimeTelemetry,
    getIntendedWallNodeCount,
    getWallNodeCount,
    hydrateWallNodes,
    notifyControllers,
    peerCounts,
    unbindWall,
    wallsByWallId
} from '~/lib/busState';
import type { AuditExecutionContextInput } from '~/server/audit';
import { logAuditSuccess } from '~/server/audit';
import { dbCol, collections } from '~/server/collections';
import { adminEnrollDeviceBySignature, adminListDevices } from '~/server/devices';

let prevCpuUsage = process.cpuUsage();
let prevCpuAt = process.hrtime.bigint();
let prevBusSample: {
    at: number;
    incomingTotal: number;
    outgoingTotal: number;
} | null = null;

interface AdminAuditContext {
    authContext?: AuthContext | null;
    executionContext?: AuditExecutionContextInput | null;
}

function withAdminAuditContext(auditContext?: AdminAuditContext) {
    return {
        authContext: auditContext?.authContext ?? null,
        executionContext: auditContext?.executionContext ?? null
    };
}

function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function forwardSetCookieHeaders(result: unknown) {
    const headers =
        result && typeof result === 'object' && 'headers' in (result as Record<string, unknown>)
            ? ((result as { headers?: unknown }).headers ?? null)
            : null;
    const getSetCookie =
        headers &&
        typeof headers === 'object' &&
        typeof (headers as { getSetCookie?: unknown }).getSetCookie === 'function'
            ? ((headers as { getSetCookie: () => string[] }).getSetCookie() ?? [])
            : [];
    if (Array.isArray(getSetCookie) && getSetCookie.length > 0) {
        setResponseHeader('Set-Cookie', getSetCookie);
    }
}

async function resolveUserByBetterAuthId(userId: string) {
    const normalized = userId.trim();
    if (!normalized) return null;
    let user = await collections.users.findOne(
        { id: normalized },
        { projection: { id: 1, email: 1, role: 1 } }
    );
    if (!user && /^[0-9a-f]{24}$/i.test(normalized)) {
        user = await collections.users.findOne(
            { _id: new ObjectId(normalized) },
            { projection: { id: 1, email: 1, role: 1 } }
        );
    }
    return user;
}

async function findWallById(identifier: string) {
    const normalized = identifier.trim();
    if (!normalized) return null;

    const exact = await dbCol.walls.findOne({ wallId: normalized });
    if (exact) return exact;

    const whitespaceTolerant = await dbCol.walls.findOne({
        wallId: { $regex: `^\\s*${escapeRegex(normalized)}\\s*$`, $options: 'i' }
    });
    if (whitespaceTolerant) return whitespaceTolerant;

    if (/^[0-9a-f]{24}$/i.test(normalized)) {
        const byId = await dbCol.walls.findById(normalized);
        if (byId) return byId;
    }

    return null;
}

export async function adminListUsers() {
    const users = collections.users;
    const sessions = collections.sessions;

    const [userRecords, activeSessions] = await Promise.all([
        users.find({}).sort({ createdAt: -1 }).limit(500).toArray(),
        sessions
            .find({ expiresAt: { $gt: new Date() } })
            .project({ userId: 1 })
            .toArray()
    ]);

    const activeUserIds = new Set(activeSessions.map((s) => String(s.userId)));

    return userRecords.map((user) => {
        const { _id, ...userFields } = user;
        const id =
            typeof userFields.id === 'string' && userFields.id.trim().length > 0
                ? userFields.id.trim()
                : _id.toHexString();
        return { ...userFields, id, isActiveSession: activeUserIds.has(id) };
    });
}

export async function adminListProjects() {
    const projects = await dbCol.projects.find({}, { sort: { updatedAt: -1 } });
    return projects;
}

export async function adminUpdateProjectCollaborators(
    input: {
        projectId: string;
        collaborators: Array<{ email: string; role: CollaboratorRole }>;
    },
    actorEmail: string,
    auditContext?: AdminAuditContext
) {
    const project = await dbCol.projects.findById(input.projectId);
    if (!project) throw new Error('Project not found');

    const byEmail = new Map<string, { email: string; role: CollaboratorRole }>();
    for (const entry of input.collaborators) {
        const email = entry.email.trim().toLowerCase();
        if (!email) continue;
        byEmail.set(email, { email, role: entry.role });
    }

    if (!Array.from(byEmail.values()).some((c) => c.role === 'owner')) {
        const ownerEmail = project.createdBy.trim().toLowerCase();
        byEmail.set(ownerEmail, { email: ownerEmail, role: 'owner' });
    }
    const normalized = Array.from(byEmail.values());

    const updated = await dbCol.projects.update(project.id, { collaborators: normalized });
    if (!updated) throw new Error('Project not found');

    await logAuditSuccess({
        action: 'ADMIN_PROJECT_COLLABORATORS_UPDATED',
        actorId: actorEmail,
        projectId: project.id,
        resourceType: 'project',
        resourceId: project.id,
        changes: { collaborators: normalized },
        ...withAdminAuditContext(auditContext)
    });

    process.__BROADCAST_PROJECTS_CHANGED__?.(project.id);
    return updated;
}

export async function adminListAuditsPage(input: {
    projectId?: string | null;
    limit?: number;
    cursor?: { createdAt: number; id: string } | null;
    outcomes?: Array<'success' | 'denied' | 'failure' | 'error'>;
    resourceTypes?: Array<
        | 'project'
        | 'commit'
        | 'asset'
        | 'wall'
        | 'device'
        | 'user'
        | 'upload_token'
        | 'start_route'
        | 'ws_message'
        | 'portal_token'
        | 'bootstrap'
        | 'config'
        | 'smtp'
        | 'scope'
        | 'unknown'
    >;
    operation?: string;
    surface?: 'http' | 'serverfn' | 'ws' | 'yjs' | 'job' | 'system' | 'unknown' | null;
    actorId?: string;
    reasonCode?: string;
}) {
    return dbCol.audits.queryGlobal({
        projectId: input.projectId ?? null,
        limit: input.limit,
        cursor: input.cursor ?? null,
        outcomes: input.outcomes,
        resourceTypes: input.resourceTypes,
        operation: input.operation,
        surface: input.surface ?? undefined,
        actorIds: input.actorId ? [input.actorId] : undefined,
        reasonCodes: input.reasonCode ? [input.reasonCode] : undefined
    });
}

export async function adminGetStats() {
    const [userCount, projectCount, commitCount, assetCount] = await Promise.all([
        collections.users.countDocuments(),
        dbCol.projects.count(),
        dbCol.commits.count(),
        dbCol.assets.count({ deletedAt: { $exists: false } })
    ]);
    const wallIds = await dbCol.walls.listWallIds();
    const wallSummary: Record<string, number> = {};
    for (const wallId of wallIds) {
        wallSummary[wallId] = getWallNodeCount(wallId);
    }

    const mem = process.memoryUsage();
    const nowHr = process.hrtime.bigint();
    const cpuUsage = process.cpuUsage(prevCpuUsage);
    const elapsedUs = Number(nowHr - prevCpuAt) / 1000;
    const cpuPercent =
        elapsedUs > 0
            ? Math.max(0, Math.min(100, ((cpuUsage.user + cpuUsage.system) / elapsedUs) * 100))
            : 0;
    prevCpuUsage = process.cpuUsage();
    prevCpuAt = nowHr;

    const bus = getBusRuntimeTelemetry();
    const incomingTotal = bus.incomingJson + bus.incomingBinary;
    const outgoingTotal = bus.outgoingJson + bus.outgoingBinary;
    let incomingPerSec = 0;
    let outgoingPerSec = 0;
    const nowMs = Date.now();
    if (prevBusSample) {
        const dtSec = Math.max(0.001, (nowMs - prevBusSample.at) / 1000);
        incomingPerSec = Math.max(0, (incomingTotal - prevBusSample.incomingTotal) / dtSec);
        outgoingPerSec = Math.max(0, (outgoingTotal - prevBusSample.outgoingTotal) / dtSec);
    }
    prevBusSample = { at: nowMs, incomingTotal, outgoingTotal };

    return {
        db: { users: userCount, projects: projectCount, commits: commitCount, assets: assetCount },
        live: { ...peerCounts },
        uptime: process.uptime(),
        walls: wallSummary,
        system: {
            cpuPercent,
            rssMb: mem.rss / 1024 / 1024,
            heapUsedMb: mem.heapUsed / 1024 / 1024,
            heapTotalMb: mem.heapTotal / 1024 / 1024
        },
        bus: {
            ...bus,
            incomingPerSec,
            outgoingPerSec
        }
    };
}

export async function adminListWalls() {
    const connectedDeviceIdsByWallId = new Map<string, Set<string>>();
    const allConnectedDeviceIds = new Set<string>();
    for (const [wallId, wallPeers] of wallsByWallId) {
        let perWall = connectedDeviceIdsByWallId.get(wallId);
        if (!perWall) {
            perWall = new Set<string>();
            connectedDeviceIdsByWallId.set(wallId, perWall);
        }
        for (const entry of wallPeers) {
            if (entry.meta.specimen !== 'wall') continue;
            const deviceId = entry.meta.authContext?.device?.id;
            if (typeof deviceId === 'string' && deviceId.length > 0) {
                perWall.add(deviceId);
                allConnectedDeviceIds.add(deviceId);
            }
        }
    }

    const [wallDocs, wallDeviceCounts, connectedAssignedDevices] = await Promise.all([
        dbCol.walls.find({}, { sort: { lastSeen: -1 } }),
        dbCol.devices.aggregateCountByWall(),
        dbCol.devices.findWallAssignmentsByIds(Array.from(allConnectedDeviceIds))
    ]);
    const assignedStatsByWallId = new Map(
        wallDeviceCounts.map((entry) => [entry.wallId, { total: Number(entry.total ?? 0) }])
    );
    const assignedWallIdByDeviceId = new Map<string, string>();
    for (const device of connectedAssignedDevices) {
        if (device.id && device.assignedWallId) {
            assignedWallIdByDeviceId.set(device.id, device.assignedWallId);
        }
    }
    return wallDocs.map((wall) => ({
        ...wall,
        assignedConnectedNodes: (() => {
            const wallId = String(wall.wallId ?? '');
            const connectedForWall = connectedDeviceIdsByWallId.get(wallId);
            if (!connectedForWall || connectedForWall.size === 0) return 0;
            let total = 0;
            for (const deviceId of connectedForWall) {
                if (assignedWallIdByDeviceId.get(deviceId) === wallId) total += 1;
            }
            return total;
        })(),
        assignedScreenCount: assignedStatsByWallId.get(String(wall.wallId ?? ''))?.total ?? 0,
        intendedConnectedNodes: getIntendedWallNodeCount(String(wall.wallId ?? ''))
    }));
}

export async function adminCreateWall(input: { wallId: string; name?: string | null }) {
    const wallId = input.wallId.trim();
    if (!wallId) throw new Error('Wall ID is required');
    const now = Date.now();

    const existing = await dbCol.walls.findOne({ wallId });
    if (existing) throw new Error('Wall already exists');

    const wall = await dbCol.walls.insert({
        wallId,
        name: input.name?.trim() || wallId,
        lastSeen: now,
        boundProjectId: null,
        boundCommitId: null,
        boundSlideId: null,
        boundSource: null,
        site: null,
        notes: null
    });
    await logAuditSuccess({
        action: 'WALL_CREATED',
        resourceType: 'wall',
        resourceId: wallId,
        changes: { name: wall.name }
    });
    return wall;
}

export async function adminGetWall(wallId: string) {
    const targetWallId = wallId.trim();
    if (!targetWallId) throw new Error('Wall ID is required');
    const wall = await findWallById(targetWallId);
    if (!wall) throw new Error('Wall not found');
    return {
        wallId: String(wall.wallId ?? targetWallId),
        name: wall.name ? String(wall.name) : null
    };
}

export async function adminUpdateWallMetadata(input: {
    wallId: string;
    name?: string | null;
    site?: string | null;
    notes?: string | null;
}): Promise<{ ok: true }> {
    const wallId = input.wallId.trim();
    if (!wallId) throw new Error('Wall ID is required');
    const update = {
        name: input.name?.trim() || wallId,
        site: input.site?.trim() || null,
        notes: input.notes?.trim() || null
    };

    const existing = await findWallById(wallId);
    if (!existing) throw new Error('Wall not found');

    const result = await dbCol.walls.update(existing.id, update);
    if (!result) throw new Error('Wall not found');
    await logAuditSuccess({
        action: 'WALL_UPDATED',
        resourceType: 'wall',
        resourceId: String(existing.wallId ?? wallId),
        changes: update
    });
    return { ok: true };
}

export async function adminDeleteWall(wallId: string) {
    const targetWallId = wallId.trim();
    if (!targetWallId) throw new Error('Wall ID is required');
    const existing = await findWallById(targetWallId);
    if (!existing) throw new Error('Wall not found');
    const resolvedWallId = String(existing.wallId ?? targetWallId).trim();

    unbindWall(resolvedWallId);
    hydrateWallNodes(resolvedWallId);
    notifyControllers(resolvedWallId, false);

    await Promise.all([
        dbCol.walls.delete(existing.id),
        dbCol.devices.detachFromWall(resolvedWallId)
    ]);
    await logAuditSuccess({
        action: 'WALL_DELETED',
        resourceType: 'wall',
        resourceId: resolvedWallId
    });

    process.__BROADCAST_WALL_BINDING_CHANGED__?.(resolvedWallId);
}

export async function adminListDevicesForWall(wallId: string) {
    const targetWallId = wallId.trim();
    if (!targetWallId) throw new Error('Wall ID is required');
    const existing = await findWallById(targetWallId);
    if (!existing) throw new Error('Wall not found');
    const resolvedWallId = String(existing.wallId ?? targetWallId).trim();
    const devices = await dbCol.devices.find(
        { assignedWallId: resolvedWallId },
        { sort: { updatedAt: -1 } }
    );
    return devices;
}

export async function adminGetWallBindingMeta(input: {
    boundProjectId?: string | null;
    boundCommitId?: string | null;
    boundSlideId?: string | null;
}) {
    const { boundProjectId, boundCommitId, boundSlideId } = input;
    if (!boundProjectId) {
        return { projectName: null, slideName: null };
    }

    let projectName: string | null = null;
    let slideName: string | null = null;

    try {
        const project = await dbCol.projects.findById(boundProjectId);
        projectName = project?.name ? String(project.name) : null;
    } catch {
        // Keep null fallback when IDs are malformed or project does not exist.
    }

    if (boundCommitId && boundSlideId) {
        try {
            const commit = await dbCol.commits.findById(boundCommitId);
            const rawSlides = commit?.content?.slides;
            if (Array.isArray(rawSlides)) {
                const slide = rawSlides.find(
                    (entry) =>
                        entry &&
                        typeof entry === 'object' &&
                        Reflect.get(entry, 'id') === boundSlideId
                );
                const maybeName = slide ? Reflect.get(slide, 'name') : null;
                slideName =
                    typeof maybeName === 'string' && maybeName.length > 0 ? maybeName : null;
            }
        } catch {
            // Keep null fallback when IDs are malformed or commit does not exist.
        }
    }

    return { projectName, slideName };
}

export async function adminUnbindWall(wallId: string) {
    unbindWall(wallId);
    hydrateWallNodes(wallId);
    notifyControllers(wallId, false);

    await dbCol.walls.updateByWallId(wallId, {
        boundProjectId: null,
        boundCommitId: null,
        boundSlideId: null,
        boundSource: null
    });
    await logAuditSuccess({
        action: 'WALL_UNBOUND',
        resourceType: 'wall',
        resourceId: wallId
    });

    process.__BROADCAST_WALL_BINDING_CHANGED__?.(wallId);
}

export async function adminDevicesList() {
    return adminListDevices();
}

export async function adminDevicesEnrollBySignature(input: {
    id: string;
    signature: string;
    kind: 'wall' | 'gallery' | 'controller';
    wallId: string;
    assignedBy: string;
}) {
    const wall = await findWallById(input.wallId);
    if (!wall) throw new Error('Wall not found');
    const resolvedWallId = String(wall.wallId ?? input.wallId).trim();
    const enrolled = await adminEnrollDeviceBySignature({
        ...input,
        wallId: resolvedWallId
    });
    process.__REBOOT_DEVICE__?.(
        enrolled.id,
        typeof enrolled.publicKey === 'string' ? enrolled.publicKey : undefined
    );
    return enrolled;
}

export async function adminDeleteDevice(input: { id: string; deletedBy: string }) {
    const id = input.id.trim();
    if (!id) throw new Error('Device ID is required');

    const existing = await dbCol.devices.findById(id);
    if (!existing) throw new Error('Device not found');

    await dbCol.devices.delete(id);
    await logAuditSuccess({
        action: 'DEVICE_DELETED',
        actorId: input.deletedBy,
        resourceType: 'device',
        resourceId: id
    });
    process.__DISCONNECT_DEVICE__?.(id);

    return { ok: true };
}

export async function adminRecomputeBusAuthContext(input: { email?: string }) {
    const payload = {
        ...(input.email ? { email: input.email } : {})
    };

    const [busSettled, yjsSettled] = await Promise.allSettled([
        process.__BUS_RECOMPUTE_AUTH_CONTEXT__?.(payload),
        process.__YJS_RECOMPUTE_AUTH_CONTEXT__?.(payload)
    ]);

    if (busSettled.status === 'rejected') {
        console.warn('[Admin] BUS auth-context recompute failed', busSettled.reason);
    }
    if (yjsSettled.status === 'rejected') {
        console.warn('[Admin] YJS auth-context recompute failed', yjsSettled.reason);
    }

    return {
        bus: busSettled.status === 'fulfilled' ? busSettled.value : null,
        yjs: yjsSettled.status === 'fulfilled' ? yjsSettled.value : null
    };
}

export async function adminSetUserBanStatus(input: {
    userId: string;
    banned: boolean;
    actorEmail: string;
}) {
    const userId = input.userId.trim();
    if (!userId) throw new Error('User ID is required');

    const user = await collections.users.findOne(
        { id: userId },
        { projection: { email: 1, id: 1 } }
    );
    if (!user) throw new Error('User not found');
    if (user.email === input.actorEmail)
        throw new Error('You cannot modify your own account status');

    const headers = getRequest().headers;

    if (input.banned) {
        await auth.api.banUser({
            headers,
            body: { userId }
        });
    } else {
        await auth.api.unbanUser({
            headers,
            body: { userId }
        });
    }

    if (typeof user.email === 'string' && user.email.length > 0) {
        await adminRecomputeBusAuthContext({ email: user.email });
    }

    await logAuditSuccess({
        action: input.banned ? 'ADMIN_USER_BANNED' : 'ADMIN_USER_UNBANNED',
        actorId: input.actorEmail,
        resourceType: 'user',
        resourceId: userId,
        changes: { banned: input.banned }
    });
}

export async function adminSetUserRole(input: {
    userId?: string | null;
    userEmail?: string | null;
    role: 'admin' | 'operator' | 'user';
    actorEmail: string;
}) {
    const userId = (input.userId ?? '').trim();
    const userEmail = (input.userEmail ?? '').trim().toLowerCase();
    if (!userId && !userEmail) throw new Error('User identifier is required');

    let user = null;
    if (userId) {
        user = await collections.users.findOne(
            { id: userId },
            { projection: { _id: 1, email: 1, id: 1, role: 1 } }
        );
        if (!user && /^[0-9a-f]{24}$/i.test(userId)) {
            user = await collections.users.findOne(
                { _id: new ObjectId(userId) },
                { projection: { _id: 1, email: 1, id: 1, role: 1 } }
            );
        }
    }
    if (!user && userEmail) {
        user = await collections.users.findOne(
            { email: userEmail },
            { projection: { _id: 1, email: 1, id: 1, role: 1 } }
        );
    }

    if (!user) throw new Error('User not found');
    if (user.email === input.actorEmail) throw new Error('You cannot modify your own role');

    const currentRole =
        user.role === 'admin' ? 'admin' : user.role === 'operator' ? 'operator' : 'user';
    if (currentRole === input.role) return;

    if (currentRole === 'admin' && input.role !== 'admin') {
        const adminCount = await collections.users.countDocuments({ role: 'admin' });
        if (adminCount <= 1) {
            throw new Error('Cannot demote the last remaining admin');
        }
    }

    const headers = getRequest().headers;

    const betterAuthUserId =
        typeof user.id === 'string' && user.id.trim().length > 0 ? user.id.trim() : null;
    if (betterAuthUserId) {
        await auth.api.setRole({
            headers,
            body: { userId: betterAuthUserId, role: input.role }
        });
    } else {
        await collections.users.updateOne(
            { _id: user._id },
            { $set: { role: input.role, updatedAt: new Date() } }
        );
    }

    if (typeof user.email === 'string' && user.email.length > 0) {
        await adminRecomputeBusAuthContext({ email: user.email });
    }

    await logAuditSuccess({
        action: 'ADMIN_USER_ROLE_UPDATED',
        actorId: input.actorEmail,
        resourceType: 'user',
        resourceId: betterAuthUserId ?? String(user._id),
        changes: { role: input.role }
    });
}

export async function adminSetUserTrustedPublisher(input: {
    userId: string;
    trustedPublisher: boolean;
    actorEmail: string;
}) {
    const userId = input.userId.trim();
    if (!userId) throw new Error('User ID is required');

    let user = await collections.users.findOne(
        { id: userId },
        { projection: { _id: 1, email: 1, id: 1, trustedPublisher: 1 } }
    );
    if (!user && /^[0-9a-f]{24}$/i.test(userId)) {
        user = await collections.users.findOne(
            { _id: new ObjectId(userId) },
            { projection: { _id: 1, email: 1, id: 1, trustedPublisher: 1 } }
        );
    }

    if (!user) throw new Error('User not found');

    const current = user.trustedPublisher === true;
    if (current === input.trustedPublisher) return;

    const headers = getRequest().headers;
    const betterAuthUserId =
        typeof user.id === 'string' && user.id.trim().length > 0 ? user.id.trim() : null;

    if (betterAuthUserId) {
        await auth.api.adminUpdateUser({
            headers,
            body: {
                userId: betterAuthUserId,
                data: { trustedPublisher: input.trustedPublisher }
            }
        });
    } else {
        await collections.users.updateOne(
            { _id: user._id },
            {
                $set: {
                    trustedPublisher: input.trustedPublisher,
                    updatedAt: new Date()
                }
            }
        );
    }

    if (typeof user.email === 'string' && user.email.length > 0) {
        await adminRecomputeBusAuthContext({ email: user.email });
    }

    await logAuditSuccess({
        action: 'ADMIN_USER_TRUSTED_PUBLISHER_UPDATED',
        actorId: input.actorEmail,
        resourceType: 'user',
        resourceId: betterAuthUserId ?? String(user._id),
        changes: { trustedPublisher: input.trustedPublisher }
    });
}

export async function adminImpersonateUser(input: {
    userId: string;
    actorEmail: string;
    actorRole?: string;
}) {
    const userId = input.userId.trim();
    if (!userId) throw new Error('User ID is required');

    const targetUser = await resolveUserByBetterAuthId(userId);
    if (!targetUser) throw new Error('User not found');
    if (targetUser.email === input.actorEmail) throw new Error('You cannot impersonate yourself');

    const headers = getRequest().headers;
    const result = await auth.api.impersonateUser({
        headers,
        body: { userId },
        returnHeaders: true
    });
    forwardSetCookieHeaders(result);

    const impersonator = await collections.users.findOne(
        { email: input.actorEmail.toLowerCase() },
        { projection: { id: 1, email: 1, role: 1 } }
    );
    const actorId = `user:${input.actorEmail.toLowerCase()}`;

    await logAuditSuccess({
        action: 'ADMIN_USER_IMPERSONATION_STARTED',
        actorId,
        resourceType: 'user',
        resourceId: userId,
        authContext: {
            user: {
                email: input.actorEmail.toLowerCase(),
                role:
                    input.actorRole === 'admin'
                        ? 'admin'
                        : input.actorRole === 'operator'
                          ? 'operator'
                          : 'user'
            }
        },
        changes: {
            targetUserId: userId,
            targetUserEmail: typeof targetUser.email === 'string' ? targetUser.email : null,
            impersonatorUserId: typeof impersonator?.id === 'string' ? impersonator.id : null,
            impersonatorEmail: input.actorEmail.toLowerCase()
        }
    });
}

export async function adminStopImpersonation(input: {
    currentEmail: string;
    currentRole?: string;
}) {
    const headers = getRequest().headers;
    const sessionRaw = await auth.api.getSession({ headers });
    const authSession =
        sessionRaw &&
        typeof sessionRaw === 'object' &&
        'response' in (sessionRaw as Record<string, unknown>)
            ? ((sessionRaw as { response?: unknown }).response ?? null)
            : sessionRaw;
    const sessionRecord =
        authSession && typeof authSession === 'object'
            ? ((authSession as { session?: unknown }).session ?? null)
            : null;
    const impersonatedBy =
        sessionRecord && typeof sessionRecord === 'object'
            ? ((sessionRecord as { impersonatedBy?: unknown }).impersonatedBy ?? null)
            : null;

    if (typeof impersonatedBy !== 'string' || impersonatedBy.length === 0) {
        throw new Error('No active impersonation session');
    }

    const impersonator = await resolveUserByBetterAuthId(impersonatedBy);

    const stopResult = await auth.api.stopImpersonating({
        headers,
        returnHeaders: true
    });
    forwardSetCookieHeaders(stopResult);

    const restoredUser =
        stopResult &&
        typeof stopResult === 'object' &&
        'response' in (stopResult as Record<string, unknown>)
            ? (((stopResult as { response?: { user?: { email?: unknown } } }).response?.user
                  ?.email as string | undefined) ?? null)
            : null;

    await logAuditSuccess({
        action: 'ADMIN_USER_IMPERSONATION_ENDED',
        actorId:
            typeof impersonator?.email === 'string'
                ? `user:${impersonator.email.toLowerCase()}`
                : `user:${input.currentEmail.toLowerCase()}`,
        resourceType: 'user',
        resourceId: typeof impersonator?.id === 'string' ? impersonator.id : impersonatedBy,
        authContext: {
            user: {
                email: input.currentEmail.toLowerCase(),
                role:
                    input.currentRole === 'admin'
                        ? 'admin'
                        : input.currentRole === 'operator'
                          ? 'operator'
                          : 'user',
                impersonatedBy
            }
        },
        changes: {
            impersonatorUserId:
                typeof impersonator?.id === 'string' ? impersonator.id : impersonatedBy,
            impersonatorEmail: typeof impersonator?.email === 'string' ? impersonator.email : null,
            impersonatedUserEmail: input.currentEmail.toLowerCase(),
            restoredUserEmail: restoredUser
        }
    });
}

export async function adminListPublicAssets() {
    const assets = await dbCol.assets.findPublic(false, { sort: { createdAt: -1 } });
    return assets;
}

export async function adminDeletePublicAsset(assetId: string, userEmail: string) {
    const asset = await dbCol.assets.findById(assetId);
    if (!asset || !asset.public || asset.deletedAt) throw new Error('Public asset not found');

    await dbCol.assets.softDelete(assetId, userEmail);
    await logAuditSuccess({
        action: 'PUBLIC_ASSET_DELETED',
        actorId: userEmail,
        projectId: asset.projectId,
        resourceType: 'asset',
        resourceId: assetId
    });
}

type ConfigField = {
    key: string;
    label: string;
    encrypted: boolean;
    type: 'string' | 'number' | 'boolean' | 'secret';
    placeholder?: string;
};

export const ADMIN_CONFIG_FIELDS: ConfigField[] = [
    {
        key: 'smtp.host',
        label: 'SMTP Host',
        encrypted: false,
        type: 'string',
        placeholder: 'smtp.example.com'
    },
    { key: 'smtp.port', label: 'SMTP Port', encrypted: false, type: 'number', placeholder: '587' },
    { key: 'smtp.secure', label: 'SMTP Secure', encrypted: false, type: 'boolean' },
    { key: 'smtp.requireTLS', label: 'SMTP Require TLS', encrypted: false, type: 'boolean' },
    { key: 'smtp.ignoreTLS', label: 'SMTP Ignore TLS', encrypted: false, type: 'boolean' },
    {
        key: 'smtp.tlsRejectUnauthorized',
        label: 'SMTP TLS Reject Unauthorized',
        encrypted: false,
        type: 'boolean'
    },
    {
        key: 'smtp.tlsServername',
        label: 'SMTP TLS Server Name',
        encrypted: false,
        type: 'string',
        placeholder: 'smtp.example.com'
    },
    {
        key: 'smtp.connectionTimeoutMs',
        label: 'SMTP Connection Timeout (ms)',
        encrypted: false,
        type: 'number',
        placeholder: '10000'
    },
    { key: 'smtp.user', label: 'SMTP Username', encrypted: false, type: 'string' },
    { key: 'smtp.pass', label: 'SMTP Password', encrypted: true, type: 'secret' },
    {
        key: 'smtp.from',
        label: 'SMTP From Address',
        encrypted: false,
        type: 'string',
        placeholder: 'noreply@example.com'
    }
];

export async function adminListConfig() {
    const entries = await listConfigEntries();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));

    return ADMIN_CONFIG_FIELDS.map((field) => {
        const current = byKey.get(field.key);
        return {
            ...field,
            value: current?.value ?? null,
            isSet: current?.isSet ?? false,
            updatedAt: current?.updatedAt ?? null,
            updatedBy: current?.updatedBy ?? null,
            version: current?.version ?? 0
        };
    });
}

function normalizeConfigValue(field: ConfigField, value: string): unknown {
    if (field.type === 'number') {
        const num = Number(value);
        if (!Number.isFinite(num)) throw new Error(`${field.label} must be a valid number`);
        return num;
    }
    if (field.type === 'boolean') {
        return value === 'true';
    }
    return value;
}

export async function adminSetConfig(
    input: { key: string; value: string; updatedBy: string },
    auditContext?: AdminAuditContext
) {
    const field = ADMIN_CONFIG_FIELDS.find((f) => f.key === input.key);
    if (!field) throw new Error('Unsupported config key');

    if (field.encrypted && input.value.trim() === '') {
        throw new Error(`${field.label} cannot be empty`);
    }

    await setConfigValue({
        key: field.key,
        value: normalizeConfigValue(field, input.value),
        encrypted: field.encrypted,
        updatedBy: input.updatedBy
    });

    await logAuditSuccess({
        action: 'ADMIN_CONFIG_UPDATED',
        actorId: input.updatedBy,
        resourceType: 'config',
        resourceId: field.key,
        changes: {
            encrypted: field.encrypted,
            valueSet: true
        },
        ...withAdminAuditContext(auditContext)
    });
}

export async function adminSendSmtpTest(
    input: { to: string; actorEmail: string },
    auditContext?: AdminAuditContext
) {
    const smtp = await getSmtpConfig();
    if (!smtp) {
        throw new Error(
            'SMTP configuration is incomplete. Please configure all SMTP fields first.'
        );
    }

    const transporter = await createSmtpTransport(smtp);

    await transporter.sendMail({
        from: smtp.from,
        to: input.to,
        subject: 'Vizzy Studio SMTP test',
        html: '<p>This is a test email from Vizzy Studio admin configuration.</p>'
    });

    await logAuditSuccess({
        action: 'ADMIN_SMTP_TEST_SENT',
        actorId: input.actorEmail,
        resourceType: 'smtp',
        resourceId: input.to,
        changes: { to: input.to },
        ...withAdminAuditContext(auditContext)
    });

    return { ok: true };
}
