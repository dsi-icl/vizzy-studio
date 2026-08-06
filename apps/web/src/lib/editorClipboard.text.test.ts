import { describe, expect, test } from 'bun:test';

import { createPastedLayers, LAYER_PASTE_OFFSET, snapshotCopyableLayers } from './editorClipboard';
import { TEXT_FORMAT_VERSION, type LayerWithEditorState } from './types';

const config = {
    cx: 10,
    cy: 20,
    width: 640,
    height: 95,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    visible: true
};

const STYLED_HTML =
    '<p><span style="color: #ef4444; font-size: 2em; white-space: pre-wrap;">Red big</span></p>';
const STYLED_STATE = JSON.stringify({ root: { children: [{ type: 'paragraph' }] } });

function textLayer(overrides: Partial<LayerWithEditorState> = {}): LayerWithEditorState {
    return {
        numericId: 1,
        type: 'text',
        config,
        textHtml: STYLED_HTML,
        ...overrides
    } as LayerWithEditorState;
}

function paste(layer: LayerWithEditorState) {
    let nextId = 100;
    let nextZ = 50;
    return createPastedLayers(
        [layer],
        1,
        () => nextId++,
        () => nextZ++
    )[0];
}

describe('pasting a text layer', () => {
    test('carries the styled HTML unchanged', () => {
        const pasted = paste(textLayer());
        expect(pasted.type === 'text' && pasted.textHtml).toBe(STYLED_HTML);
    });

    test('carries structured state and its format stamp', () => {
        const pasted = paste(
            textLayer({ textState: STYLED_STATE, textFormat: TEXT_FORMAT_VERSION } as never)
        );
        expect(pasted.type === 'text' && pasted.textState).toBe(STYLED_STATE);
        expect(pasted.type === 'text' && pasted.textFormat).toBe(TEXT_FORMAT_VERSION);
    });

    test('a legacy layer without structured state stays legacy', () => {
        const pasted = paste(textLayer());
        expect(pasted.type === 'text' && pasted.textState).toBeUndefined();
        expect(pasted.type === 'text' && pasted.textFormat).toBeUndefined();
    });

    test('takes a fresh identity and offset position', () => {
        const pasted = paste(textLayer({ textState: STYLED_STATE } as never));
        expect(pasted.numericId).not.toBe(1);
        expect(pasted.config.cx).toBe(10 + LAYER_PASTE_OFFSET);
        expect(pasted.config.cy).toBe(20 + LAYER_PASTE_OFFSET);
    });

    test('does not alias the source state', () => {
        const source = textLayer({ textState: STYLED_STATE } as never);
        const pasted = paste(source);
        if (pasted.type !== 'text' || source.type !== 'text') throw new Error('expected text');
        pasted.textHtml = '<p>changed</p>';
        expect(source.textHtml).toBe(STYLED_HTML);
    });

    test('an uploading layer is excluded from a copy snapshot', () => {
        const snapshot = snapshotCopyableLayers([
            textLayer(),
            textLayer({ numericId: 2, isUploading: true })
        ]);
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].numericId).toBe(1);
    });
});
