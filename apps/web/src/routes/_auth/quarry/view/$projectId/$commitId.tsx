import {
    ArrowLeftIcon,
    CircleNotchIcon,
    GitBranchIcon,
    SlideshowIcon
} from '@phosphor-icons/react';
import { authSessionQueryOptions } from '@repo/auth/tanstack/queries';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup
} from '@repo/ui/components/resizable';
import { Separator } from '@repo/ui/components/separator';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer as KonvaLayer, Rect, Circle, Line } from 'react-konva';
import { toast } from 'sonner';

import { KonvaBackgroundLayer } from '~/components/KonvaBackgroundLayer';
import { ReadOnlyMediaLayer, ReadOnlyTextLayer } from '~/components/ReadOnlyLayers';
import { ViewerSlatePreview } from '~/components/ViewerSlatePreview';
import { getDOGridLines } from '~/lib/editorHelpers';
import type { LayerWithEditorState } from '~/lib/types';
import { $createBranchHead } from '~/server/projects.fns';
import { commitQueryOptions, projectQueryOptions } from '~/server/projects.queries';

const DEFAULT_STAGE_SCALE_FACTOR = 0.15;
const SCREEN_W = 1920;
const SCREEN_H = 1080;
const COLS = 16;
const ROWS = 4;

export const Route = createFileRoute('/_auth/quarry/view/$projectId/$commitId')({
    loader: async ({ context, params }) => {
        context.queryClient.ensureQueryData(commitQueryOptions(params.commitId));
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    component: CommitViewer,
    head: ({ loaderData }) => ({
        meta: [{ title: `Commit Viewer · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    })
});

function CommitViewer() {
    const { projectId, commitId } = Route.useParams();
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const { data: commit } = useSuspenseQuery(commitQueryOptions(commitId));
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
    const navigate = useNavigate();
    const stageSlot = useRef<HTMLDivElement>(null);
    const stageInstance = useRef<Konva.Stage>(null);
    const [stageScaleFactor, setStageScaleFactor] = useState(DEFAULT_STAGE_SCALE_FACTOR);
    const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
    const [branching, setBranching] = useState(false);
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;

    const slides = useMemo(() => commit.content?.slides ?? [], [commit]);

    // Default to first slide
    useEffect(() => {
        if (!activeSlideId && slides.length > 0) {
            setActiveSlideId(slides[0].id);
        }
    }, [activeSlideId, slides]);

    const activeLayers = useMemo(() => {
        const slide = slides.find((s) => s.id === activeSlideId);
        return (slide?.layers ?? []) as LayerWithEditorState[];
    }, [slides, activeSlideId]);

    const sortedLayers = useMemo(
        () => [...activeLayers].sort((a, b) => a.config.zIndex - b.config.zIndex),
        [activeLayers]
    );
    const backgroundLayer = useMemo(
        () =>
            sortedLayers.find(
                (layer): layer is Extract<LayerWithEditorState, { type: 'background' }> =>
                    layer.type === 'background' && layer.config.visible
            ) ?? null,
        [sortedLayers]
    );
    const foregroundLayers = useMemo(
        () => sortedLayers.filter((layer) => layer.type !== 'background'),
        [sortedLayers]
    );

    useLayoutEffect(() => {
        const slot = stageSlot.current;
        if (!slot) return;

        const logicalHeight = SCREEN_H * ROWS;
        const minScale = 0.01;

        const recomputeScale = () => {
            const availableHeight = slot.clientHeight;
            if (availableHeight <= 0) return;
            const maxVerticalScale = Math.max(minScale, availableHeight / logicalHeight);
            setStageScaleFactor((prev) =>
                Math.abs(prev - maxVerticalScale) < 0.0005 ? prev : maxVerticalScale
            );
        };

        recomputeScale();
        const observer = new ResizeObserver(recomputeScale);
        observer.observe(slot);

        return () => observer.disconnect();
    }, []);

    const handleStageWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
        const slot = stageSlot.current;
        if (!slot) return;
        const delta = e.evt.deltaX + e.evt.deltaY;
        if (delta === 0) return;
        e.evt.preventDefault();
        slot.scrollLeft += delta;
    }, []);

    const handleEditFromVersion = async () => {
        setBranching(true);
        try {
            if (commit.isMutableHead && project.headCommitId === commitId) {
                // This IS the project head — just navigate to the editor
                const firstSlideId = slides[0]?.id;
                if (!firstSlideId) {
                    toast.error('No slides in this commit');
                    return;
                }
                navigate({
                    to: '/quarry/editor/$projectId/$commitId/$slideId',
                    params: { projectId, commitId, slideId: firstSlideId }
                });
                return;
            }

            // Create a branch head from this commit
            const branchHeadId = await $createBranchHead({
                data: { projectId, sourceCommitId: commitId }
            });

            // Get the first slide from the new branch
            const firstSlideId = slides[0]?.id;
            if (!firstSlideId) {
                toast.error('No slides in this commit');
                return;
            }

            toast.success('Branch created from this version');
            navigate({
                to: '/quarry/editor/$projectId/$commitId/$slideId',
                params: { projectId, commitId: branchHeadId, slideId: firstSlideId }
            });
        } catch (e: any) {
            toast.error(e.message);
        } finally {
            setBranching(false);
        }
    };

    return (
        <div
            className={`container flex h-full max-h-full min-h-0 min-w-full flex-col overflow-hidden pb-13 ${isImpersonating ? 'pt-28' : 'pt-18'}`}
        >
            <ResizablePanelGroup
                orientation="horizontal"
                className="h-full min-h-0 w-full overflow-hidden font-sans text-foreground"
            >
                <ResizablePanel className="min-h-0 overflow-hidden">
                    <div className="flex h-full min-h-0 flex-col overflow-hidden">
                        <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
                            <div className="flex items-center gap-3">
                                <Button
                                    render={
                                        <Link
                                            to="/quarry/projects/$projectId/commits"
                                            params={{ projectId }}
                                        />
                                    }
                                    variant="ghost"
                                    size="sm"
                                    nativeButton={false}
                                >
                                    <ArrowLeftIcon /> Back
                                </Button>
                                <Separator orientation="vertical" className="mr-2" />
                                <div className="flex items-center gap-2">
                                    <h2 className="text-sm font-medium">{commit.message}</h2>
                                    <p className="text-xs text-muted-foreground">
                                        Read-only view ·{' '}
                                        <DateDisplay
                                            value={commit.createdAt}
                                            fallback="-"
                                            className="text-xs text-muted-foreground"
                                        />
                                    </p>
                                </div>
                            </div>
                            <Button
                                variant="default"
                                size="sm"
                                onClick={handleEditFromVersion}
                                disabled={branching}
                            >
                                {branching ? (
                                    <>
                                        <CircleNotchIcon className="animate-spin" />
                                        Opening editor...
                                    </>
                                ) : (
                                    <>
                                        <GitBranchIcon /> Edit from this version
                                    </>
                                )}
                            </Button>
                        </div>

                        {/* Main content */}
                        <div className="flex min-h-0 flex-1 overflow-hidden">
                            {/* Canvas area */}
                            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                                {/* Stage */}

                                <ViewerSlatePreview
                                    stageSlot={stageSlot}
                                    stageInstance={stageInstance}
                                    stageScaleFactor={stageScaleFactor}
                                    layers={sortedLayers}
                                />
                                <div
                                    ref={stageSlot}
                                    className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-black"
                                >
                                    <Stage
                                        ref={stageInstance}
                                        width={COLS * SCREEN_W * stageScaleFactor}
                                        height={ROWS * SCREEN_H * stageScaleFactor}
                                        onWheel={handleStageWheel}
                                        scaleX={stageScaleFactor}
                                        scaleY={stageScaleFactor}
                                    >
                                        <KonvaLayer>
                                            {backgroundLayer ? (
                                                <KonvaBackgroundLayer
                                                    key={`bg_${backgroundLayer.numericId}`}
                                                    layer={backgroundLayer}
                                                    previewScale={1}
                                                />
                                            ) : null}
                                            {foregroundLayers
                                                .filter((layer) => layer.config.visible)
                                                .map((layer) => {
                                                    if (layer.type === 'image') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`img_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'video') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`vid_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'web') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`web_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'text') {
                                                        return (
                                                            <ReadOnlyTextLayer
                                                                key={`txt_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'shape') {
                                                        const common = {
                                                            x: layer.config.cx,
                                                            y: layer.config.cy,
                                                            rotation: layer.config.rotation,
                                                            scaleX: layer.config.scaleX,
                                                            scaleY: layer.config.scaleY,
                                                            fill: layer.fill,
                                                            stroke: layer.strokeColor,
                                                            strokeWidth: layer.strokeWidth,
                                                            listening: false as const
                                                        };
                                                        if (layer.shape === 'rectangle') {
                                                            return (
                                                                <Rect
                                                                    key={`shape_${layer.numericId}`}
                                                                    {...common}
                                                                    width={layer.config.width}
                                                                    height={layer.config.height}
                                                                    offsetX={layer.config.width / 2}
                                                                    offsetY={
                                                                        layer.config.height / 2
                                                                    }
                                                                    dash={layer.strokeDash}
                                                                />
                                                            );
                                                        }
                                                        if (layer.shape === 'circle') {
                                                            return (
                                                                <Circle
                                                                    key={`shape_${layer.numericId}`}
                                                                    {...common}
                                                                    offsetX={layer.config.width / 2}
                                                                    offsetY={
                                                                        layer.config.height / 2
                                                                    }
                                                                    radius={layer.config.width / 2}
                                                                    dash={layer.strokeDash}
                                                                />
                                                            );
                                                        }
                                                    }
                                                    if (layer.type === 'line') {
                                                        return (
                                                            <Line
                                                                key={`lin_${layer.numericId}`}
                                                                points={layer.line}
                                                                stroke={layer.strokeColor}
                                                                strokeWidth={layer.strokeWidth}
                                                                dash={layer.strokeDash}
                                                                dashEnabled={true}
                                                                tension={0.4}
                                                                lineCap="round"
                                                                lineJoin="round"
                                                                listening={false}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'map') {
                                                        return (
                                                            <Rect
                                                                key={`map_${layer.numericId}`}
                                                                x={layer.config.cx}
                                                                y={layer.config.cy}
                                                                width={layer.config.width}
                                                                height={layer.config.height}
                                                                scaleX={layer.config.scaleX}
                                                                scaleY={layer.config.scaleY}
                                                                offsetX={layer.config.width / 2}
                                                                offsetY={layer.config.height / 2}
                                                                rotation={layer.config.rotation}
                                                                fill="#1f2937"
                                                                stroke="#334155"
                                                                strokeWidth={2}
                                                                listening={false}
                                                            />
                                                        );
                                                    }
                                                    // Fallback placeholder
                                                    return (
                                                        <Rect
                                                            key={`fallback_${layer.numericId}`}
                                                            x={layer.config.cx}
                                                            y={layer.config.cy}
                                                            width={layer.config.width}
                                                            height={layer.config.height}
                                                            offsetX={layer.config.width / 2}
                                                            offsetY={layer.config.height / 2}
                                                            rotation={layer.config.rotation}
                                                            fill="#555"
                                                            listening={false}
                                                        />
                                                    );
                                                })}
                                            {getDOGridLines(COLS * SCREEN_W, ROWS * SCREEN_H, 20)}
                                        </KonvaLayer>
                                    </Stage>
                                </div>
                                {!activeSlideId && slides.length > 0 && (
                                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                                        <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 shadow-lg">
                                            <CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                                            <span className="text-sm font-medium text-muted-foreground">
                                                Loading slide...
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel
                    defaultSize={300}
                    minSize={200}
                    className="min-h-0 overflow-hidden border-t border-border"
                >
                    {/* Slide list sidebar */}
                    <div className="flex h-full min-h-0 w-full flex-col border-l border-border">
                        <div className="flex h-11 shrink-0 cursor-pointer items-center justify-between border-b border-border bg-muted/50 px-4">
                            <h2 className="flex items-center gap-2 text-sm font-semibold">
                                <SlideshowIcon size={18} weight="bold" /> Slides
                            </h2>
                        </div>
                        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                            {slides
                                .sort((a, b) => a.order - b.order)
                                .map((slide, idx) => (
                                    <button
                                        key={slide.id}
                                        onClick={() => setActiveSlideId(slide.id)}
                                        className={`w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-card/50 ${
                                            activeSlideId === slide.id
                                                ? 'bg-primary/10 text-primary'
                                                : 'text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        <span className="font-medium">Slide {idx + 1}</span>
                                    </button>
                                ))}
                        </div>
                    </div>
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    );
}
