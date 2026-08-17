import { EraserIcon } from '@phosphor-icons/react';
import { Slider } from '@repo/ui/components/slider';

import { ERASER_MAX_WIDTH, ERASER_MIN_WIDTH, ERASER_WHEEL_STEP } from '~/lib/eraser';

interface EraserToolProps {
    eraserWidth: number;
    setEraserWidth: (width: number) => void;
    showIcon?: boolean;
}

export function EraserTool({ eraserWidth, setEraserWidth, showIcon = true }: EraserToolProps) {
    return (
        <div className="flex min-w-72 items-center gap-3">
            {showIcon ? <EraserIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
            <Slider
                aria-label="Eraser size"
                value={[eraserWidth]}
                onValueChange={(value) => setEraserWidth(Array.isArray(value) ? value[0] : value)}
                min={ERASER_MIN_WIDTH}
                max={ERASER_MAX_WIDTH}
                step={ERASER_WHEEL_STEP}
                className="w-52"
            />
            <span className="w-12 text-right font-mono text-xs text-muted-foreground">
                {eraserWidth}px
            </span>
        </div>
    );
}
