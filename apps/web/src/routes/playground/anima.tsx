import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { guardPlaygroundDevOnly } from '~/lib/playgroundGuard';

export const Route = createFileRoute('/playground/anima')({
    beforeLoad: guardPlaygroundDevOnly,
    head: () => ({
        meta: [{ title: 'Background Anima Playground · Vizzy Studio' }]
    }),
    component: PlaygroundAnima
});

type BackgroundPattern = 'i-pattern' | 'waves' | 'particle';

const WALL_COLS = 16;
const WALL_ROWS = 4;

function parseIntParam(value: unknown, fallback: number): number {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseFloatParam(value: unknown, fallback: number): number {
    const n = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(n) ? n : fallback;
}

function parsePattern(value: unknown): BackgroundPattern {
    if (value === 'waves' || value === 'particle') return value;
    return 'i-pattern';
}

function parseHex(value: unknown, fallback: string): string {
    const v = String(value ?? '').trim();
    return /^#[0-9a-fA-F]{6,8}$/.test(v) ? v : fallback;
}

function toHex6(value: unknown, fallback: string): string {
    const parsed = parseHex(value, fallback);
    return `#${parsed.replace(/^#/, '').slice(0, 6)}`;
}

function normalizeHex6(value: string): string | null {
    const trimmed = value.trim();
    const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(prefixed)) return null;
    return prefixed.toLowerCase();
}

function clampRow(row: number): number {
    return Math.max(0, Math.min(WALL_ROWS - 1, row));
}

function PlaygroundAnima() {
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const search = useMemo(() => new URLSearchParams(searchStr), [searchStr]);

    const [pattern, setPattern] = useState<BackgroundPattern>(() => parsePattern(search.get('p')));
    const [speed, setSpeed] = useState<number>(() =>
        Math.max(0, parseFloatParam(search.get('s'), 0))
    );
    const [rowOffset, setRowOffset] = useState<number>(() =>
        clampRow(parseIntParam(search.get('r'), 0))
    );
    const [backgroundColor, setBackgroundColor] = useState<string>(() =>
        toHex6(search.get('bg'), '#0a0a14')
    );
    const [atmosphereColor, setAtmosphereColor] = useState<string>(() =>
        toHex6(search.get('a'), '#1a1a3a')
    );
    const [motifColor1, setMotifColor1] = useState<string>(() =>
        toHex6(search.get('m1'), '#2a1a4a')
    );
    const [motifColor2, setMotifColor2] = useState<string>(() =>
        toHex6(search.get('m2'), '#0a2a3a')
    );
    const [seed, setSeed] = useState<number>(() => parseIntParam(search.get('n'), 0));
    const [mountedCount, setMountedCount] = useState(1);
    const [readyCount, setReadyCount] = useState(0);
    const [poppedTileId, setPoppedTileId] = useState<string | null>(null);
    const [isInteracting, setIsInteracting] = useState(false);
    const readyIdsRef = useRef<Set<string>>(new Set());
    const interactionTimerRef = useRef<number | null>(null);

    const loadKey = useMemo(
        () =>
            [
                pattern,
                speed.toFixed(3),
                rowOffset,
                backgroundColor,
                atmosphereColor,
                motifColor1,
                motifColor2,
                seed
            ].join('|'),
        [
            atmosphereColor,
            backgroundColor,
            motifColor1,
            motifColor2,
            pattern,
            rowOffset,
            seed,
            speed
        ]
    );

    const tiles = useMemo(
        () =>
            Array.from({ length: WALL_ROWS * WALL_COLS }, (_, index) => {
                const c = index % WALL_COLS;
                const tileRow = Math.floor(index / WALL_COLS);
                const r = (tileRow + rowOffset) % WALL_ROWS;
                const params = new URLSearchParams({
                    c: String(c),
                    r: String(r),
                    p: pattern,
                    s: String(speed),
                    l: 'gallery',
                    id: `bg-${tileRow}-${c}`,
                    k: loadKey,
                    bg: backgroundColor,
                    a: atmosphereColor,
                    m1: motifColor1,
                    m2: motifColor2,
                    n: String(seed)
                });
                return {
                    id: `bg-${tileRow}-${c}`,
                    label: `c${c} r${r}`,
                    src: `/playground/bg?${params.toString()}`
                };
            }),
        [
            atmosphereColor,
            backgroundColor,
            loadKey,
            motifColor1,
            motifColor2,
            pattern,
            rowOffset,
            seed,
            speed
        ]
    );

    useEffect(() => {
        readyIdsRef.current.clear();
        setReadyCount(0);
        setMountedCount(1);
    }, [loadKey]);

    useEffect(
        () => () => {
            if (interactionTimerRef.current !== null) {
                window.clearTimeout(interactionTimerRef.current);
                interactionTimerRef.current = null;
            }
        },
        []
    );

    const bumpInteraction = () => {
        setIsInteracting(true);
        if (interactionTimerRef.current !== null) {
            window.clearTimeout(interactionTimerRef.current);
        }
        interactionTimerRef.current = window.setTimeout(() => {
            setIsInteracting(false);
            interactionTimerRef.current = null;
        }, 220);
    };

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            const payload = event.data as { type?: string; id?: string; k?: string } | null;
            if (!payload || payload.type !== 'playground:bg_ready') return;
            if (payload.k !== loadKey) return;
            if (!payload.id) return;
            if (readyIdsRef.current.has(payload.id)) return;

            readyIdsRef.current.add(payload.id);
            setReadyCount(readyIdsRef.current.size);

            if (isInteracting) return;

            setMountedCount((current) => {
                const expectedId = tiles[current - 1]?.id;
                if (payload.id !== expectedId) return current;
                return Math.min(current + 1, tiles.length);
            });
        };

        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [isInteracting, loadKey, tiles]);

    useEffect(() => {
        if (isInteracting) return;
        setMountedCount((current) => {
            if (current >= tiles.length) return current;
            const expectedId = tiles[current - 1]?.id;
            if (!expectedId || !readyIdsRef.current.has(expectedId)) return current;
            return Math.min(current + 1, tiles.length);
        });
    }, [isInteracting, tiles]);

    return (
        <main className="min-h-screen bg-background text-foreground">
            <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
                <div className="mb-2 flex items-center justify-between">
                    <h1 className="text-sm font-semibold">Background Anima Playground (16 x 4)</h1>
                    <span className="text-xs text-muted-foreground">
                        {readyCount}/{tiles.length} frames drawn
                    </span>
                </div>

                <div
                    className="grid grid-cols-2 gap-3 md:grid-cols-5 lg:grid-cols-9"
                    onPointerDown={bumpInteraction}
                    onInput={bumpInteraction}
                    onChange={bumpInteraction}
                    onFocus={bumpInteraction}
                >
                    <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Background style</span>
                        <select
                            value={pattern}
                            onChange={(event) =>
                                setPattern(event.target.value as BackgroundPattern)
                            }
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                        >
                            <option value="i-pattern">I pattern</option>
                            <option value="waves">Waves</option>
                            <option value="particle">Particle</option>
                        </select>
                    </label>

                    <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">r (row offset)</span>
                        <input
                            type="number"
                            min={0}
                            max={3}
                            value={rowOffset}
                            onChange={(event) => {
                                const next = clampRow(parseIntParam(event.target.value, 0));
                                setRowOffset(next);
                            }}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                        />
                    </label>

                    <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">s (speed)</span>
                        <input
                            type="number"
                            min={0}
                            max={20}
                            step={0.1}
                            value={speed}
                            onChange={(event) =>
                                setSpeed(Math.max(0, parseFloatParam(event.target.value, 1)))
                            }
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                        />
                    </label>

                    <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Seed</span>
                        <input
                            type="number"
                            min={0}
                            max={9999}
                            value={seed}
                            onChange={(event) => setSeed(parseIntParam(event.target.value, 0))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                        />
                    </label>

                    <ColorControl
                        label="Background"
                        value={backgroundColor}
                        onColorChange={setBackgroundColor}
                    />

                    <ColorControl
                        label="Atmosphere"
                        value={atmosphereColor}
                        onColorChange={setAtmosphereColor}
                    />

                    <ColorControl
                        label="Motif 1"
                        value={motifColor1}
                        onColorChange={setMotifColor1}
                    />

                    <ColorControl
                        label="Motif 2"
                        value={motifColor2}
                        onColorChange={setMotifColor2}
                    />

                    <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Open current config</span>
                        <a
                            href={`/playground/bg?${new URLSearchParams({
                                c: '0',
                                r: String(rowOffset),
                                p: pattern,
                                s: String(speed),
                                l: 'gallery',
                                bg: backgroundColor,
                                a: atmosphereColor,
                                m1: motifColor1,
                                m2: motifColor2,
                                n: String(seed)
                            }).toString()}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex h-8 items-center justify-center rounded-md border border-input bg-background px-2 text-xs"
                        >
                            /playground/bg
                        </a>
                    </label>
                </div>
            </div>

            <div className="overflow-x-auto">
                <div
                    className="grid min-w-[2400px] gap-0"
                    style={{ gridTemplateColumns: `repeat(${WALL_COLS}, minmax(0, 1fr))` }}
                >
                    {tiles.map((tile, index) => (
                        <article
                            key={tile.id}
                            className="group relative overflow-hidden rounded-none border border-black bg-card"
                        >
                            <button
                                type="button"
                                onClick={() =>
                                    setPoppedTileId((prev) => (prev === tile.id ? null : tile.id))
                                }
                                className="absolute top-1 right-1 z-10 cursor-pointer rounded border border-black bg-white/80 px-1 py-0.5 text-[10px] text-black opacity-0 transition-opacity group-hover:opacity-100"
                                title={
                                    poppedTileId === tile.id
                                        ? 'Exit stretched view'
                                        : 'Stretch to full screen'
                                }
                            >
                                {poppedTileId === tile.id ? 'Close' : 'Stretch'}
                            </button>
                            {index < mountedCount ? (
                                <>
                                    <div className="aspect-video w-full" />
                                    <iframe
                                        src={tile.src}
                                        title={tile.label}
                                        className={`border-0 ${
                                            poppedTileId === tile.id
                                                ? 'fixed inset-0 z-80 h-screen w-screen'
                                                : 'absolute inset-0 h-full w-full'
                                        }`}
                                    />
                                    {poppedTileId === tile.id ? (
                                        <button
                                            type="button"
                                            onClick={() => setPoppedTileId(null)}
                                            className="fixed top-2 right-2 z-90 cursor-pointer rounded border border-black bg-white px-2 py-1 text-xs text-black"
                                        >
                                            Close
                                        </button>
                                    ) : null}
                                </>
                            ) : (
                                <div className="aspect-video w-full bg-black" />
                            )}
                        </article>
                    ))}
                </div>
            </div>
        </main>
    );
}

type ColorControlProps = {
    label: string;
    value: string;
    onColorChange: (value: string) => void;
};

function ColorControl({ label, value, onColorChange }: ColorControlProps) {
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    return (
        <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <div className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-1">
                <input
                    type="color"
                    value={value}
                    onChange={(event) => onColorChange(event.target.value)}
                    className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
                />
                <input
                    type="text"
                    value={draft}
                    onChange={(event) => {
                        const next = event.target.value;
                        setDraft(next);
                        const normalized = normalizeHex6(next);
                        if (normalized) onColorChange(normalized);
                    }}
                    onBlur={(event) => {
                        const normalized = normalizeHex6(event.target.value);
                        setDraft(normalized ?? value);
                    }}
                    className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 text-[11px] uppercase outline-none"
                />
            </div>
        </label>
    );
}
