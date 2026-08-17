import {
    EraserIcon,
    PauseIcon,
    PencilSimpleIcon,
    PlayIcon,
    SkipBackIcon
} from '@phosphor-icons/react';
import { Separator } from '@repo/ui/components/separator';
import { TipButton } from '@repo/ui/components/tip-button';
import { TooltipProvider } from '@repo/ui/components/tooltip';
import { useState } from 'react';

import { EraserTool } from '~/components/EraserTool';
import { StrokeTool } from '~/components/StrokeTool';

interface ControllerToolbarProps {
    isDrawing: boolean;
    isErasing: boolean;
    canDraw: boolean;
    onToggleDrawing: () => void;
    onToggleErasing: () => void;
    eraserWidth: number;
    setEraserWidth: (width: number) => void;
    strokeColor: string;
    setStrokeColor: (color: string) => void;
    strokeWidth: number;
    setStrokeWidth: (width: number) => void;
    strokeDash: number[];
    setStrokeDash: (dash: number[]) => void;
    hasVideoLayers: boolean;
    onVideoCommand: (cmd: 'play' | 'pause' | 'rewind') => void;
}

export function ControllerToolbar({
    isDrawing,
    isErasing,
    canDraw,
    onToggleDrawing,
    onToggleErasing,
    eraserWidth,
    setEraserWidth,
    strokeColor,
    setStrokeColor,
    strokeWidth,
    setStrokeWidth,
    strokeDash,
    setStrokeDash,
    hasVideoLayers,
    onVideoCommand
}: ControllerToolbarProps) {
    const [isPlaying, setIsPlaying] = useState(false);

    return (
        <TooltipProvider>
            <div
                id="toolbar"
                className="flex h-11 min-h-11 items-center gap-1 border-t border-b border-border bg-card/50 px-2 py-1"
            >
                <TipButton
                    tip={canDraw ? 'Draw' : 'Connect to a slide to draw'}
                    tipSide="bottom"
                    onClick={onToggleDrawing}
                    variant={isDrawing ? 'outline' : 'ghost'}
                    disabled={!canDraw}
                >
                    <PencilSimpleIcon />
                </TipButton>
                <TipButton
                    tip={canDraw ? 'Eraser' : 'Connect to a slide to erase'}
                    tipSide="bottom"
                    aria-label="Eraser"
                    onClick={onToggleErasing}
                    variant={isErasing ? 'outline' : 'ghost'}
                    disabled={!canDraw}
                >
                    <EraserIcon />
                </TipButton>
                {isDrawing ? (
                    <StrokeTool
                        strokeColor={strokeColor}
                        setStrokeColor={setStrokeColor}
                        strokeWidth={strokeWidth}
                        setStrokeWidth={setStrokeWidth}
                        strokeDash={strokeDash}
                        setStrokeDash={setStrokeDash}
                    />
                ) : isErasing ? (
                    <EraserTool
                        eraserWidth={eraserWidth}
                        setEraserWidth={setEraserWidth}
                        showIcon={false}
                    />
                ) : null}
                <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                {hasVideoLayers && (
                    <>
                        <TipButton
                            tip="Rewind all videos"
                            tipSide="bottom"
                            variant="ghost"
                            onClick={() => {
                                onVideoCommand('rewind');
                                setIsPlaying(false);
                            }}
                        >
                            <SkipBackIcon />
                        </TipButton>
                        {isPlaying ? (
                            <TipButton
                                tip="Pause all videos"
                                tipSide="bottom"
                                variant="ghost"
                                onClick={() => {
                                    onVideoCommand('pause');
                                    setIsPlaying(false);
                                }}
                            >
                                <PauseIcon />
                            </TipButton>
                        ) : (
                            <TipButton
                                tip="Play all videos"
                                tipSide="bottom"
                                variant="ghost"
                                onClick={() => {
                                    onVideoCommand('play');
                                    setIsPlaying(true);
                                }}
                            >
                                <PlayIcon />
                            </TipButton>
                        )}
                        <Separator orientation="vertical" className="mx-1 my-1 h-6" />
                    </>
                )}
            </div>
        </TooltipProvider>
    );
}
