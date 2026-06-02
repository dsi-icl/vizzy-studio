import { EraserIcon } from '@phosphor-icons/react';
import { Slider } from '@repo/ui/components/slider';

import { ERASER_MAX_WIDTH, ERASER_MIN_WIDTH, clampEraserWidth } from '~/lib/eraser';

interface EraserToolProps {
    eraserWidth: number;
    setEraserWidth: (width: number) => void;
}

export function EraserTool({ eraserWidth, setEraserWidth }: EraserToolProps) {
    const normalizedWidth = clampEraserWidth(eraserWidth);

    return (
        <div className="flex min-w-[18rem] items-center gap-3">
            <EraserIcon className="size-4 shrink-0 text-muted-foreground" />
            <Slider
                value={[normalizedWidth]}
                onValueChange={(v) => {
                    const next = Array.isArray(v) ? v[0] : v;
                    setEraserWidth(clampEraserWidth(next));
                }}
                min={ERASER_MIN_WIDTH}
                max={ERASER_MAX_WIDTH}
                step={10}
                className="w-52"
            />
            <span className="w-12 text-right font-mono text-xs text-muted-foreground">
                {normalizedWidth}px
            </span>
        </div>
    );
}
