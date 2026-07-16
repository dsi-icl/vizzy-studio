import type {
    AuthContext,
    AuditExecutionContext,
    AuditResourceType,
    JsonValue
} from '@repo/db/documents';

import { dbCol } from '~/server/collections';
import { getClientIpFromHeaders } from '~/server/rateLimit';

export type AuditOutcome = 'success' | 'denied' | 'failure' | 'error';

export interface AuditExecutionContextInput {
    surface?: AuditExecutionContext['surface'];
    operation?: string | null;
    method?: string | null;
    path?: string | null;
    requestId?: string | null;
    peerId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    details?: { [key: string]: JsonValue } | null;
    request?: Request | null;
}

export interface AuditLogInput {
    action: string;
    actorId?: string | null;
    projectId?: string | null;
    resourceType?: AuditResourceType | null;
    resourceId?: string | null;
    outcome?: AuditOutcome;
    reasonCode?: string | null;
    changes?: { [key: string]: JsonValue } | null;
    error?: string | null;
    statusMessage?: string | null;
    authContext?: AuthContext | null;
    executionContext?: AuditExecutionContextInput | null;
}

export interface NormalizedAuditContext {
    actorId: string | null;
    authContext: AuthContext | null;
    executionContext: AuditExecutionContext | null;
}

function cleanString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAuthContext(input?: AuthContext | null): AuthContext | null {
    if (!input) return null;

    const userEmail = cleanString(input.user?.email);
    const userRole =
        input.user?.role === 'admin' ||
        input.user?.role === 'operator' ||
        input.user?.role === 'user'
            ? input.user.role
            : null;
    const userTrustedPublisher = Boolean(input.user?.trustedPublisher);
    const impersonatedBy = cleanString(input.user?.impersonatedBy);

    const deviceId = cleanString(input.device?.id);
    const deviceKind =
        input.device?.kind === 'wall' ||
        input.device?.kind === 'controller' ||
        input.device?.kind === 'gallery'
            ? input.device.kind
            : null;
    const deviceWallId = cleanString(input.device?.wallId);

    const portalWallId = cleanString(input.portal?.wallId);
    const guest = Boolean(input.guest);

    const normalized: AuthContext = {
        ...(guest ? { guest: true } : {}),
        ...(userEmail && userRole
            ? {
                  user: {
                      email: userEmail,
                      role: userRole,
                      ...(userTrustedPublisher ? { trustedPublisher: true } : {}),
                      ...(impersonatedBy ? { impersonatedBy } : {})
                  }
              }
            : {}),
        ...(deviceId && deviceKind
            ? {
                  device: {
                      id: deviceId,
                      kind: deviceKind,
                      ...(deviceWallId ? { wallId: deviceWallId } : {})
                  }
              }
            : {}),
        ...(portalWallId ? { portal: { wallId: portalWallId } } : {})
    };

    if (!normalized.guest && !normalized.user && !normalized.device && !normalized.portal) {
        return null;
    }
    return normalized;
}

function deriveActorId(authContext: AuthContext | null): string | null {
    if (!authContext) return null;
    if (authContext.user?.email) return `user:${authContext.user.email.toLowerCase()}`;
    if (authContext.device?.id) return `device:${authContext.device.id}`;
    if (authContext.portal?.wallId) return `portal:${authContext.portal.wallId}`;
    if (authContext.guest) return 'guest';
    return null;
}

function derivePathFromRequest(request: Request): string | null {
    try {
        return new URL(request.url).pathname;
    } catch {
        return null;
    }
}

function deriveRequestId(request: Request): string | null {
    return (
        cleanString(request.headers.get('x-request-id')) ??
        cleanString(request.headers.get('x-correlation-id')) ??
        cleanString(request.headers.get('x-amzn-trace-id'))
    );
}

function normalizeExecutionContext(
    input?: AuditExecutionContextInput | null
): AuditExecutionContext | null {
    if (!input) return null;

    const request = input.request ?? null;
    const surface = input.surface ?? (request ? 'http' : null);
    const method = cleanString(input.method) ?? (request ? cleanString(request.method) : null);
    const path = cleanString(input.path) ?? (request ? derivePathFromRequest(request) : null);
    const requestId = cleanString(input.requestId) ?? (request ? deriveRequestId(request) : null);
    const ip = cleanString(input.ip) ?? (request ? getClientIpFromHeaders(request.headers) : null);
    const userAgent =
        cleanString(input.userAgent) ??
        (request ? cleanString(request.headers.get('user-agent')) : null);
    const operation = cleanString(input.operation);
    const peerId = cleanString(input.peerId);
    const details = input.details ?? null;

    const normalized: AuditExecutionContext = {
        ...(surface ? { surface } : {}),
        ...(operation ? { operation } : {}),
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        ...(requestId ? { requestId } : {}),
        ...(peerId ? { peerId } : {}),
        ...(ip ? { ip } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(details ? { details } : {})
    };

    if (
        !normalized.surface &&
        !normalized.operation &&
        !normalized.method &&
        !normalized.path &&
        !normalized.requestId &&
        !normalized.peerId &&
        !normalized.ip &&
        !normalized.userAgent &&
        !normalized.details
    ) {
        return null;
    }
    return normalized;
}

export function buildAuditContext(input: {
    actorId?: string | null;
    authContext?: AuthContext | null;
    executionContext?: AuditExecutionContextInput | null;
}): NormalizedAuditContext {
    const authContext = normalizeAuthContext(input.authContext ?? null);
    const derivedActorId = deriveActorId(authContext);
    const actorId = cleanString(input.actorId) ?? derivedActorId ?? null;
    const executionContext = normalizeExecutionContext(input.executionContext ?? null);

    return { actorId, authContext, executionContext };
}

export async function logAudit(input: AuditLogInput): Promise<void> {
    try {
        const statusMessage = cleanString(input.statusMessage);
        const executionContextWithStatusMessage: AuditExecutionContextInput | null | undefined =
            statusMessage
                ? {
                      ...(input.executionContext ?? {}),
                      details: {
                          ...((input.executionContext?.details ?? {}) as {
                              [key: string]: JsonValue;
                          }),
                          statusMessage
                      }
                  }
                : input.executionContext;

        const normalized = buildAuditContext({
            actorId: input.actorId ?? null,
            authContext: input.authContext ?? null,
            executionContext: executionContextWithStatusMessage ?? null
        });
        await dbCol.audits.insertLog({
            projectId: input.projectId ?? null,
            actorId: normalized.actorId,
            action: input.action,
            outcome: input.outcome ?? 'success',
            resourceType: input.resourceType ?? null,
            resourceId: input.resourceId ?? null,
            reasonCode: input.reasonCode ?? null,
            changes: input.changes ?? null,
            error: input.error ?? null,
            authContext: normalized.authContext,
            executionContext: normalized.executionContext
        });
    } catch (error) {
        // Audit logging must not break business flows.
        console.error('[Audit] Failed to write audit log:', error);
    }
}

export async function logAuditSuccess(input: Omit<AuditLogInput, 'outcome'>): Promise<void> {
    await logAudit({ ...input, outcome: 'success' });
}

export async function logAuditDenied(input: Omit<AuditLogInput, 'outcome'>): Promise<void> {
    await logAudit({ ...input, outcome: 'denied' });
}

export async function logAuditFailure(input: Omit<AuditLogInput, 'outcome'>): Promise<void> {
    await logAudit({ ...input, outcome: 'failure' });
}

export async function logAuditError(input: Omit<AuditLogInput, 'outcome'>): Promise<void> {
    await logAudit({ ...input, outcome: 'error' });
}
