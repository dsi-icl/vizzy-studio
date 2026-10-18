import type { ImageDeepZoomLayer } from '@repo/db/schema';
import { useEffect, useRef } from 'react';

import { ImageTileController, clippedViewport, observeImageTileView } from '~/lib/imageTiles';

/** The parent owns placement, transforms, opacity, filters and z-order. */
export function TiledImage({
    image,
    onReady
}: {
    image: ImageDeepZoomLayer;
    onReady?: () => void;
}) {
    const svgRef = useRef<SVGSVGElement>(null);
    const areaRef = useRef<SVGForeignObjectElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const onReadyRef = useRef(onReady);
    const settledRef = useRef(false);
    const sourceKey = JSON.stringify(image);
    useEffect(() => {
        onReadyRef.current = onReady;
        if (settledRef.current) onReady?.();
    }, [onReady]);
    useEffect(() => {
        const svg = svgRef.current,
            area = areaRef.current,
            canvas = canvasRef.current;
        if (!svg || !area || !canvas) return;
        settledRef.current = false;
        const source = JSON.parse(sourceKey) as ImageDeepZoomLayer;
        const settled = () => {
            settledRef.current = true;
            onReadyRef.current?.();
        };
        const controller = new ImageTileController(
            source,
            canvas,
            (frame) => {
                svg.dataset.tilesReady = String(Boolean(frame?.ready));
                area.style.display = frame ? '' : 'none';
                if (!frame) return;
                area.setAttribute('x', String(frame.x));
                area.setAttribute('y', String(frame.y));
                area.setAttribute('width', String(frame.width));
                area.setAttribute('height', String(frame.height));
                if (frame.ready) settled();
            },
            settled
        );
        const stop = observeImageTileView(
            () => {
                const matrix = svg.getScreenCTM();
                if (!matrix || !svg.isConnected) return null;
                return {
                    matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
                    viewport: clippedViewport(svg),
                    pixelRatio: window.devicePixelRatio || 1
                };
            },
            (view) => controller.update(view)
        );
        return () => {
            stop();
            controller.dispose();
            settledRef.current = false;
        };
    }, [sourceKey]);
    return (
        <svg
            ref={svgRef}
            data-tiled-image={image.assetId}
            data-tile-source={image.tiles.sourceId}
            viewBox={`0 0 ${image.width} ${image.height}`}
            preserveAspectRatio="none"
            width="100%"
            height="100%"
            aria-hidden="true"
            style={{ display: 'block', overflow: 'hidden', pointerEvents: 'none' }}
        >
            <foreignObject ref={areaRef} width="0" height="0" pointerEvents="none">
                <canvas
                    ref={canvasRef}
                    data-tile-mosaic=""
                    style={{ display: 'block', width: '100%', height: '100%' }}
                />
            </foreignObject>
        </svg>
    );
}
