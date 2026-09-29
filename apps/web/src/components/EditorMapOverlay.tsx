import { useCallback, useEffect } from 'react';
import type { MapProps } from 'react-map-gl/maplibre';

import { MapWrapper } from '~/components/MapWrapper';
import { removeMapPreview, updateMapCanvas, updateMapPreview } from '~/lib/mapPreviewStore';
import type { LayerWithEditorState } from '~/lib/types';

interface EditorMapOverlayProps {
    layer: Extract<LayerWithEditorState, { type: 'map' }>;
    projectId: string;
    previewKey: string;
    stageScaleFactor: number;
}

export function EditorMapOverlay({
    layer,
    projectId,
    previewKey,
    stageScaleFactor
}: EditorMapOverlayProps) {
    const captureFrame = useCallback<NonNullable<MapProps['onRender']>>(
        (event) => updateMapCanvas(previewKey, event.target.getCanvas()),
        [previewKey]
    );
    const capturePreview = useCallback<NonNullable<MapProps['onIdle']>>(
        (event) => updateMapPreview(previewKey, event.target.getCanvas()),
        [previewKey]
    );
    useEffect(() => () => removeMapPreview(previewKey), [previewKey]);

    // Preserve the original editor framing until EditorSlate saves its reference
    // scale. Subsequent preview resizing changes resolution, not the map's view.
    const authoredLayer = {
        ...layer,
        viewportScale: layer.viewportScale ?? stageScaleFactor
    };
    const pixelRatio = Math.max(
        stageScaleFactor * (typeof window === 'undefined' ? 1 : window.devicePixelRatio),
        1 / Math.max(1, Math.min(layer.config.width, layer.config.height))
    );
    return (
        <div
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: layer.config.width * stageScaleFactor,
                height: layer.config.height * stageScaleFactor,
                opacity: 0,
                pointerEvents: 'none',
                overflow: 'hidden'
            }}
        >
            <MapWrapper
                layer={authoredLayer}
                projectId={projectId}
                onIdle={capturePreview}
                onRender={captureFrame}
                pixelRatio={pixelRatio}
                style={{
                    position: 'relative',
                    width: layer.config.width,
                    height: layer.config.height,
                    transform: `scale(${stageScaleFactor})`,
                    transformOrigin: 'top left'
                }}
            />
        </div>
    );
}
