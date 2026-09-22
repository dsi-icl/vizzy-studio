import { useCallback, useEffect } from 'react';
import type { MapProps } from 'react-map-gl/maplibre';

import { MapWrapper } from '~/components/MapWrapper';
import { removeMapPreview, updateMapPreview } from '~/lib/mapPreviewStore';
import type { LayerWithEditorState } from '~/lib/types';

interface EditorMapOverlayProps {
    layer: Extract<LayerWithEditorState, { type: 'map' }>;
    projectId: string;
    previewKey: string;
    selected: boolean;
    stageScaleFactor: number;
}

export function EditorMapOverlay({
    layer,
    projectId,
    previewKey,
    selected,
    stageScaleFactor
}: EditorMapOverlayProps) {
    const capturePreview = useCallback<NonNullable<MapProps['onIdle']>>(
        (event) => updateMapPreview(previewKey, event.target.getCanvas()),
        [previewKey]
    );
    useEffect(() => () => removeMapPreview(previewKey), [previewKey]);

    const hidden = !layer.config.visible;
    return (
        <div
            style={{
                position: 'absolute',
                left: layer.config.cx * stageScaleFactor,
                top: layer.config.cy * stageScaleFactor,
                width: layer.config.width * stageScaleFactor,
                height: layer.config.height * stageScaleFactor,
                transform: `translate(-50%, -50%) rotate(${layer.config.rotation}deg) scale(${layer.config.scaleX}, ${layer.config.scaleY})`,
                transformOrigin: 'center',
                opacity: hidden ? 0.3 : 1,
                pointerEvents: 'none',
                overflow: 'hidden',
                outline: selected ? '2px solid rgba(0, 161, 255, 0.85)' : undefined,
                zIndex: layer.config.zIndex
            }}
        >
            <MapWrapper
                layer={layer}
                projectId={projectId}
                onIdle={capturePreview}
                style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%'
                }}
            />
        </div>
    );
}
