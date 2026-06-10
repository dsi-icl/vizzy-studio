import {
    AlignBottomSimpleIcon,
    AlignCenterHorizontalSimpleIcon,
    AlignCenterVerticalSimpleIcon,
    AlignLeftSimpleIcon,
    AlignRightSimpleIcon,
    AlignTopSimpleIcon,
    ArrowLineDownIcon,
    ArrowLineUpIcon,
    ArrowsClockwiseIcon,
    ArrowsInLineHorizontalIcon,
    CircleNotchIcon,
    CheckCircleIcon,
    EraserIcon,
    FloppyDiskIcon,
    GridNineIcon,
    ImageIcon,
    MapPinIcon,
    GlobeSimpleIcon,
    PencilSimpleIcon,
    RectangleIcon,
    CircleIcon,
    ShapesIcon,
    TextTIcon,
    WarningCircleIcon,
    WaveSineIcon,
    XIcon
} from '@phosphor-icons/react';
import { useAuth } from '@repo/auth/tanstack/hooks';
import { Button } from '@repo/ui/components/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Separator } from '@repo/ui/components/separator';
import { TipButton } from '@repo/ui/components/tip-button';
import { TooltipProvider } from '@repo/ui/components/tooltip';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { AppearanceToolbar } from '~/components/AppearanceToolbar';
import { BackgroundLayerPanel } from '~/components/BackgroundLayerPanel';
import { FilterPanel } from '~/components/FilterPanel';
import { PlaybackControls } from '~/components/PlaybackControls';
import { SlidesJsonDialog } from '~/components/SlidesJsonDialog';
import { VideoScrubber } from '~/components/VideoScrubber';
import { WallBindingBar } from '~/components/WallBindingBar';
import { WebLayerPanel } from '~/components/WebLayerPanel';
import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import type { LayerWithEditorState } from '~/lib/types';

interface EditorToolbarProps {
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function EditorToolbar({ fileInputRef, onUpload }: EditorToolbarProps) {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    // Project header — only changes on project load
    const { projectId, projectName, parentSaveMessage } = useEditorStore(
        useShallow((s) => ({
            projectId: s.projectId,
            projectName: s.projectName,
            parentSaveMessage: s.parentSaveMessage
        }))
    );

    // Save / connection state — infrequent, independent
    const saveStatus = useEditorStore((s) => s.saveStatus);
    const boundWallId = useEditorStore((s) => s.boundWallId);
    const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);

    // Tool toggle state
    const { showGrid, isDrawing, isErasing, isSnapping } = useEditorStore(
        useShallow((s) => ({
            showGrid: s.showGrid,
            isDrawing: s.isDrawing,
            isErasing: s.isErasing,
            isSnapping: s.isSnapping
        }))
    );

    // Active layer — re-renders only when the selected layer's own data changes
    const activeLayer = useEditorStore((s) => {
        const id = s.selectedLayerIds[0];
        return id ? (s.layers.get(parseInt(id)) ?? null) : null;
    });

    // Background layer — always accessible regardless of selection
    const backgroundLayer = useEditorStore((s) => {
        for (const layer of s.layers.values()) {
            if (layer.type === 'background')
                return layer as Extract<LayerWithEditorState, { type: 'background' }>;
        }
        return null;
    });

    // Actions — stable references, never trigger re-renders
    const { toggleSnapping, toggleDrawing, toggleErasing, toggleGrid, startTextEditing } =
        useEditorStore(
            useShallow((s) => ({
                toggleSnapping: s.toggleSnapping,
                toggleDrawing: s.toggleDrawing,
                toggleErasing: s.toggleErasing,
                toggleGrid: s.toggleGrid,
                startTextEditing: s.startTextEditing
            }))
        );
    const {
        addTextLayer,
        addMapLayer,
        addWebLayer,
        addShapeLayer,
        addBackgroundLayer,
        removeLayer,
        bringToFront,
        sendToBack,
        alignSelectedLayers,
        clearStage,
        reboot,
        saveProject
    } = useEditorStore(
        useShallow((s) => ({
            addTextLayer: s.addTextLayer,
            addMapLayer: s.addMapLayer,
            addWebLayer: s.addWebLayer,
            addShapeLayer: s.addShapeLayer,
            addBackgroundLayer: s.addBackgroundLayer,
            removeLayer: s.removeLayer,
            bringToFront: s.bringToFront,
            sendToBack: s.sendToBack,
            alignSelectedLayers: s.alignSelectedLayers,
            clearStage: s.clearStage,
            reboot: s.reboot,
            saveProject: s.saveProject
        }))
    );
    const isMultiLayerSelection = selectedLayerIds.length > 1;

    const engine = useMemo(
        () => (typeof window !== 'undefined' ? EditorEngine.getInstance() : null),
        []
    );

    const isVideo = activeLayer?.type === 'video';
    const isText = activeLayer?.type === 'text';
    const isShape = activeLayer?.type === 'shape';
    const isLine = activeLayer?.type === 'line';
    const isWeb = activeLayer?.type === 'web';

    // Save popover state
    const [commitMessage, setCommitMessage] = useState('');
    const [savePopoverOpen, setSavePopoverOpen] = useState(false);
    const [jsonDialogOpen, setJsonDialogOpen] = useState(false);
    const [clearStageDialogOpen, setClearStageDialogOpen] = useState(false);
    const commitInputRef = useRef<HTMLInputElement>(null);

    const handleManualSave = () => {
        const msg = commitMessage.trim() || 'Manual save';
        setSavePopoverOpen(false);
        setCommitMessage('');
        saveProject(msg);
    };

    return (
        <TooltipProvider>
            <div
                id="titlebar"
                className="flex items-center gap-1 border-t border-border bg-card/50 px-2 py-1"
            >
                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/mp4, image/*"
                    onChange={onUpload}
                    className="hidden"
                />

                {/* ── Close ── */}
                {projectId && (
                    <>
                        <TipButton
                            tip="Back to project"
                            nativeButton={false}
                            render={
                                <Link to="/quarry/projects/$projectId" params={{ projectId }} />
                            }
                        >
                            <XIcon />
                        </TipButton>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                    </>
                )}

                {/* ── Add Content ── */}
                <div className="flex items-center gap-0.5">
                    <TipButton tip="Upload assets" onClick={() => fileInputRef.current?.click()}>
                        <ImageIcon />
                    </TipButton>
                    <Popover>
                        <PopoverTrigger nativeButton={false} render={<div />}>
                            <TipButton tip="Add shape">
                                <ShapesIcon />
                            </TipButton>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-1" side="bottom" align="start">
                            <div className="flex gap-1">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => addShapeLayer('rectangle')}
                                >
                                    <RectangleIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => addShapeLayer('circle')}
                                >
                                    <CircleIcon />
                                </Button>
                            </div>
                        </PopoverContent>
                    </Popover>
                    <TipButton tip="Add text layer" onClick={addTextLayer}>
                        <TextTIcon />
                    </TipButton>
                    {/* TODO: Switcher to guarding by "tester" role once multi-role is implemented */}
                    {isAdmin ? (
                        <TipButton tip="Add map layer" onClick={addMapLayer}>
                            <MapPinIcon />
                        </TipButton>
                    ) : null}
                    <TipButton tip="Add web layer" onClick={addWebLayer}>
                        <GlobeSimpleIcon />
                    </TipButton>
                    <TipButton
                        tip="Draw"
                        onClick={toggleDrawing}
                        variant={isDrawing ? 'outline' : 'ghost'}
                    >
                        <PencilSimpleIcon />
                    </TipButton>
                    <TipButton
                        tip="Eraser"
                        onClick={toggleErasing}
                        variant={isErasing ? 'outline' : 'ghost'}
                    >
                        <EraserIcon />
                    </TipButton>
                </div>

                <div className="w-full grow text-center text-xs text-muted-foreground">
                    {projectName} - {parentSaveMessage}
                    {saveStatus === 'dirty' && <span> - Unsaved</span>}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                <TipButton tip="Extract JSON" onClick={() => setJsonDialogOpen(true)}>
                    <span className="font-mono text-xs">{'{}'}</span>
                </TipButton>

                {/* ── Live Preview ── */}
                <WallBindingBar engine={engine} boundWallId={boundWallId} />

                {/* ── Save ── */}
                <div className="flex items-center gap-0.5">
                    <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
                        <PopoverTrigger nativeButton={false} render={<div />}>
                            <TipButton
                                tip={
                                    saveStatus === 'dirty'
                                        ? 'Unsaved changes — click to save'
                                        : saveStatus === 'saving'
                                          ? 'Saving...'
                                          : saveStatus === 'saved'
                                            ? 'Saved'
                                            : saveStatus === 'error'
                                              ? 'Save failed — click to retry'
                                              : 'Save project'
                                }
                                variant={
                                    saveStatus === 'dirty' || saveStatus === 'error'
                                        ? 'outline'
                                        : 'ghost'
                                }
                                disabled={saveStatus === 'saving'}
                            >
                                {saveStatus === 'saving' ? (
                                    <CircleNotchIcon className="animate-spin" />
                                ) : saveStatus === 'saved' ? (
                                    <CheckCircleIcon weight="fill" className="text-green-500" />
                                ) : saveStatus === 'error' ? (
                                    <WarningCircleIcon weight="fill" className="text-destructive" />
                                ) : (
                                    <FloppyDiskIcon
                                        weight={saveStatus === 'dirty' ? 'fill' : 'regular'}
                                    />
                                )}
                            </TipButton>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 p-3" side="bottom" align="start">
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    handleManualSave();
                                }}
                                className="flex flex-col gap-2"
                            >
                                <label className="text-xs font-medium text-muted-foreground">
                                    Commit message
                                </label>
                                <Input
                                    ref={commitInputRef}
                                    value={commitMessage}
                                    onChange={(e) => setCommitMessage(e.target.value)}
                                    placeholder="Describe your changes..."
                                    autoFocus
                                />
                                <Button type="submit" size="sm" disabled={saveStatus === 'saving'}>
                                    {saveStatus === 'saving' ? 'Saving...' : 'Save version'}
                                </Button>
                            </form>
                        </PopoverContent>
                    </Popover>
                </div>
                <Separator orientation="vertical" className="mx-1 my-1 h-6" />

                {/* ── Danger Zone ── */}
                <div className="flex items-center gap-0.5">
                    <TipButton
                        tip={isSnapping ? 'Disable Snap' : 'Enable Snap'}
                        variant={isSnapping ? 'outline' : 'ghost'}
                        onClick={toggleSnapping}
                    >
                        <ArrowsInLineHorizontalIcon weight={showGrid ? 'fill' : 'regular'} />
                    </TipButton>
                    <TipButton
                        tip={showGrid ? 'Hide Grid' : 'Show Grid'}
                        variant={showGrid ? 'outline' : 'ghost'}
                        onClick={toggleGrid}
                    >
                        <GridNineIcon weight={showGrid ? 'fill' : 'regular'} />
                    </TipButton>
                    <TipButton tip="Refresh all screens" variant="ghost" onClick={reboot}>
                        <ArrowsClockwiseIcon />
                    </TipButton>
                    <TipButton
                        tip="Clear all layers"
                        variant="destructive"
                        onClick={() => setClearStageDialogOpen(true)}
                    >
                        <EraserIcon />
                    </TipButton>
                </div>
            </div>
            <div
                id="toolbar"
                className="flex h-11 min-h-11 items-center gap-1 border-t border-b border-border bg-card/50 px-2 py-1"
            >
                <Popover>
                    <PopoverTrigger nativeButton={false} render={<div />}>
                        <TipButton
                            tip={backgroundLayer ? 'Background settings' : 'Add background layer'}
                            variant={backgroundLayer ? 'outline' : 'ghost'}
                        >
                            <WaveSineIcon weight={backgroundLayer ? 'fill' : 'regular'} />
                        </TipButton>
                    </PopoverTrigger>
                    <PopoverContent className="w-56 p-3" side="bottom" align="start">
                        {backgroundLayer ? (
                            <div className="flex flex-col gap-3">
                                <p className="text-xs font-medium text-muted-foreground">
                                    Background
                                </p>
                                <BackgroundLayerPanel activeLayer={backgroundLayer} />
                                <Separator />
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => removeLayer(backgroundLayer.numericId)}
                                >
                                    Remove background
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground">
                                    No background layer on this slide.
                                </p>
                                <Button size="sm" onClick={addBackgroundLayer}>
                                    Add background layer
                                </Button>
                            </div>
                        )}
                    </PopoverContent>
                </Popover>
                <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                {activeLayer ? (
                    <span className="px-2 text-xs">{activeLayer.type}</span>
                ) : (
                    <span className="px-2 text-xs text-muted-foreground">
                        Select a layer to access tools
                    </span>
                )}

                {/* ── Layer Ordering + Filters ── */}
                {activeLayer && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <div className="flex items-center gap-0.5">
                            <TipButton tip="Bring to front" onClick={bringToFront}>
                                <ArrowLineUpIcon />
                            </TipButton>
                            <TipButton tip="Send to back" onClick={sendToBack}>
                                <ArrowLineDownIcon />
                            </TipButton>
                        </div>
                        {/* TODO: Switcher to guarding by "tester" role once multi-role is implemented */}
                        {isAdmin ? <FilterPanel activeLayer={activeLayer} /> : null}
                    </>
                )}

                {/* ── Text ── */}
                {isText && activeLayer && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <TipButton
                            tip="Edit text"
                            onClick={() => startTextEditing(activeLayer.numericId)}
                        >
                            <PencilSimpleIcon />
                        </TipButton>
                    </>
                )}

                {/* ── Line / Shape / Drawing ── */}
                {(isDrawing || isErasing || isLine || isShape) && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <AppearanceToolbar />
                    </>
                )}

                {/* ── Web ── */}
                {isWeb && activeLayer && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <WebLayerPanel
                            activeLayer={
                                activeLayer as Extract<LayerWithEditorState, { type: 'web' }>
                            }
                            projectId={projectId ?? ''}
                        />
                    </>
                )}

                {/* ── Video Playback ── */}
                {isVideo && activeLayer && !activeLayer.isUploading && engine && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <PlaybackControls
                            key={`pc_${activeLayer.numericId}`}
                            layer={activeLayer as Extract<LayerWithEditorState, { type: 'video' }>}
                            engine={engine}
                        />
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <VideoScrubber
                            key={`vs_${activeLayer.numericId}`}
                            layer={activeLayer as Extract<LayerWithEditorState, { type: 'video' }>}
                            engine={engine}
                        />
                    </>
                )}

                {isMultiLayerSelection ? (
                    <div className="ml-auto flex items-center gap-0.5">
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                        <TipButton tip="Align left" onClick={() => alignSelectedLayers('left')}>
                            <AlignLeftSimpleIcon />
                        </TipButton>
                        <TipButton
                            tip="Align horizontal center"
                            onClick={() => alignSelectedLayers('center-horizontal')}
                        >
                            <AlignCenterHorizontalSimpleIcon />
                        </TipButton>
                        <TipButton tip="Align right" onClick={() => alignSelectedLayers('right')}>
                            <AlignRightSimpleIcon />
                        </TipButton>
                        <TipButton tip="Align top" onClick={() => alignSelectedLayers('top')}>
                            <AlignTopSimpleIcon />
                        </TipButton>
                        <TipButton
                            tip="Align vertical center"
                            onClick={() => alignSelectedLayers('center-vertical')}
                        >
                            <AlignCenterVerticalSimpleIcon />
                        </TipButton>
                        <TipButton tip="Align bottom" onClick={() => alignSelectedLayers('bottom')}>
                            <AlignBottomSimpleIcon />
                        </TipButton>
                    </div>
                ) : null}
            </div>
            <SlidesJsonDialog open={jsonDialogOpen} onOpenChange={setJsonDialogOpen} />
            <Dialog open={clearStageDialogOpen} onOpenChange={setClearStageDialogOpen}>
                <DialogContent className="w-80 p-5">
                    <DialogTitle>Clear all layers</DialogTitle>
                    <DialogDescription className="mt-1">
                        Are you sure you want to remove all layers from this slide?
                    </DialogDescription>
                    <div className="mt-4 flex justify-end gap-2">
                        <DialogClose>
                            <Button variant="outline" size="sm">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                                clearStage();
                                setClearStageDialogOpen(false);
                            }}
                        >
                            Clear all
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </TooltipProvider>
    );
}
