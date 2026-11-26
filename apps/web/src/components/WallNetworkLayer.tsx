import { useLayoutEffect, useRef } from 'react';

import { useTextFontRevision } from '~/hooks/useFonts';
import { toCssFilterString } from '~/lib/layerFilters';
import { networkDocumentKey } from '~/lib/network/document';
import { drawNetwork, networkViewport } from '~/lib/network/render';
import type { Layer, LayerPositionState } from '~/lib/types';
import type { Viewport, WallEngine } from '~/lib/wallEngine';

export type NetworkWallRenderer = (position: LayerPositionState, visible: boolean) => void;

export function WallNetworkLayer({
    layer,
    engine,
    viewport,
    pixelRatio,
    renderers
}: {
    layer: Extract<Layer, { type: 'graph' }>;
    engine: WallEngine | null;
    viewport: Viewport;
    pixelRatio: number;
    renderers: Map<number, NetworkWallRenderer>;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const registeredLayer = useRef<{ engine: WallEngine | null; layer: typeof layer } | null>(null);
    const fontRevision = useTextFontRevision();
    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        // Bitmap allocation is screen-sized, never wall-sized.
        const ratio = Math.min(
            Math.max(0.1, pixelRatio),
            8192 / Math.max(viewport.w, viewport.h),
            Math.sqrt(16_000_000 / (viewport.w * viewport.h))
        );
        const bitmapWidth = Math.ceil(viewport.w * ratio);
        const bitmapHeight = Math.ceil(viewport.h * ratio);
        if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
        if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
        let last = '';
        const documentKey = layer.network ? networkDocumentKey(layer.network) : '';
        const draw: NetworkWallRenderer = (pos, visible) => {
            const live = engine?.networkFrames.sample(layer.numericId, documentKey);
            const key = JSON.stringify([pos, visible, live?.token]);
            if (key === last) return;
            last = key;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (!visible || !pos.scaleX || !pos.scaleY) return;
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.translate(pos.cx - viewport.x, pos.cy - viewport.y);
            ctx.rotate((pos.rotation * Math.PI) / 180);
            ctx.scale(pos.scaleX, pos.scaleY);
            ctx.translate(-pos.width / 2, -pos.height / 2);
            drawNetwork(
                ctx,
                layer.network,
                pos.width,
                pos.height,
                networkViewport(pos, viewport),
                live?.view
            );
        };
        const previous = registeredLayer.current;
        const oldNetwork = previous?.layer.network;
        const nextNetwork = layer.network;
        const influenceOnly =
            previous?.engine === engine &&
            previous.layer.numericId === layer.numericId &&
            previous.layer.config === layer.config &&
            oldNetwork &&
            nextNetwork &&
            oldNetwork.data === nextNetwork.data &&
            oldNetwork.settings === nextNetwork.settings &&
            oldNetwork.positions === nextNetwork.positions &&
            oldNetwork.nodeMove === nextNetwork.nodeMove &&
            oldNetwork.reheat === nextNetwork.reheat &&
            oldNetwork.name === nextNetwork.name &&
            oldNetwork.source === nextNetwork.source &&
            oldNetwork.influence !== nextNetwork.influence;
        engine?.registerLayer(layer, canvas, Boolean(influenceOnly));
        registeredLayer.current = { engine, layer };
        renderers.set(layer.numericId, draw);
        draw(layer.config, layer.config.visible);
        return () => {
            renderers.delete(layer.numericId);
        };
    }, [layer, engine, viewport, pixelRatio, renderers, fontRevision]);
    return (
        <canvas
            ref={canvasRef}
            aria-label={layer.network?.name ?? 'Network'}
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: viewport.w,
                height: viewport.h,
                pointerEvents: 'none',
                zIndex: layer.config.zIndex,
                filter: toCssFilterString(layer.config.filters)
            }}
        />
    );
}
