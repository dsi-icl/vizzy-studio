import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';

import {
    BACKGROUND_T_SPEED,
    BACKGROUND_TICK_MS,
    type BackgroundNoiseLayer,
    renderBackgroundNoise
} from '~/lib/backgroundNoise';
import { renderBackgroundParticle } from '~/lib/backgroundParticle';
import { renderBackgroundWaves } from '~/lib/backgroundWave';
import { guardPlaygroundDevOnly } from '~/lib/playgroundGuard';
import { SCREEN_H, SCREEN_W } from '~/lib/stageConstants';

export const Route = createFileRoute('/playground/bg')({
    beforeLoad: guardPlaygroundDevOnly,
    head: () => ({
        meta: [{ title: 'Playground Background Tile · Vizzy Studio' }]
    }),
    component: PlaygroundBackgroundTile
});

type BackgroundPattern = 'i-pattern' | 'waves' | 'particle';

function parseIntParam(value: unknown, fallback: number): number {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseFloatParam(value: unknown, fallback: number): number {
    const n = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(n) ? n : fallback;
}

function parseHex(value: unknown, fallback: string): string {
    const v = String(value ?? '').trim();
    return /^#[0-9a-fA-F]{6,8}$/.test(v) ? v : fallback;
}

function parsePattern(value: unknown): BackgroundPattern {
    if (value === 'waves' || value === 'particle') return value;
    return 'i-pattern';
}

function PlaygroundBackgroundTile() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hasPostedReadyRef = useRef(false);
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const search = useMemo(() => new URLSearchParams(searchStr), [searchStr]);

    const c = parseIntParam(search.get('c'), 0);
    const r = parseIntParam(search.get('r'), 0);
    const pattern = parsePattern(search.get('p'));
    const speed = Math.max(0, parseFloatParam(search.get('s'), 0));
    const frameId = String(search.get('id') ?? '');
    const loadKey = String(search.get('k') ?? '');

    const layer = useMemo<BackgroundNoiseLayer>(() => {
        return {
            backgroundColor: parseHex(search.get('bg'), '#0a0a14'),
            atmosphereColor: parseHex(search.get('a'), '#1a1a3a'),
            motifColor1: parseHex(search.get('m1'), '#2a1a4a'),
            motifColor2: parseHex(search.get('m2'), '#0a2a3a'),
            noiseSeed: parseIntParam(search.get('n'), 0),
            speedFactor: speed
        };
    }, [search, speed]);

    useEffect(() => {
        hasPostedReadyRef.current = false;
    }, [
        frameId,
        loadKey,
        c,
        r,
        pattern,
        speed,
        layer.backgroundColor,
        layer.atmosphereColor,
        layer.motifColor1,
        layer.motifColor2,
        layer.noiseSeed
    ]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const draw = () => {
            const t = (Date.now() / 1000) * BACKGROUND_T_SPEED * layer.speedFactor;
            if (pattern === 'waves') {
                renderBackgroundWaves(canvas, layer, c, r, t);
            } else if (pattern === 'particle') {
                renderBackgroundParticle(canvas, layer, c, r, t);
            } else {
                renderBackgroundNoise(canvas, layer, c, r, t);
            }

            // Notify parent once when first draw is complete for this frame/config.
            if (!hasPostedReadyRef.current && frameId && loadKey && window.parent !== window) {
                window.parent.postMessage(
                    {
                        type: 'playground:bg_ready',
                        id: frameId,
                        k: loadKey
                    },
                    window.location.origin
                );
                hasPostedReadyRef.current = true;
            }
        };

        draw();
        if (speed <= 0) return;

        const isWave = pattern === 'waves';
        const isParticle = pattern === 'particle';
        const baseTickMs = isWave ? 90 : isParticle ? 85 : BACKGROUND_TICK_MS;
        const minTickMs = isWave ? 50 : isParticle ? 45 : 200;
        const tickMs = Math.max(minTickMs, baseTickMs / Math.max(speed, 0.1));
        const id = setInterval(draw, tickMs);
        return () => clearInterval(id);
    }, [c, layer, pattern, r, speed]);

    return (
        <canvas
            ref={canvasRef}
            width={SCREEN_W}
            height={SCREEN_H}
            style={{
                width: '100vw',
                height: '100vh',
                display: 'block',
                background: layer.backgroundColor
            }}
        />
    );
}
