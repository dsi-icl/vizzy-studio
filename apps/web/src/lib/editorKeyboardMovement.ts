import type { GSMessage, LayerWithEditorState } from './types';

export type EditorArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export interface KeyboardMoveBroadcaster {
    broadcastBinaryMove: (
        numericId: number,
        x: number,
        y: number,
        width: number,
        height: number,
        scaleX: number,
        scaleY: number,
        rotation: number
    ) => unknown;
    sendJSON: (message: GSMessage) => unknown;
}

export function isEditorArrowKey(key: string): key is EditorArrowKey {
    return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

export function applyKeyboardArrowTransform(
    layer: LayerWithEditorState,
    key: EditorArrowKey,
    shiftKey: boolean,
    movementStep: number
): LayerWithEditorState {
    const config = { ...layer.config };

    if (key === 'ArrowLeft') {
        if (shiftKey) config.rotation = Math.round(config.rotation - 1);
        else config.cx -= movementStep;
    } else if (key === 'ArrowRight') {
        if (shiftKey) config.rotation = Math.round(config.rotation + 1);
        else config.cx += movementStep;
    } else if (key === 'ArrowUp') {
        config.cy -= movementStep;
    } else {
        config.cy += movementStep;
    }

    return { ...layer, config };
}

export function broadcastKeyboardLayerTransform(
    broadcaster: KeyboardMoveBroadcaster,
    layer: LayerWithEditorState
): void {
    const { config } = layer;
    broadcaster.broadcastBinaryMove(
        layer.numericId,
        config.cx,
        config.cy,
        config.width,
        config.height,
        config.scaleX,
        config.scaleY,
        config.rotation
    );
    broadcaster.sendJSON({
        type: 'upsert_layer',
        origin: 'editor:keyboard_arrow',
        layer
    });
}
