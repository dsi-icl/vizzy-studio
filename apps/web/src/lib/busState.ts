// Barrel — re-exports every public symbol from the busState modules.
// All existing import sites continue to resolve from '~/lib/busState' unchanged.

export type { ScopeId, PeerMeta, PeerEntry } from './busState.state';
export {
    // Maps & indices
    scopedState,
    peers,
    editorsByScope,
    wallsByWallId,
    wallsByIntendedWallSlug,
    controllersByWallId,
    galleriesByWallId,
    allGalleries,
    allEditors,
    wallBindings,
    wallBindingSources,
    signageBlankWalls,
    scopeWatchers,
    wallPeersByScope,
    controllerTransientByWallId,
    activeVideos,
    lastPingSeen,
    peerCounts,
    // Constants
    OP,
    EMPTY_HYDRATE,
    // Scope interning
    internScope,
    scopeLabel,
    // Peer counts
    getWallNodeCount,
    getIntendedWallNodeCount,
    // Telemetry
    markIncomingJson,
    markIncomingBinary,
    getBusRuntimeTelemetry,
    // Controller transient layers
    upsertControllerTransientLayer,
    deleteControllerTransientLayer,
    deleteControllerTransientLayerForScope,
    clearControllerTransientForWall,
    clearControllerTransientForScope,
    // Active video registry
    registerActiveVideo,
    unregisterActiveVideo,
    clearActiveVideosForScope,
    // Hydrate cache
    invalidateHydrateCache,
    // Backpressure
    canSendNonCritical
} from './busState.state';

export {
    scheduleScopeCleanup,
    cancelScopeCleanup,
    touchPing,
    reapStalePeers,
    logPeerCounts,
    seedScopeFromDb,
    buildSlidesSnapshot,
    saveScope,
    persistScopeNow,
    persistSlideMetadata,
    runCommitPersistenceTask
} from './busState.persistence';

export {
    bindWall,
    unbindWall,
    setSignageWallBlank,
    scheduleWallUnbindGrace,
    cancelWallUnbindGrace
} from './busState.binding';

export {
    getOrCreateScope,
    deleteYDocForLayer,
    getEditorHydratePayload,
    getWallHydratePayload,
    resolveScopeId,
    setEditorScope
} from './busState.scopes';

export { registerPeer, unregisterPeer } from './busState.peers';

export {
    estimatePlaybackLeadMs,
    sendJSON,
    broadcastToEditorsRaw,
    broadcastToEditors,
    broadcastToWallsRaw,
    broadcastToWallNodesRaw,
    broadcastToControllersByWallRaw,
    broadcastToControllersByScopeRaw,
    broadcastToWalls,
    broadcastToWallsBinary,
    broadcastToScopeRaw,
    broadcastToScope,
    broadcastToEditorsByCommit,
    notifyControllersByCommit,
    hydrateWallNodes,
    updateProjectCustomRenderSettings,
    updateRuntimeStageLayout,
    notifyControllers
} from './busState.broadcast';

export {
    sendVideoSyncToRelevantWalls,
    broadcastVideoSyncBatchToWalls,
    encodeVideoSyncBinary
} from './busState.video';

export { broadcastAssetToEditorsByProject } from './busState.assets';
