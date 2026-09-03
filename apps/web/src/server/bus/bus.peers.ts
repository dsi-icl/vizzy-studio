import type { Peer } from 'crossws';

import {
    EMPTY_HYDRATE,
    broadcastToControllersByWallRaw,
    editorsByScope,
    getEditorHydratePayload,
    getOrCreateScope,
    getWallHydratePayload,
    getWallNodeCount,
    hydrateWallNodes,
    internScope,
    logPeerCounts,
    notifyControllers,
    peers,
    registerPeer,
    scopeLabel,
    scopedState,
    signageBlankWalls,
    seedScopeFromDb,
    sendJSON,
    setEditorScope,
    unbindWall,
    wallBindings,
    wallBindingSources,
    wallsByWallId
} from '~/lib/busState';
import { releaseProjectContextIfUnused } from '~/lib/busState.projectContext';
import { makeScopeLabel, type GSMessage } from '~/lib/types';
import { logAuditDenied } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { ensureDeviceByPublicKey } from '~/server/devices';
import { canEditProject, canViewProject } from '~/server/projectAuthz';
import { resolveAuthContextFromRequest, type AuthContext } from '~/server/requestAuthContext';

import { editorProjectPermissions } from './bus.authz';
import {
    broadcastWallBindingToEditors,
    broadcastWallBindingToGalleries,
    broadcastWallNodeCountToEditors,
    sendGalleryStateSnapshot,
    sendSlidesSnapshotToControllerPeer
} from './bus.binding';
import type { DeviceHelloMessage } from './bus.crypto';

export async function registerEditorPeer(
    peer: Peer,
    scopeInput: {
        projectId: string;
        commitId: string;
        slideId: string;
    }
): Promise<boolean> {
    const { authContext } = await resolveAuthContextFromRequest(peer.request);
    const userActor = authContext.user
        ? { email: authContext.user.email, role: authContext.user.role }
        : null;
    if (!userActor) {
        await logAuditDenied({
            action: 'WS_SESSION_DENIED',
            reasonCode: 'MISSING_SESSION',
            projectId: scopeInput.projectId,
            resourceType: 'scope',
            resourceId: makeScopeLabel(
                scopeInput.projectId,
                scopeInput.commitId,
                scopeInput.slideId
            ),
            authContext,
            executionContext: {
                surface: 'ws',
                operation: 'registerEditorPeer',
                peerId: peer.id
            }
        });
        sendJSON(peer, { type: 'auth_denied', reason: 'missing_session' });
        try {
            peer.close();
        } catch {
            // no-op
        }
        return false;
    }

    const [canView, canEdit, project, commit] = await Promise.all([
        canViewProject(userActor, scopeInput.projectId),
        canEditProject(userActor, scopeInput.projectId),
        dbCol.projects.findById(scopeInput.projectId),
        dbCol.commits.findById(scopeInput.commitId)
    ]);
    if (!canView) {
        await logAuditDenied({
            action: 'WS_SESSION_DENIED',
            reasonCode: 'PROJECT_VIEW_FORBIDDEN',
            projectId: scopeInput.projectId,
            resourceType: 'scope',
            resourceId: makeScopeLabel(
                scopeInput.projectId,
                scopeInput.commitId,
                scopeInput.slideId
            ),
            authContext,
            executionContext: {
                surface: 'ws',
                operation: 'registerEditorPeer',
                peerId: peer.id
            }
        });
        sendJSON(peer, { type: 'auth_denied' });
        try {
            peer.close();
        } catch {
            // no-op
        }
        return false;
    }
    const stage =
        commit?.projectId === scopeInput.projectId
            ? project?.stages.find(({ id }) => id === commit.stageId)
            : null;
    if (!stage || stage.archivedAt) {
        await logAuditDenied({
            action: 'WS_SESSION_DENIED',
            reasonCode: 'INVALID_STAGE_SCOPE',
            projectId: scopeInput.projectId,
            resourceType: 'scope',
            resourceId: makeScopeLabel(
                scopeInput.projectId,
                scopeInput.commitId,
                scopeInput.slideId
            ),
            authContext,
            executionContext: {
                surface: 'ws',
                operation: 'registerEditorPeer',
                peerId: peer.id
            }
        });
        sendJSON(peer, { type: 'auth_denied' });
        peer.close();
        return false;
    }
    editorProjectPermissions.set(peer.id, {
        projectId: scopeInput.projectId,
        canView,
        canEdit
    });

    const scopeId = internScope(scopeInput.projectId, scopeInput.commitId, scopeInput.slideId);
    const scope = getOrCreateScope(
        scopeId,
        scopeInput.projectId,
        scopeInput.commitId,
        scopeInput.slideId,
        undefined,
        undefined,
        undefined,
        stage.layout,
        stage.id
    );

    const existing = peers.get(peer.id);
    if (existing?.meta.specimen === 'editor') {
        setEditorScope(existing, {
            projectId: scopeInput.projectId,
            commitId: scopeInput.commitId,
            slideId: scopeInput.slideId,
            scopeId
        });
    } else {
        registerPeer(peer, {
            specimen: 'editor',
            scope: {
                projectId: scopeInput.projectId,
                commitId: scopeInput.commitId,
                slideId: scopeInput.slideId,
                scopeId
            },
            authContext
        });
    }

    if (scope.layers.size === 0) {
        // Fresh scope — auto-seed from DB so the editor gets layers immediately
        seedScopeFromDb(scopeId).then(() => {
            peer.send(getEditorHydratePayload(scopeId));
            const allWallIds = new Set<string>(wallsByWallId.keys());
            for (const wallId of allWallIds) {
                const assignedConnectedNodes = getWallNodeCount(wallId);
                peer.send(
                    JSON.stringify({
                        type: 'wall_node_count',
                        wallId,
                        connectedNodes: assignedConnectedNodes
                    } satisfies GSMessage)
                );
                const boundScope = wallBindings.get(wallId);
                const bound = boundScope !== undefined;
                const s = bound ? scopedState.get(boundScope) : null;
                peer.send(
                    JSON.stringify({
                        type: 'wall_binding_status',
                        wallId,
                        bound,
                        ...(s
                            ? {
                                  projectId: s.projectId,
                                  commitId: s.commitId,
                                  slideId: s.slideId,
                                  customRenderUrl: s.customRenderUrl,
                                  boundSource: wallBindingSources.get(wallId)
                              }
                            : {})
                    } satisfies GSMessage)
                );
            }
        });
    } else {
        peer.send(getEditorHydratePayload(scopeId));
        const allWallIds = new Set<string>(wallsByWallId.keys());
        for (const wallId of allWallIds) {
            const assignedConnectedNodes = getWallNodeCount(wallId);
            peer.send(
                JSON.stringify({
                    type: 'wall_node_count',
                    wallId,
                    connectedNodes: assignedConnectedNodes
                } satisfies GSMessage)
            );
            const boundScope = wallBindings.get(wallId);
            const bound = boundScope !== undefined;
            const s = bound ? scopedState.get(boundScope) : null;
            peer.send(
                JSON.stringify({
                    type: 'wall_binding_status',
                    wallId,
                    bound,
                    ...(s
                        ? {
                              projectId: s.projectId,
                              commitId: s.commitId,
                              slideId: s.slideId,
                              customRenderUrl: s.customRenderUrl,
                              boundSource: wallBindingSources.get(wallId)
                          }
                        : {})
                } satisfies GSMessage)
            );
        }
    }
    return true;
}

export async function completeHelloRegistration(
    peer: Peer,
    parsed: DeviceHelloMessage,
    passedAuthContext: AuthContext
): Promise<{ pendingEnrollment: boolean; rejected?: boolean }> {
    if (parsed.specimen === 'wall') {
        const wallDevice = parsed.devicePublicKey
            ? await ensureDeviceByPublicKey({
                  publicKey: parsed.devicePublicKey,
                  kind: 'wall'
              })
            : null;
        if (wallDevice?.status === 'revoked') {
            sendJSON(peer, {
                type: 'auth_denied',
                reason: 'device_revoked'
            });
            try {
                peer.close();
            } catch {
                // no-op
            }
            return { pendingEnrollment: false, rejected: true };
        }
        if (wallDevice?.status === 'pending') {
            sendJSON(peer, {
                type: 'device_enrollment',
                id: wallDevice.id
            });
            return { pendingEnrollment: true };
        }
        if (wallDevice?.assignedWallId && wallDevice.assignedWallId !== parsed.wallId) {
            sendJSON(peer, {
                type: 'auth_denied',
                reason: 'wall_assignment_mismatch'
            });
            try {
                peer.close();
            } catch {
                // no-op
            }
            return { pendingEnrollment: false, rejected: true };
        }
        const effectiveWallId = wallDevice?.assignedWallId ?? parsed.wallId;
        const intendedWallSlug = parsed.wallId;
        const deviceAuthContext = wallDevice
            ? {
                  kind: 'wall' as const,
                  wallId: effectiveWallId,
                  id: wallDevice.id
              }
            : passedAuthContext.device
              ? {
                    kind: 'wall' as const,
                    wallId: effectiveWallId,
                    id: passedAuthContext.device.id
                }
              : undefined;
        const authContext: AuthContext = {
            ...(passedAuthContext.user ? { user: passedAuthContext.user } : {}),
            ...(deviceAuthContext ? { device: deviceAuthContext } : {})
        };

        registerPeer(peer, {
            specimen: 'wall',
            wallId: effectiveWallId,
            intendedWallSlug,
            col: parsed.col,
            row: parsed.row,
            authContext
        });

        const boundScope = wallBindings.get(effectiveWallId);

        peer.send(
            boundScope !== undefined && !signageBlankWalls.has(effectiveWallId)
                ? getWallHydratePayload(boundScope, effectiveWallId)
                : EMPTY_HYDRATE
        );

        broadcastWallNodeCountToEditors(effectiveWallId);
        broadcastWallBindingToEditors(effectiveWallId);
        broadcastWallBindingToGalleries(effectiveWallId);

        console.log(
            `[WS] Wall joined wallId=${effectiveWallId} ` +
                `(bound=${boundScope !== undefined ? scopeLabel(boundScope) : `none`})`
        );
        logPeerCounts();
        return { pendingEnrollment: false };
    }

    if (parsed.specimen === 'controller') {
        let controllerDevice: Awaited<ReturnType<typeof ensureDeviceByPublicKey>> | null = null;
        if (parsed.devicePublicKey) {
            controllerDevice = await ensureDeviceByPublicKey({
                publicKey: parsed.devicePublicKey,
                kind: 'controller'
            });
            if (controllerDevice.status === 'revoked') {
                sendJSON(peer, {
                    type: 'auth_denied',
                    reason: 'device_revoked'
                });
                try {
                    peer.close();
                } catch {
                    // no-op
                }
                return { pendingEnrollment: false, rejected: true };
            }
            if (controllerDevice.status === 'pending') {
                const hasPortalAccess = Boolean(passedAuthContext.portal?.wallId);
                const isAdminUser = passedAuthContext.user?.role === 'admin';
                if (!hasPortalAccess && !isAdminUser) {
                    sendJSON(peer, {
                        type: 'device_enrollment',
                        id: controllerDevice.id
                    });
                    return { pendingEnrollment: true };
                }
            }
        }

        const effectiveWallId = controllerDevice?.assignedWallId ?? parsed.wallId;
        const authContext: AuthContext = {
            ...(passedAuthContext.user ? { user: passedAuthContext.user } : {}),
            ...(controllerDevice
                ? {
                      device: {
                          kind: 'controller' as const,
                          wallId: effectiveWallId,
                          id: controllerDevice.id
                      }
                  }
                : passedAuthContext.device
                  ? {
                        device: {
                            kind: 'controller' as const,
                            wallId: effectiveWallId,
                            id: passedAuthContext.device.id
                        }
                    }
                  : {}),
            ...(passedAuthContext.portal ? { portal: passedAuthContext.portal } : {})
        };

        registerPeer(peer, {
            specimen: 'controller',
            wallId: effectiveWallId,
            authContext
        });

        const boundScope = wallBindings.get(effectiveWallId);
        const scope = boundScope !== undefined ? scopedState.get(boundScope) : null;
        sendJSON(peer, {
            type: 'wall_binding_status',
            wallId: effectiveWallId,
            bound: boundScope !== undefined,
            ...(scope
                ? {
                      projectId: scope.projectId,
                      commitId: scope.commitId,
                      slideId: scope.slideId,
                      customRenderUrl: scope.customRenderUrl,
                      boundSource: wallBindingSources.get(effectiveWallId)
                  }
                : {})
        } satisfies GSMessage);
        peer.send(
            boundScope !== undefined
                ? getWallHydratePayload(boundScope, effectiveWallId)
                : EMPTY_HYDRATE
        );
        if (scope?.commitId) {
            void sendSlidesSnapshotToControllerPeer(peer, scope.commitId);
        }

        console.log(`[WS] Controller joined wallId=${effectiveWallId}`);
        logPeerCounts();
        return { pendingEnrollment: false };
    }

    let galleryDevice: Awaited<ReturnType<typeof ensureDeviceByPublicKey>> | null = null;
    if (parsed.devicePublicKey) {
        galleryDevice = await ensureDeviceByPublicKey({
            publicKey: parsed.devicePublicKey,
            kind: 'gallery'
        });
        if (galleryDevice.status === 'pending') {
            sendJSON(peer, {
                type: 'device_enrollment',
                id: galleryDevice.id
            });
            if (!(passedAuthContext.user?.role === 'admin')) {
                return { pendingEnrollment: true };
            }
        }
    }

    // For enrolled gallery devices the server is the authoritative source of
    // the assigned wall — prefer the DB value over whatever ?w= the client sent
    const effectiveWallId = galleryDevice?.assignedWallId ?? parsed.wallId;

    const authContext: AuthContext = {
        ...(passedAuthContext.user ? { user: passedAuthContext.user } : {}),
        ...(galleryDevice
            ? {
                  device: {
                      kind: 'gallery' as const,
                      ...(effectiveWallId ? { wallId: effectiveWallId } : {}),
                      id: galleryDevice.id
                  }
              }
            : passedAuthContext.device
              ? {
                    device: {
                        kind: 'gallery' as const,
                        ...(effectiveWallId ? { wallId: effectiveWallId } : {}),
                        id: passedAuthContext.device.id
                    }
                }
              : {})
    };

    registerPeer(peer, {
        specimen: 'gallery',
        ...(effectiveWallId ? { wallId: effectiveWallId } : {}),
        authContext
    });
    const canReceiveWallLayout =
        Boolean(galleryDevice?.assignedWallId) ||
        passedAuthContext.user?.role === 'admin' ||
        passedAuthContext.user?.role === 'operator';
    void sendGalleryStateSnapshot(peer, effectiveWallId, canReceiveWallLayout);
    console.log(
        `[WS] Gallery joined${effectiveWallId ? ` wallId=${effectiveWallId}` : ` (global)`}`
    );
    logPeerCounts();
    return { pendingEnrollment: false };
}

export function handleEditorScopeVacated(scopeId: number) {
    const remainingEditors = editorsByScope.get(scopeId)?.size ?? 0;
    if (remainingEditors > 0) return;

    // Flush and drop the project's shared state once nobody is editing it. A
    // colour picked just before the last peer left would otherwise be lost.
    const projectId = scopedState.get(scopeId)?.projectId;
    if (projectId) {
        void releaseProjectContextIfUnused(projectId).catch((err) => {
            console.error(`[Bus] Failed to release project context for ${projectId}:`, err);
        });
    }

    for (const [wallId, boundScopeId] of wallBindings) {
        if (boundScopeId !== scopeId) continue;
        if (wallBindingSources.get(wallId) !== 'live') continue;

        if (process.__SIGNAGE_IS_TARGET_WALL__?.(wallId)) {
            process.__SIGNAGE_RESUME_WALL__?.(wallId);
            continue;
        }
        unbindWall(wallId);
        hydrateWallNodes(wallId);
        broadcastToControllersByWallRaw(
            wallId,
            JSON.stringify({ type: 'hydrate', layers: [] } satisfies GSMessage)
        );
        notifyControllers(wallId, false);
        void dbCol.walls.updateByWallId(wallId, {
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null
        });
        broadcastWallBindingToEditors(wallId);
        broadcastWallBindingToGalleries(wallId);
    }
}

export async function recomputePeerAuthContexts(
    input: { email?: string; projectId?: string } = {}
) {
    let inspected = 0;
    let refreshed = 0;
    let disconnected = 0;

    for (const entry of peers.values()) {
        if (entry.meta.specimen !== 'editor') continue;
        const currentEmail = entry.meta.authContext?.user?.email ?? null;
        const currentRole = entry.meta.authContext?.user?.role ?? null;
        const scopeProjectId = entry.meta.scope?.projectId ?? null;
        if (input.email && currentEmail !== input.email) continue;
        if (input.projectId && scopeProjectId !== input.projectId) continue;
        inspected += 1;

        const {
            authContext: { user }
        } = await resolveAuthContextFromRequest(entry.peer.request);
        if (!user) {
            editorProjectPermissions.delete(entry.peer.id);
            await logAuditDenied({
                action: 'WS_SESSION_DENIED',
                reasonCode: 'MISSING_SESSION_RECOMPUTE',
                projectId: scopeProjectId,
                resourceType: 'scope',
                resourceId: scopeProjectId ?? null,
                authContext: entry.meta.authContext,
                executionContext: {
                    surface: 'ws',
                    operation: 'recomputePeerAuthContexts',
                    peerId: entry.peer.id
                }
            });
            sendJSON(entry.peer, { type: 'auth_denied', reason: 'missing_session' });
            try {
                entry.peer.close();
            } catch {
                // no-op
            }
            disconnected += 1;
            continue;
        }
        if (scopeProjectId) {
            const actor = { email: user.email, role: user.role };
            const [canView, canEdit] = await Promise.all([
                canViewProject(actor, scopeProjectId),
                canEditProject(actor, scopeProjectId)
            ]);
            if (!canView) {
                editorProjectPermissions.delete(entry.peer.id);
                await logAuditDenied({
                    action: 'WS_SESSION_DENIED',
                    reasonCode: 'PROJECT_VIEW_FORBIDDEN_RECOMPUTE',
                    projectId: scopeProjectId,
                    resourceType: 'scope',
                    resourceId: scopeProjectId,
                    authContext: entry.meta.authContext,
                    executionContext: {
                        surface: 'ws',
                        operation: 'recomputePeerAuthContexts',
                        peerId: entry.peer.id
                    }
                });
                sendJSON(entry.peer, { type: 'auth_denied' });
                try {
                    entry.peer.close();
                } catch {
                    // no-op
                }
                disconnected += 1;
                continue;
            }
            editorProjectPermissions.set(entry.peer.id, {
                projectId: scopeProjectId,
                canView,
                canEdit
            });
        }
        if (user.email !== currentEmail || user.role !== currentRole) {
            entry.meta = {
                ...entry.meta,
                authContext: {
                    ...(entry.meta.authContext ?? {}),
                    user
                }
            };
            refreshed += 1;
        }
    }

    return { inspected, refreshed, disconnected };
}
