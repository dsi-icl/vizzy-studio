'use client';

import { useEffect, useRef } from 'react';

import {
    BACKGROUND_T_SPEED,
    BACKGROUND_TICK_MS,
    renderBackgroundNoise
} from '~/lib/backgroundNoise';
import { renderBackgroundParticle } from '~/lib/backgroundParticle';
import { renderBackgroundWaves } from '~/lib/backgroundWave';
import { SCREEN_H, SCREEN_W } from '~/lib/stageConstants';
import type { Layer } from '~/lib/types';

type BackgroundLayer = Extract<Layer, { type: 'background' }>;

interface WallBackgroundCanvasProps {
    layer: BackgroundLayer;
    col: number;
    row: number;
    getNow: () => number;
}

export function WallBackgroundCanvas({ layer, col, row, getNow }: WallBackgroundCanvasProps) {
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
                renderBackgroundWaves(canvasRef.current!, layer, col, row, t);
            } else if (isParticleBackground) {
                renderBackgroundParticle(canvasRef.current!, layer, col, row, t);
            } else {
                renderBackgroundNoise(canvasRef.current!, layer, col, row, t);
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
        row
    ]);

    return (
        <canvas
            ref={canvasRef}
            width={SCREEN_W}
            height={SCREEN_H}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: `${SCREEN_W}px`,
                height: `${SCREEN_H}px`,
                zIndex: 0,
                imageRendering: 'auto',
                pointerEvents: 'none'
            }}
        />
    );
}
