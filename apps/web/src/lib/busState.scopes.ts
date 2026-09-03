import { DEFAULT_STAGE_LAYOUT, type StageLayout } from '@repo/db/schema';

import { dbCol } from '~/server/collections';

import { cancelScopeCleanup, scheduleScopeCleanup } from './busState.persistence';
import {
    addToIndex,
    commitToScopeIds,
    controllerTransientByWallId,
    EMPTY_HYDRATE,
    editorsByScope,
    invalidateHydrateCache,
    removeFromIndex,
    scopedState,
    wallBindingSources,
    wallBindings,
    type PeerEntry,
    type ScopeId
} from './busState.state';

export function getOrCreateScope(
    scopeId: ScopeId,
    projectId: string,
    commitId: string,
    slideId: string,
    customRenderUrl?: string,
    customRenderCompat?: boolean,
    customRenderProxy?: boolean,
    layout?: StageLayout,
    stageId?: string
) {
    let scope = scopedState.get(scopeId);
    if (!scope) {
        scope = {
            layers: new Map(),
            projectId,
            commitId,
            slideId,
            stageId,
            layout: layout ?? { ...DEFAULT_STAGE_LAYOUT },
            dirty: false,
            hydrateCache: null,
            customRenderUrl,
            customRenderCompat: customRenderCompat ?? false,
            customRenderProxy: customRenderProxy ?? false
        };
        scopedState.set(scopeId, scope);

        let scopeIds = commitToScopeIds.get(commitId);
        if (!scopeIds) {
            scopeIds = new Set();
            commitToScopeIds.set(commitId, scopeIds);
        }
        scopeIds.add(scopeId);
    } else {
        let changed = false;
        if (stageId !== undefined && scope.stageId !== stageId) {
            scope.stageId = stageId;
            changed = true;
        }
        if (layout && JSON.stringify(scope.layout) !== JSON.stringify(layout)) {
            scope.layout = layout;
            changed = true;
        }
        if (customRenderUrl !== undefined && scope.customRenderUrl !== customRenderUrl) {
            scope.customRenderUrl = customRenderUrl;
            changed = true;
        }
        if (customRenderCompat !== undefined && scope.customRenderCompat !== customRenderCompat) {
            scope.customRenderCompat = customRenderCompat;
            changed = true;
        }
        if (customRenderProxy !== undefined && scope.customRenderProxy !== customRenderProxy) {
            scope.customRenderProxy = customRenderProxy;
            changed = true;
        }
        if (changed) scope.hydrateCache = null;
    }
    return scope;
}

export function deleteYDocForLayer(scopeId: ScopeId, numericId: number) {
    const scope = scopedState.get(scopeId);
    if (!scope) return;

    const ydocScope = `${scope.projectId}_${scope.commitId}_${scope.slideId}_${numericId}`;
    void dbCol.ydocs.deleteByScope(ydocScope).catch((err: unknown) => {
        console.error(`[Bus] Failed to delete ydoc for ${ydocScope}:`, err);
    });
}

export function getEditorHydratePayload(scopeId: ScopeId): string {
    const scope = scopedState.get(scopeId);
    if (!scope) return EMPTY_HYDRATE;
    if (!scope.hydrateCache) {
        scope.hydrateCache = JSON.stringify({
            type: 'hydrate',
            layers: Array.from(scope.layers.values()),
            layout: scope.layout,
            ...(scope.customRenderUrl
                ? {
                      customRender: {
                          url: scope.customRenderUrl,
                          compat: Boolean(scope.customRenderCompat),
                          proxy: Boolean(scope.customRenderProxy)
                      }
                  }
                : {})
        });
    }
    return scope.hydrateCache;
}

export function getWallHydratePayload(scopeId: ScopeId, wallId: string): string {
    const scope = scopedState.get(scopeId);
    if (!scope) return EMPTY_HYDRATE;
    const boundSource = wallBindingSources.get(wallId);

    const controllerTransient = controllerTransientByWallId.get(wallId);
    if (!controllerTransient || controllerTransient.size === 0) {
        return JSON.stringify({
            type: 'hydrate',
            layers: Array.from(scope.layers.values()),
            projectId: scope.projectId,
            commitId: scope.commitId,
            slideId: scope.slideId,
            layout: scope.layout,
            ...(scope.customRenderUrl
                ? {
                      customRender: {
                          url: scope.customRenderUrl,
                          compat: Boolean(scope.customRenderCompat),
                          proxy: Boolean(scope.customRenderProxy)
                      }
                  }
                : {}),
            ...(boundSource ? { boundSource } : {})
        });
    }

    const mergedByNumericId = new Map();
    for (const layer of scope.layers.values()) {
        mergedByNumericId.set(layer.numericId, layer);
    }
    for (const layer of controllerTransient.values()) {
        mergedByNumericId.set(layer.numericId, layer);
    }

    return JSON.stringify({
        type: 'hydrate',
        layers: Array.from(mergedByNumericId.values()),
        projectId: scope.projectId,
        commitId: scope.commitId,
        slideId: scope.slideId,
        layout: scope.layout,
        ...(scope.customRenderUrl
            ? {
                  customRender: {
                      url: scope.customRenderUrl,
                      compat: Boolean(scope.customRenderCompat),
                      proxy: Boolean(scope.customRenderProxy)
                  }
              }
            : {}),
        ...(boundSource ? { boundSource } : {})
    });
}

// Resolve the ScopeId for a peer (editors directly, walls/controllers via binding)
export function resolveScopeId(meta: {
    specimen: string;
    scope?: { scopeId: ScopeId };
    wallId?: string;
}): ScopeId | null {
    switch (meta.specimen) {
        case 'editor':
            return meta.scope?.scopeId ?? null;
        case 'wall':
        case 'controller':
            return wallBindings.get(meta.wallId!) ?? null;
        default:
            return null;
    }
}

export function setEditorScope(
    entry: PeerEntry,
    scope: {
        projectId: string;
        commitId: string;
        slideId: string;
        scopeId: ScopeId;
    } | null
) {
    if (entry.meta.specimen !== 'editor') return;

    const previousScopeId = entry.meta.scope?.scopeId;
    if (previousScopeId !== undefined) {
        removeFromIndex(editorsByScope, previousScopeId, entry);
        scheduleScopeCleanup(previousScopeId);
    }

    if (!scope) {
        entry.meta = {
            specimen: 'editor',
            ...(entry.meta.authContext ? { authContext: entry.meta.authContext } : {})
        };
        return;
    }

    entry.meta = {
        specimen: 'editor',
        scope,
        ...(entry.meta.authContext ? { authContext: entry.meta.authContext } : {})
    };
    addToIndex(editorsByScope, scope.scopeId, entry);
    cancelScopeCleanup(scope.scopeId);
}
