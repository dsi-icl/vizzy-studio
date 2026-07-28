import type { StageLayout } from '@repo/db/schema';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'react-konva';

import { BACKGROUND_T_SPEED, renderBackgroundNoise } from '~/lib/backgroundNoise';
import { renderBackgroundParticle } from '~/lib/backgroundParticle';
import { resolveBackgroundRasterSize } from '~/lib/backgroundRasterBudget';
import { renderBackgroundWaves } from '~/lib/backgroundWave';
import type { Layer } from '~/lib/types';

type BackgroundLayer = Extract<Layer, { type: 'background' }>;

interface KonvaBackgroundLayerProps {
    layer: BackgroundLayer;
    previewScale: number;
    layout: StageLayout;
}

/**
 * Static noise snapshot rendered as a Konva Image covering the full wall.
 * Non-interactive — click/drag pass through to layers below.
 */
function KonvaBackgroundLayerInner({ layer, previewScale, layout }: KonvaBackgroundLayerProps) {
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const renderedWidthRef = useRef(0);
    const lastConfigKeyRef = useRef('');
    const wallWidth = layout.columns * layout.screenWidth;
    const wallHeight = layout.rows * layout.screenHeight;

    const previewRasterSize = useMemo(() => {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        return resolveBackgroundRasterSize(wallWidth, wallHeight, previewScale, dpr);
    }, [previewScale, wallHeight, wallWidth]);

    useEffect(() => {
        const configKey = [
            layout.columns,
            layout.rows,
            layout.screenWidth,
            layout.screenHeight,
            layer.backgroundType,
            layer.backgroundColor,
            layer.atmosphereColor,
            layer.motifColor1,
            layer.motifColor2,
            layer.noiseSeed,
            layer.speedFactor
        ].join('|');
        const configChanged = configKey !== lastConfigKeyRef.current;
        const needsSharperRaster = previewRasterSize.width > renderedWidthRef.current;

        if (!configChanged && !needsSharperRaster && canvas) return;

        const offscreen = document.createElement('canvas');
        offscreen.width = previewRasterSize.width;
        offscreen.height = previewRasterSize.height;
        // Use current wall-clock t (same formula as WallBackgroundCanvas) so
        // the preview matches what the wall is showing right now.
        const t = (Date.now() / 1000) * BACKGROUND_T_SPEED * layer.speedFactor;
        if (layer.backgroundType === 'solid') {
            const ctx = offscreen.getContext('2d');
            if (ctx) {
                ctx.fillStyle = layer.backgroundColor;
                ctx.fillRect(0, 0, offscreen.width, offscreen.height);
            }
        } else if (layer.backgroundType === 'waves') {
            renderBackgroundWaves(offscreen, layer, 0, 0, t, layout.columns, layout.rows, layout);
        } else if (layer.backgroundType === 'particle') {
            renderBackgroundParticle(
                offscreen,
                layer,
                0,
                0,
                t,
                layout.columns,
                layout.rows,
                layout
            );
        } else {
            renderBackgroundNoise(offscreen, layer, 0, 0, t, layout.columns, layout.rows, layout);
        }
        renderedWidthRef.current = offscreen.width;
        lastConfigKeyRef.current = configKey;
        setCanvas(offscreen);
    }, [
        canvas,
        layer.backgroundType,
        layer.backgroundColor,
        layer.atmosphereColor,
        layer.motifColor1,
        layer.motifColor2,
        layer.noiseSeed,
        layer.speedFactor,
        previewRasterSize,
        layout,
        wallHeight
    ]);

    if (!canvas) return null;

    return (
        <Image
            image={canvas}
            x={layer.config.cx}
            y={layer.config.cy}
            width={layer.config.width}
            height={layer.config.height}
            offsetX={layer.config.width / 2}
            offsetY={layer.config.height / 2}
            rotation={layer.config.rotation}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            listening={false}
        />
    );
}

export const KonvaBackgroundLayer = memo(
    KonvaBackgroundLayerInner,
    (prev, next) =>
        prev.previewScale === next.previewScale &&
        prev.layout.columns === next.layout.columns &&
        prev.layout.rows === next.layout.rows &&
        prev.layout.screenWidth === next.layout.screenWidth &&
        prev.layout.screenHeight === next.layout.screenHeight &&
        prev.layer.backgroundType === next.layer.backgroundType &&
        prev.layer.backgroundColor === next.layer.backgroundColor &&
        prev.layer.atmosphereColor === next.layer.atmosphereColor &&
        prev.layer.motifColor1 === next.layer.motifColor1 &&
        prev.layer.motifColor2 === next.layer.motifColor2 &&
        prev.layer.noiseSeed === next.layer.noiseSeed &&
        prev.layer.speedFactor === next.layer.speedFactor &&
        prev.layer.config.cx === next.layer.config.cx &&
        prev.layer.config.cy === next.layer.config.cy &&
        prev.layer.config.width === next.layer.config.width &&
        prev.layer.config.height === next.layer.config.height &&
        prev.layer.config.rotation === next.layer.config.rotation &&
        prev.layer.config.scaleX === next.layer.config.scaleX &&
        prev.layer.config.scaleY === next.layer.config.scaleY
);
