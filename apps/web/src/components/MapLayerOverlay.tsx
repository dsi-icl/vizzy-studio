'use client';

import { MapWrapper } from '~/components/MapWrapper';
import type { LayerWithEditorState } from '~/lib/types';

type MapLayer = Extract<LayerWithEditorState, { type: 'map' }>;

export function MapLayerOverlay({
    layer,
    stageScaleFactor,
    opacity = 1,
    outline
}: {
    layer: MapLayer;
    stageScaleFactor: number;
    opacity?: number;
    outline?: string;
}) {
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
                opacity,
                pointerEvents: 'none',
                overflow: 'hidden',
                outline,
                zIndex: layer.config.zIndex
            }}
        >
            <MapWrapper
                layer={layer}
                style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%'
                }}
            />
        </div>
    );
}
