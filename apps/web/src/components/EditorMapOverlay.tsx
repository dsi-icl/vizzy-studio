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

    // Render MapLibre at the displayed resolution, but composite its frames in
    // Konva so maps can appear both above and below the other editor layers.
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
                layer={layer}
                projectId={projectId}
                onIdle={capturePreview}
                onRender={captureFrame}
                style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%'
                }}
            />
        </div>
    );
}
