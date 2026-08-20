import { $getCommit, $getProject } from '../server/projects.fns';
import { EditorEngine } from './editorEngine';
import type { EditorState, SliceHelpers } from './editorStore.types';
import type { LayerWithEditorState, Slide } from './types';

type SliceSet = (
    partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)
) => void;
type SliceGet = () => EditorState;

export function createProjectSlice(_set: SliceSet, get: SliceGet, _helpers: SliceHelpers) {
    const set: SliceSet = _set;
    return {
        loadProject: async (projectId: string, commitId: string, slideId: string) => {
            set({
                loading: true,
                projectId,
                commitId,
                stageId: null,
                layers: new Map(),
                hoveredLayerId: null,
                slides: [],
                activeSlideId: null,
                saveStatus: 'idle',
                headCommitId: null
            });

            const [project, commit] = await Promise.all([
                $getProject({ data: { id: projectId } }),
                $getCommit({ data: { id: commitId } })
            ]);
            if (!project) throw new Error('Project not found');
            if (!commit || commit.projectId !== projectId) {
                throw new Error('Commit does not belong to this project');
            }
            const stage = project.stages.find(({ id }) => id === commit.stageId);
            if (!stage) throw new Error('Commit stage not found');
            if (stage.archivedAt) throw new Error('Archived stages cannot be edited');
            set({
                projectName: project.name,
                stageId: stage.id,
                stageLayout: stage.layout,
                headCommitId: stage.headCommitId
            });

            const engine = EditorEngine.getInstance();
            engine.clearBufferedHydration();
            engine.joinScope(projectId, commitId, slideId);
            const hydrate = await engine.waitForHydrate();

            if (commit?.content?.slides) {
                const commitSlides = commit.content.slides as Array<{
                    id: string;
                    order: number;
                    name?: string;
                    layers: LayerWithEditorState[];
                }>;
                const slides: Slide[] = commitSlides.map((s, i) => ({
                    id: s.id,
                    order: s.order ?? i,
                    name: s.name || `Slide ${(s.order ?? i) + 1}`
                }));
                set({ slides });
            }
            if (commit.parentId) {
                const lastSavedCommit = await $getCommit({ data: { id: commit.parentId } });
                if (lastSavedCommit) {
                    set({ parentSaveMessage: lastSavedCommit.message });
                }
            }

            if (hydrate.layers.length > 0) {
                get().hydrate(hydrate.layers as LayerWithEditorState[]);
                set({ activeSlideId: slideId });
            } else {
                const commitSlides = commit?.content?.slides as unknown as
                    | Array<{ id: string; order: number; layers: LayerWithEditorState[] }>
                    | undefined;
                const activeSlide = commitSlides?.find((s) => s.id === slideId);
                if (activeSlide) {
                    get().hydrate(activeSlide.layers as LayerWithEditorState[]);
                    set({ activeSlideId: slideId });
                    engine.sendJSON({
                        type: 'seed_scope',
                        layers: activeSlide.layers as LayerWithEditorState[]
                    });
                }
            }
            set({ loading: false });
        },

        switchSlide: async (slideId: string) => {
            const { projectId, commitId, activeSlideId } = get();
            if (!projectId || !commitId || slideId === activeSlideId) return;

            const engine = EditorEngine.getInstance();
            set({
                loading: true,
                layers: new Map(),
                hoveredLayerId: null,
                activeSlideId: slideId
            });

            engine.clearBufferedHydration();
            engine.joinScope(projectId, commitId, slideId);
            const hydrate = await engine.waitForHydrate();

            if (hydrate.layers.length > 0) {
                get().hydrate(hydrate.layers as LayerWithEditorState[]);
            } else {
                const commit = await $getCommit({ data: { id: commitId } });
                const commitSlides = commit?.content?.slides as unknown as
                    | Array<{ id: string; order: number; layers: LayerWithEditorState[] }>
                    | undefined;
                const activeSlide = commitSlides?.find((s) => s.id === slideId);
                if (activeSlide) {
                    get().hydrate(activeSlide.layers as LayerWithEditorState[]);
                    engine.sendJSON({
                        type: 'seed_scope',
                        layers: activeSlide.layers as LayerWithEditorState[]
                    });
                }
            }
            set({ loading: false });
        }
    };
}
