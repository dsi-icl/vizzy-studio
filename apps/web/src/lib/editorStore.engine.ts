import type { StoreApi } from 'zustand';

import { projectAssetsQueryOptions } from '../server/projects.queries';
import { EditorEngine } from './editorEngine';
import type { EditorState } from './editorStore.types';
import { getBrowserQueryClient } from './queryClient';

/**
 * Wire the EditorEngine WebSocket events into the Zustand store.
 * Returns a cleanup function (call on HMR dispose).
 */
export function wireEngineSubscriptions(store: StoreApi<EditorState>): () => void {
    const engine = EditorEngine.getInstance();

    const unsubJson = engine.subscribeToJson((data) => {
        const s = store.getState();
        if (data.type === 'hydrate') {
            s.hydrate(data.layers);
        } else if (data.type === 'upsert_layer') {
            s.upsertLayer(data.layer);
        } else if (data.type === 'delete_layer') {
            store.setState((st) => {
                const newLayers = new Map(st.layers);
                newLayers.delete(data.numericId);
                return {
                    layers: newLayers,
                    selectedLayerIds: st.selectedLayerIds.filter(
                        (id) => id !== data.numericId.toString()
                    )
                };
            });
        } else if (data.type === 'processing_progress') {
            s.updateProgress(data.numericId, data.progress);
        } else if (data.type === 'slides_updated') {
            if (data.commitId === s.commitId) {
                s.setSlides(
                    data.slides.map((sl: { id: string; order: number; name: string }) => ({
                        id: sl.id,
                        order: sl.order,
                        name: sl.name
                    }))
                );
            }
        } else if (data.type === 'asset_added') {
            if (data.projectId === s.projectId) {
                const queryClient = getBrowserQueryClient();
                queryClient.invalidateQueries({
                    queryKey: projectAssetsQueryOptions(data.projectId).queryKey
                });
            }
        } else if (data.type === 'wall_node_count') {
            store.setState((st) => {
                const next: Partial<EditorState> = {
                    wallNodeCounts: { ...st.wallNodeCounts, [data.wallId]: data.connectedNodes }
                };
                if (st.boundWallId === data.wallId && data.connectedNodes <= 0) {
                    next.boundWallId = null;
                    engine.boundWallId = null;
                }
                return next;
            });
        } else if (data.type === 'wall_binding_status') {
            const state = store.getState();
            const currentlyBound = state.boundWallId;
            const matchesCurrentScope =
                data.bound &&
                data.projectId === state.projectId &&
                data.commitId === state.commitId &&
                data.slideId === state.activeSlideId;

            if (matchesCurrentScope) {
                store.setState({ boundWallId: data.wallId });
                engine.boundWallId = data.wallId;
            } else if (currentlyBound === data.wallId) {
                store.setState({ boundWallId: null });
                engine.boundWallId = null;
            }
        }
    });

    const unsubStatus = engine.onConnectionStatusChange((status) => {
        store.setState({ connectionStatus: status });
    });

    const unsubSave = engine.subscribeToSaveResponse((data) => {
        const s = store.getState();
        if (data.success) {
            store.setState({
                saveStatus: 'saved',
                headCommitId: data.commitId ?? s.headCommitId
            });
            setTimeout(() => {
                if (store.getState().saveStatus === 'saved') {
                    store.setState({ saveStatus: 'idle' });
                }
            }, 2000);
        } else {
            console.error('Save failed:', data.error);
            store.setState({ saveStatus: 'error' });
            setTimeout(() => {
                if (store.getState().saveStatus === 'error') {
                    store.setState({ saveStatus: 'dirty' });
                }
            }, 3000);
        }
    });

    return () => {
        unsubJson();
        unsubStatus();
        unsubSave();
    };
}
