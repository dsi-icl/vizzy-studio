import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup
} from '@repo/ui/components/resizable';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { AssetLibraryPanel } from '~/components/AssetLibraryPanel';
import { LayerList } from '~/components/LayerList';
import { MainBoard } from '~/components/MainBoard';
import { ParametersPanel } from '~/components/ParametersPanel';
import { SlideList } from '~/components/SlideList';
import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import { projectQueryOptions } from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/editor/$projectId/$commitId/$slideId')({
    loader: async ({ context, params }) => {
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    head: ({ loaderData }) => ({
        meta: [{ title: `Editor · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    }),
    component: SlideEditor
});

function SlideEditor() {
    const { projectId, commitId, slideId } = useParams({
        from: '/_auth/quarry/editor/$projectId/$commitId/$slideId'
    });
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));

    if (project.customRenderUrl) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <h2 className="text-xl font-semibold">Vizzy Studio Editor Unavailable</h2>
                <p className="max-w-md text-muted-foreground">
                    This project uses a custom render URL and cannot be edited with the built-in
                    editor.
                </p>
                <Link
                    to="/quarry/projects/$projectId"
                    params={{ projectId }}
                    className="text-sm text-primary underline underline-offset-4"
                >
                    Back to project settings
                </Link>
            </div>
        );
    }

    return <SlideEditorInner projectId={projectId} commitId={commitId} slideId={slideId} />;
}

function SlideEditorInner({
    projectId,
    commitId,
    slideId
}: {
    projectId: string;
    commitId: string;
    slideId: string;
}) {
    const loadProject = useEditorStore((s) => s.loadProject);

    const [hasInitialisedSlides, setHasInitialisedSlides] = useState(false);
    const [hasInitialisedParams, setHasInitialisedParams] = useState(false);
    const slidePanelRef = usePanelRef();
    const layerPanelRef = usePanelRef();
    const paramsPanelRef = usePanelRef();
    const mediaPanelRef = usePanelRef();
    const [slidesCollapsed, setSlidesCollapsed] = useState(true);
    const [layersCollapsed, setLayersCollapsed] = useState(false);
    const [paramsCollapsed, setParamsCollapsed] = useState(true);
    const [mediaCollapsed, setMediaCollapsed] = useState(false);
    const titleBarSize = 42;

    // Load project from commit DAG on mount (slideId only used for initial load)
    useEffect(() => {
        loadProject(projectId, commitId, slideId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, commitId, loadProject]);

    // Leave the live scope when navigating away from the editor
    useEffect(() => {
        return () => {
            EditorEngine.getInstance().leaveScope();
        };
    }, []);

    // Ctrl+S keyboard shortcut for manual save
    const handleKeyboardSave = useCallback((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            const { saveStatus, saveProject: save } = useEditorStore.getState();
            if (saveStatus === 'dirty') {
                save('Manual save');
            }
        }
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyboardSave);
        return () => window.removeEventListener('keydown', handleKeyboardSave);
    }, [handleKeyboardSave]);

    useEffect(() => {
        if (hasInitialisedSlides) return;
        if (slidesCollapsed && slidePanelRef.current) {
            slidePanelRef.current.collapse();
            setHasInitialisedSlides(true);
        }
    }, [hasInitialisedSlides, slidesCollapsed, slidePanelRef]);

    useEffect(() => {
        if (hasInitialisedParams) return;
        if (paramsCollapsed && paramsPanelRef.current) {
            paramsPanelRef.current.collapse();
            setHasInitialisedParams(true);
        }
    }, [hasInitialisedParams, paramsCollapsed, paramsPanelRef]);

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className="h-full min-h-0 w-full overflow-hidden font-sans text-foreground"
        >
            <ResizablePanel className="min-h-0 overflow-hidden">
                <MainBoard />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={300} minSize={200} className="min-h-0 overflow-hidden">
                <ResizablePanelGroup
                    orientation="vertical"
                    className="h-full min-h-0 overflow-hidden border-t border-border bg-card/50"
                >
                    <ResizablePanel
                        collapsible
                        collapsedSize={titleBarSize}
                        minSize={titleBarSize}
                        panelRef={slidePanelRef}
                        onResize={({ inPixels }) => setSlidesCollapsed(inPixels <= titleBarSize)}
                    >
                        <SlideList
                            titleBarSize={titleBarSize}
                            collapsed={slidesCollapsed}
                            onCollapse={() => slidePanelRef.current?.collapse()}
                            onExpand={() => slidePanelRef.current?.expand()}
                        />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        collapsible
                        collapsedSize={titleBarSize}
                        minSize={titleBarSize}
                        panelRef={layerPanelRef}
                        onResize={({ inPixels }) => setLayersCollapsed(inPixels <= titleBarSize)}
                    >
                        <LayerList
                            titleBarSize={titleBarSize}
                            collapsed={layersCollapsed}
                            onCollapse={() => layerPanelRef.current?.collapse()}
                            onExpand={() => layerPanelRef.current?.expand()}
                        />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        collapsible
                        collapsedSize={titleBarSize}
                        minSize={titleBarSize}
                        panelRef={paramsPanelRef}
                        onResize={({ inPixels }) => setParamsCollapsed(inPixels <= titleBarSize)}
                    >
                        <ParametersPanel
                            titleBarSize={titleBarSize}
                            collapsed={paramsCollapsed}
                            onCollapse={() => paramsPanelRef.current?.collapse()}
                            onExpand={() => paramsPanelRef.current?.expand()}
                        />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        collapsible
                        collapsedSize={titleBarSize}
                        minSize={titleBarSize}
                        panelRef={mediaPanelRef}
                        onResize={({ inPixels }) => setMediaCollapsed(inPixels <= titleBarSize)}
                    >
                        <AssetLibraryPanel
                            projectId={projectId}
                            titleBarSize={titleBarSize}
                            collapsed={mediaCollapsed}
                            onCollapse={() => mediaPanelRef.current?.collapse()}
                            onExpand={() => mediaPanelRef.current?.expand()}
                        />
                    </ResizablePanel>
                </ResizablePanelGroup>
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
