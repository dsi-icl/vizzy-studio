import {
    ArrowsClockwiseIcon,
    ArrowsInIcon,
    ArrowsOutSimpleIcon,
    ArrowSquareOutIcon,
    PlugsConnectedIcon,
    PlugsIcon
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { guardPlaygroundDevOnly } from '~/lib/playgroundGuard';

type WallScreen = {
    id: string;
    c: number;
    r: number;
    label: string;
};

type FramePanel = {
    id: string;
    label: string;
    path: string;
};

type FrameControlState = {
    disconnectedById: Record<string, boolean>;
    refreshNonceById: Record<string, number>;
    wallParamById: Record<string, string>;
};

const NATIVE_PREVIEW_WIDTH = 1920;
const NATIVE_PREVIEW_HEIGHT = 1080;

export const Route = createFileRoute('/playground/')({
    beforeLoad: guardPlaygroundDevOnly,
    head: () => ({
        meta: [{ title: 'Playground · Vizzy Studio' }]
    }),
    component: HomePage
});

function HomePage() {
    const wallScreens = useMemo<WallScreen[]>(
        () =>
            Array.from({ length: 4 }, (_, index) => {
                const c = index % 2;
                const r = Math.floor(index / 2);
                return {
                    id: `wall-${r}-${c}`,
                    c,
                    r,
                    label: `Wall c${c} r${r}`
                };
            }),
        []
    );

    const controlPanels = useMemo<FramePanel[]>(
        () => [
            { id: 'controller-a', label: 'Controller #1', path: '/controller' },
            { id: 'controller-b', label: 'Controller #2', path: '/controller' }
        ],
        []
    );
    const galleryPanels = useMemo<FramePanel[]>(
        () => [
            { id: 'gallery-a', label: 'Gallery #1', path: '/gallery' },
            { id: 'gallery-b', label: 'Gallery #2', path: '/gallery' }
        ],
        []
    );

    const allFrameIds = useMemo(
        () => [...wallScreens, ...controlPanels, ...galleryPanels].map((item) => item.id),
        [wallScreens, controlPanels, galleryPanels]
    );

    const [frameState, setFrameState] = useState<FrameControlState>(() => ({
        disconnectedById: {
            'controller-b': true,
            'gallery-b': true
        },
        refreshNonceById: {},
        wallParamById: allFrameIds.reduce<Record<string, string>>((acc, id) => {
            acc[id] = 'playground-wall';
            return acc;
        }, {})
    }));
    const [poppedFrameId, setPoppedFrameId] = useState<string | null>(null);

    const toggleDisconnect = (id: string) => {
        setFrameState((prev) => ({
            ...prev,
            disconnectedById: {
                ...prev.disconnectedById,
                [id]: !prev.disconnectedById[id]
            }
        }));
    };

    const refreshFrame = (id: string) => {
        setFrameState((prev) => ({
            ...prev,
            refreshNonceById: {
                ...prev.refreshNonceById,
                [id]: (prev.refreshNonceById[id] ?? 0) + 1
            }
        }));
    };

    const updateWallParam = (id: string, value: string) => {
        setFrameState((prev) => ({
            ...prev,
            wallParamById: {
                ...prev.wallParamById,
                [id]: value
            }
        }));
    };

    const buildPlayableSrc = useCallback(
        (frame: { id: string; path: string } & Partial<Pick<WallScreen, 'c' | 'r'>>) => {
            const nonce = frameState.refreshNonceById[frame.id] ?? 0;
            const disconnected = frameState.disconnectedById[frame.id] ?? false;

            if (disconnected) return `/playground/noop?v=${nonce}`;

            const search = new URLSearchParams({ v: String(nonce) });
            const wallParam = frameState.wallParamById[frame.id]?.trim();
            if (wallParam) search.set('w', wallParam);

            if (typeof frame.c === 'number' && typeof frame.r === 'number') {
                search.set('m', 'dev');
                search.set('c', String(frame.c));
                search.set('r', String(frame.r));
            }

            return `${frame.path}?${search.toString()}`;
        },
        [frameState]
    );

    return (
        <article className="fixed top-0 right-0 bottom-0 left-0 z-70 flex w-full flex-col gap-4 overflow-hidden bg-background px-4 py-4 text-foreground">
            {poppedFrameId ? (
                <button
                    type="button"
                    onClick={() => setPoppedFrameId(null)}
                    className="fixed inset-0 z-80 bg-black/70"
                    aria-label="Close popped preview"
                />
            ) : null}

            <header className="shrink-0 rounded-xl border border-border bg-card px-4 py-3">
                <h1 className="text-sm font-semibold">Vizzy Studio Testing Playground</h1>
            </header>

            <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
                <div className="grid min-h-0 grid-rows-2 gap-4 overflow-hidden">
                    <PanelSection
                        title="Controllers"
                        bodyClassName="grid min-h-0 flex-1 grid-cols-2 gap-3"
                    >
                        {controlPanels.map((panel) => (
                            <ControllableIframeCard
                                key={panel.id}
                                label={panel.label}
                                src={buildPlayableSrc(panel)}
                                disconnected={frameState.disconnectedById[panel.id] ?? false}
                                wallParam={frameState.wallParamById[panel.id] ?? ''}
                                onWallParamChange={(value) => updateWallParam(panel.id, value)}
                                onToggleDisconnect={() => toggleDisconnect(panel.id)}
                                onRefresh={() => refreshFrame(panel.id)}
                                popped={poppedFrameId === panel.id}
                                onTogglePop={() =>
                                    setPoppedFrameId((prev) =>
                                        prev === panel.id ? null : panel.id
                                    )
                                }
                                compact
                            />
                        ))}
                    </PanelSection>

                    <PanelSection
                        title="Galleries"
                        bodyClassName="grid min-h-0 flex-1 grid-cols-2 gap-3"
                    >
                        {galleryPanels.map((panel) => (
                            <ControllableIframeCard
                                key={panel.id}
                                label={panel.label}
                                src={buildPlayableSrc(panel)}
                                disconnected={frameState.disconnectedById[panel.id] ?? false}
                                wallParam={frameState.wallParamById[panel.id] ?? ''}
                                onWallParamChange={(value) => updateWallParam(panel.id, value)}
                                onToggleDisconnect={() => toggleDisconnect(panel.id)}
                                onRefresh={() => refreshFrame(panel.id)}
                                popped={poppedFrameId === panel.id}
                                onTogglePop={() =>
                                    setPoppedFrameId((prev) =>
                                        prev === panel.id ? null : panel.id
                                    )
                                }
                                compact
                            />
                        ))}
                    </PanelSection>
                </div>

                <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-muted p-3">
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-sm font-medium text-foreground">
                            Wall Previews (2 x 2)
                        </h2>
                        <span className="rounded-full bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground">
                            /wall
                        </span>
                    </div>

                    <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
                        {wallScreens.map((screen) => (
                            <ControllableIframeCard
                                key={screen.id}
                                label={screen.label}
                                src={buildPlayableSrc({ ...screen, path: '/wall' })}
                                disconnected={frameState.disconnectedById[screen.id] ?? false}
                                wallParam={frameState.wallParamById[screen.id] ?? ''}
                                onWallParamChange={(value) => updateWallParam(screen.id, value)}
                                onToggleDisconnect={() => toggleDisconnect(screen.id)}
                                onRefresh={() => refreshFrame(screen.id)}
                                popped={poppedFrameId === screen.id}
                                onTogglePop={() =>
                                    setPoppedFrameId((prev) =>
                                        prev === screen.id ? null : screen.id
                                    )
                                }
                                compact
                            />
                        ))}
                    </div>
                </div>
            </section>
        </article>
    );
}

type PanelSectionProps = {
    title: string;
    children: ReactNode;
    bodyClassName?: string;
};

function PanelSection({ title, children, bodyClassName }: PanelSectionProps) {
    return (
        <section className="flex min-h-0 flex-col rounded-lg border border-border bg-muted p-3">
            <h2 className="mb-2 shrink-0 text-sm font-medium text-card-foreground">{title}</h2>
            <div className={bodyClassName ?? 'grid min-h-0 flex-1 grid-cols-1 gap-3'}>
                {children}
            </div>
        </section>
    );
}

type ControllableIframeCardProps = {
    label: string;
    src: string;
    disconnected: boolean;
    wallParam: string;
    onWallParamChange: (value: string) => void;
    onToggleDisconnect: () => void;
    onRefresh: () => void;
    popped: boolean;
    onTogglePop: () => void;
    compact?: boolean;
};

function ControllableIframeCard({
    label,
    src,
    disconnected,
    wallParam,
    onWallParamChange,
    onToggleDisconnect,
    onRefresh,
    popped,
    onTogglePop,
    compact = false
}: ControllableIframeCardProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [scale, setScale] = useState(1);

    useEffect(() => {
        const node = containerRef.current;
        if (!node) return;

        const updateScale = () => {
            const widthScale = node.clientWidth / NATIVE_PREVIEW_WIDTH;
            const heightScale = node.clientHeight / NATIVE_PREVIEW_HEIGHT;
            setScale(Math.min(widthScale, heightScale));
        };

        updateScale();

        const observer = new ResizeObserver(updateScale);
        observer.observe(node);

        return () => observer.disconnect();
    }, []);

    return (
        <article
            className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card ${
                popped ? 'fixed inset-4 z-90 shadow-2xl' : ''
            }`}
        >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-2 text-[11px] font-medium text-muted-foreground">
                <span className="text-card-foreground">{label}</span>

                <div className="flex items-center gap-1">
                    <label className="rounded-md border border-border bg-background px-2 py-1">
                        <span className="mr-1 text-[10px] text-muted-foreground">w</span>
                        <input
                            value={wallParam}
                            onChange={(event) => onWallParamChange(event.target.value)}
                            className={`${compact ? 'w-20' : 'w-26'} border-0 bg-transparent p-0 text-[11px] text-foreground outline-none`}
                            aria-label={`${label} wall id`}
                            placeholder="wall id"
                        />
                    </label>

                    <button
                        type="button"
                        onClick={onTogglePop}
                        className="cursor-pointer rounded-md border border-border bg-background p-1 text-foreground"
                        aria-label={popped ? 'Close larger preview' : 'Pop into larger preview'}
                        title={popped ? 'Close larger preview' : 'Pop into larger preview'}
                    >
                        {popped ? (
                            <ArrowsInIcon size={12} weight="duotone" />
                        ) : (
                            <ArrowsOutSimpleIcon size={12} weight="duotone" />
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}
                        className="cursor-pointer rounded-md border border-border bg-background p-1 text-foreground"
                        aria-label="Open iframe in new tab"
                        title="Open iframe in new tab"
                    >
                        <ArrowSquareOutIcon size={12} weight="duotone" />
                    </button>
                    <button
                        type="button"
                        onClick={onToggleDisconnect}
                        className="cursor-pointer rounded-md border border-border bg-background p-1 text-foreground"
                        aria-label={disconnected ? 'Reconnect iframe' : 'Disconnect iframe'}
                        title={disconnected ? 'Reconnect iframe' : 'Disconnect iframe'}
                    >
                        {disconnected ? (
                            <PlugsConnectedIcon size={12} weight="duotone" />
                        ) : (
                            <PlugsIcon size={12} weight="duotone" />
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={onRefresh}
                        className="cursor-pointer rounded-md border border-border bg-background p-1 text-foreground"
                        aria-label="Refresh iframe"
                        title="Refresh iframe"
                    >
                        <ArrowsClockwiseIcon size={12} weight="duotone" />
                    </button>
                </div>
            </div>

            <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
                <iframe
                    src={src}
                    title={label}
                    className="h-[1080px] w-[1920px] origin-top-left border-0"
                    style={{ transform: `scale(${scale})` }}
                />
            </div>
        </article>
    );
}
