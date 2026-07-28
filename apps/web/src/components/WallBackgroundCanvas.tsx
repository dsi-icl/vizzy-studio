'use client';

import type { StageLayout } from '@repo/db/schema';
import { useEffect, useRef } from 'react';

import {
    BACKGROUND_T_SPEED,
    BACKGROUND_TICK_MS,
    renderBackgroundNoise
} from '~/lib/backgroundNoise';
import { renderBackgroundParticle } from '~/lib/backgroundParticle';
import { renderBackgroundWaves } from '~/lib/backgroundWave';
import type { Layer } from '~/lib/types';

type BackgroundLayer = Extract<Layer, { type: 'background' }>;

interface WallBackgroundCanvasProps {
    layer: BackgroundLayer;
    col: number;
    row: number;
    getNow: () => number;
    layout: StageLayout;
}

export function WallBackgroundCanvas({
    layer,
    col,
    row,
    getNow,
    layout
}: WallBackgroundCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const getNowRef = useRef(getNow);
    useEffect(() => {
        getNowRef.current = getNow;
    }, [getNow]);

    useEffect(() => {
        if (layer.backgroundType === 'solid') {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = layer.backgroundColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }

        const isWaveBackground = layer.backgroundType === 'waves';
        const isParticleBackground = layer.backgroundType === 'particle';
        const draw = () => {
            const t = (getNowRef.current() / 1000) * BACKGROUND_T_SPEED * layer.speedFactor;
            if (isWaveBackground) {
                renderBackgroundWaves(canvasRef.current!, layer, col, row, t, 1, 1, layout);
            } else if (isParticleBackground) {
                renderBackgroundParticle(canvasRef.current!, layer, col, row, t, 1, 1, layout);
            } else {
                renderBackgroundNoise(canvasRef.current!, layer, col, row, t, 1, 1, layout);
            }
        };

        draw();
        // Waves and particles need higher redraw cadence to avoid visible stepping.
        const baseTickMs = isWaveBackground ? 90 : isParticleBackground ? 85 : BACKGROUND_TICK_MS;
        const minTickMs = isWaveBackground ? 50 : isParticleBackground ? 45 : 200;
        const tickMs = Math.max(minTickMs, baseTickMs / Math.max(layer.speedFactor, 0.1));
        const id = setInterval(draw, tickMs);
        return () => clearInterval(id);
    }, [
        layer.backgroundType,
        layer.backgroundColor,
        layer.atmosphereColor,
        layer.motifColor1,
        layer.motifColor2,
        layer.noiseSeed,
        layer.speedFactor,
        col,
        row,
        layout
    ]);

    return (
        <canvas
            ref={canvasRef}
            width={layout.screenWidth}
            height={layout.screenHeight}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: `${layout.screenWidth}px`,
                height: `${layout.screenHeight}px`,
                zIndex: 0,
                imageRendering: 'auto',
                pointerEvents: 'none'
            }}
        />
    );
}
