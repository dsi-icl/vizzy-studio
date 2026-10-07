import { describe, expect, test } from 'bun:test';

import {
    isDeadEntry,
    isNoopEntry,
    pushHistoryEntry,
    resolveHistoryEntry,
    resolvePatch,
    type HistoryEntry
} from './editorHistory';
import type { LayerPatch } from './editorLayerChange';
import type { LayerWithEditorState } from './types';

function shape(numericId: number, cx: number): LayerWithEditorState {
    return {
        numericId,
        type: 'shape',
        shape: 'rectangle',
        fill: '#fff',
        strokeColor: '#000',
        strokeDash: [],
        strokeWidth: 1,
        cornerRadius: 0,
        config: {
            cx,
            cy: 0,
            width: 100,
            height: 100,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 1,
            visible: true
        }
    };
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
        scopeKey: 'p_c_s',
        patches: [{ numericId: 1, before: shape(1, 0), after: shape(1, 10) }],
        selectionBefore: [],
        selectionAfter: ['1'],
        mergeKey: null,
        at: 1000,
        ...overrides
    };
}

const layersOf = (...layers: LayerWithEditorState[]) =>
    new Map(layers.map((layer) => [layer.numericId, layer]));

describe('resolvePatch conflict rules', () => {
    const modified: LayerPatch = { numericId: 1, before: shape(1, 0), after: shape(1, 10) };
    const created: LayerPatch = { numericId: 1, before: null, after: shape(1, 10) };
    const deleted: LayerPatch = { numericId: 1, before: shape(1, 0), after: null };

    test('undoing a move restores the earlier geometry', () => {
        const action = resolvePatch(modified, 'undo', shape(1, 10));
        expect(action.kind).toBe('restore');
        expect(action.kind === 'restore' && action.layer.config.cx).toBe(0);
    });

    test('undoing an edit to a layer a peer deleted is skipped, not resurrected', () => {
        expect(resolvePatch(modified, 'undo', undefined)).toEqual({
            kind: 'skip',
            numericId: 1,
            reason: 'missing'
        });
    });

    test('undoing a delete resurrects the layer even though it is absent', () => {
        const action = resolvePatch(deleted, 'undo', undefined);
        expect(action.kind).toBe('restore');
        expect(action.kind === 'restore' && action.layer.config.cx).toBe(0);
    });

    test('undoing a create removes the layer', () => {
        expect(resolvePatch(created, 'undo', shape(1, 10))).toEqual({
            kind: 'remove',
            numericId: 1
        });
    });

    test('undoing a create a peer already deleted is a no-op', () => {
        expect(resolvePatch(created, 'undo', undefined)).toEqual({
            kind: 'skip',
            numericId: 1,
            reason: 'noop'
        });
    });

    test('redo mirrors undo', () => {
        expect(resolvePatch(created, 'redo', undefined).kind).toBe('restore');
        expect(resolvePatch(deleted, 'redo', shape(1, 0)).kind).toBe('remove');
        expect(resolvePatch(modified, 'redo', undefined).kind).toBe('skip');
    });

    test('a layer already sitting on the target state needs no work', () => {
        expect(resolvePatch(modified, 'undo', shape(1, 0))).toEqual({
            kind: 'skip',
            numericId: 1,
            reason: 'noop'
        });
    });
});

describe('resolveEntry and isDeadEntry', () => {
    const multi = entry({
        patches: [
            { numericId: 1, before: shape(1, 0), after: shape(1, 10) },
            { numericId: 2, before: shape(2, 0), after: shape(2, 10) }
        ]
    });

    test('resolves each patch against the live map independently', () => {
        // A peer deleted layer 2 in the meantime.
        const actions = resolveHistoryEntry(multi, 'undo', layersOf(shape(1, 10)));
        expect(actions[0].kind).toBe('restore');
        expect(actions[1]).toEqual({ kind: 'skip', numericId: 2, reason: 'missing' });
        // Partly applicable, so the entry still counts.
        expect(isDeadEntry(actions)).toBe(false);
    });

    test('an entry whose every layer is gone is dead, so undo moves past it', () => {
        expect(isDeadEntry(resolveHistoryEntry(multi, 'undo', new Map()))).toBe(true);
    });
});

describe('pushHistoryEntry', () => {
    test('pushes an unmergeable entry', () => {
        expect(pushHistoryEntry([], entry())).toHaveLength(1);
    });

    test('ignores an entry with no patches', () => {
        expect(pushHistoryEntry([], entry({ patches: [] }))).toHaveLength(0);
    });

    test('merges a continued gesture, keeping the oldest before', () => {
        const first = entry({
            mergeKey: 'arrow:1',
            patches: [{ numericId: 1, before: shape(1, 0), after: shape(1, 10) }],
            at: 1000
        });
        const second = entry({
            mergeKey: 'arrow:1',
            patches: [{ numericId: 1, before: shape(1, 10), after: shape(1, 20) }],
            at: 1200
        });

        const stack = pushHistoryEntry(pushHistoryEntry([], first), second);

        expect(stack).toHaveLength(1);
        expect(stack[0].patches[0].before?.config.cx).toBe(0);
        expect(stack[0].patches[0].after?.config.cx).toBe(20);
    });

    test('does not merge past the window', () => {
        const first = entry({ mergeKey: 'arrow:1', at: 1000 });
        const second = entry({
            mergeKey: 'arrow:1',
            at: 5000,
            patches: [{ numericId: 1, before: shape(1, 10), after: shape(1, 20) }]
        });
        expect(pushHistoryEntry(pushHistoryEntry([], first), second)).toHaveLength(2);
    });

    test('does not merge across scopes', () => {
        const first = entry({ mergeKey: 'arrow:1', at: 1000 });
        const second = entry({
            mergeKey: 'arrow:1',
            scopeKey: 'p_c_other',
            at: 1100,
            patches: [{ numericId: 1, before: shape(1, 10), after: shape(1, 20) }]
        });
        expect(pushHistoryEntry(pushHistoryEntry([], first), second)).toHaveLength(2);
    });

    test('a null merge key never merges, so each drag is its own step', () => {
        const first = entry({ mergeKey: null, at: 1000 });
        const second = entry({
            mergeKey: null,
            at: 1100,
            patches: [{ numericId: 1, before: shape(1, 10), after: shape(1, 20) }]
        });
        expect(pushHistoryEntry(pushHistoryEntry([], first), second)).toHaveLength(2);
    });

    test('a gesture that returns to where it started leaves no undo step', () => {
        const out = entry({
            mergeKey: 'arrow:1',
            patches: [{ numericId: 1, before: shape(1, 0), after: shape(1, 10) }],
            at: 1000
        });
        const back = entry({
            mergeKey: 'arrow:1',
            patches: [{ numericId: 1, before: shape(1, 10), after: shape(1, 0) }],
            at: 1100
        });
        expect(pushHistoryEntry(pushHistoryEntry([], out), back)).toHaveLength(0);
    });

    test('merging picks up a layer the first entry did not touch', () => {
        const first = entry({
            mergeKey: 'align',
            patches: [{ numericId: 1, before: shape(1, 0), after: shape(1, 10) }],
            at: 1000
        });
        const second = entry({
            mergeKey: 'align',
            patches: [{ numericId: 2, before: shape(2, 0), after: shape(2, 10) }],
            at: 1100
        });
        const stack = pushHistoryEntry(pushHistoryEntry([], first), second);
        expect(stack).toHaveLength(1);
        expect(stack[0].patches.map((p) => p.numericId)).toEqual([1, 2]);
    });

    test('drops the oldest entry past the limit', () => {
        let stack: HistoryEntry[] = [];
        for (let i = 0; i < 5; i++) {
            stack = pushHistoryEntry(
                stack,
                entry({ patches: [{ numericId: i, before: shape(i, 0), after: shape(i, 10) }] }),
                3
            );
        }
        expect(stack).toHaveLength(3);
        expect(stack[0].patches[0].numericId).toBe(2);
    });
});

describe('isNoopEntry', () => {
    test('spots an entry whose sides match', () => {
        const noop = entry({
            patches: [{ numericId: 1, before: shape(1, 0), after: shape(1, 0) }]
        });
        expect(isNoopEntry(noop)).toBe(true);
        expect(isNoopEntry(entry())).toBe(false);
    });
});

describe('undo never rewrites text content', () => {
    function text(numericId: number, cx: number, html: string): LayerWithEditorState {
        return {
            numericId,
            type: 'text',
            textHtml: html,
            textState: `state:${html}`,
            textFormat: 1,
            config: {
                cx,
                cy: 0,
                width: 200,
                height: 100,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 1,
                visible: true
            }
        };
    }

    test('undoing a move made before the author typed keeps the new wording', () => {
        // Recorded when the layer still said "New Text"; the author has since
        // typed "Hello", which lives in the Yjs document.
        const moved: LayerPatch = {
            numericId: 1,
            before: text(1, 0, 'New Text'),
            after: text(1, 500, 'New Text')
        };
        const live = text(1, 500, 'Hello');

        const action = resolvePatch(moved, 'undo', live);

        expect(action.kind).toBe('restore');
        if (action.kind !== 'restore') return;
        expect(action.layer.config.cx).toBe(0);
        expect(action.layer.type === 'text' && action.layer.textHtml).toBe('Hello');
        expect(action.layer.type === 'text' && action.layer.textState).toBe('state:Hello');
    });

    test('resurrecting a deleted layer uses the text from its patch', () => {
        const removed: LayerPatch = {
            numericId: 1,
            before: text(1, 0, 'Hello'),
            after: null
        };

        const action = resolvePatch(removed, 'undo', undefined);

        expect(action.kind).toBe('restore');
        expect(
            action.kind === 'restore' && action.layer.type === 'text' && action.layer.textHtml
        ).toBe('Hello');
    });

    test('a patch whose only remaining difference is text is a no-op', () => {
        const contentOnly: LayerPatch = {
            numericId: 1,
            before: text(1, 0, 'New Text'),
            after: text(1, 0, 'New Text')
        };

        expect(resolvePatch(contentOnly, 'undo', text(1, 0, 'Hello'))).toEqual({
            kind: 'skip',
            numericId: 1,
            reason: 'noop'
        });
    });
});
