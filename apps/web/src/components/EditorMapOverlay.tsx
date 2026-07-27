import { MapWrapper } from '~/components/MapWrapper';
import type { LayerWithEditorState } from '~/lib/types';

interface EditorMapOverlayProps {
    layer: Extract<LayerWithEditorState, { type: 'map' }>;
    projectId: string;
    selected: boolean;
    stageScaleFactor: number;
}

export function EditorMapOverlay({
    layer,
    projectId,
    selected,
    stageScaleFactor
}: EditorMapOverlayProps) {
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
                style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%'
                }}
            />
        </div>
    );
}
