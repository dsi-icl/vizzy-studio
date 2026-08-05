import { describe, expect, test } from 'bun:test';

import * as Y from 'yjs';

import { shouldRebuildYjsFromCommit } from '../../src/server/yjs/yjs.hydration';
import { ReadyDocumentRegistry } from '../../src/server/yjs/yjs.lifecycle';
import { mergeYjsSnapshots } from '../../src/server/yjs/yjs.state';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

describe('Yjs document lifecycle coordination', () => {
    test('does not publish a document until its single-flight hydration finishes', async () => {
        const registry = new ReadyDocumentRegistry<object>();
        const hydration = deferred<object>();
        let creates = 0;
        const create = () => {
            creates += 1;
            return hydration.promise;
        };

        const first = registry.getOrCreate('doc', create);
        const second = registry.getOrCreate('doc', create);

        expect(registry.ready.has('doc')).toBe(false);
        expect(creates).toBe(1);

        const hydrated = {};
        hydration.resolve(hydrated);
        expect(await first).toBe(hydrated);
        expect(await second).toBe(hydrated);
        expect(registry.ready.get('doc')).toBe(hydrated);
    });

    test('quarantines a closing document before a reconnect can resolve it', async () => {
        const registry = new ReadyDocumentRegistry<object>();
        const oldDoc = await registry.getOrCreate('doc', async () => ({}));
        const closeGate = deferred<void>();

        const closing = registry.close('doc', oldDoc, () => closeGate.promise);
        expect(registry.ready.has('doc')).toBe(false);

        let replacementStarted = false;
        const reconnect = registry.getOrCreate('doc', async () => {
            replacementStarted = true;
            return {};
        });
        await Promise.resolve();
        expect(replacementStarted).toBe(false);

        closeGate.resolve();
        await closing;
        const replacement = await reconnect;
        expect(replacement).not.toBe(oldDoc);
        expect(registry.ready.get('doc')).toBe(replacement);
    });
});

describe('Yjs persistence safety', () => {
    test('recovers good commit text from a legacy blank snapshot', () => {
        expect(
            shouldRebuildYjsFromCommit({
                hasPersistedState: true,
                persistedRevision: 0,
                commitRevision: 0,
                persistedIsLegacy: true,
                persistedHtmlIsEmpty: true,
                commitHtmlIsEmpty: false,
                commitTextHash: 'good-text'
            })
        ).toBe(true);
    });

    test('keeps a revisioned collaborative deletion authoritative', () => {
        expect(
            shouldRebuildYjsFromCommit({
                hasPersistedState: true,
                persistedRevision: 7,
                commitRevision: 7,
                persistedIsLegacy: false,
                persistedHtmlIsEmpty: true,
                commitHtmlIsEmpty: true,
                persistedSourceTextHash: 'original-text',
                commitTextHash: 'empty-projection'
            })
        ).toBe(false);
    });

    test('merges divergent collaborator snapshots instead of overwriting one', () => {
        const base = new Y.Doc();
        base.getText('body').insert(0, 'A');
        const baseUpdate = Y.encodeStateAsUpdate(base);

        const first = new Y.Doc();
        const second = new Y.Doc();
        Y.applyUpdate(first, baseUpdate);
        Y.applyUpdate(second, baseUpdate);
        first.getText('body').insert(1, 'B');
        second.getText('body').insert(1, 'C');

        const persistedFirst = mergeYjsSnapshots(baseUpdate, Y.encodeStateAsUpdate(first));
        const persistedBoth = mergeYjsSnapshots(persistedFirst, Y.encodeStateAsUpdate(second));
        const reloaded = new Y.Doc();
        Y.applyUpdate(reloaded, persistedBoth);

        expect(reloaded.getText('body').toJSON()).toContain('A');
        expect(reloaded.getText('body').toJSON()).toContain('B');
        expect(reloaded.getText('body').toJSON()).toContain('C');
    });

    test('can replace the exact corrupt revision selected during hydration', () => {
        const corrupt = new Y.Doc();
        corrupt.getText('body').insert(0, 'stale');
        const recovered = new Y.Doc();
        recovered.getText('body').insert(0, 'database text');

        const update = mergeYjsSnapshots(
            Y.encodeStateAsUpdate(corrupt),
            Y.encodeStateAsUpdate(recovered),
            true
        );
        const reloaded = new Y.Doc();
        Y.applyUpdate(reloaded, update);
        expect(reloaded.getText('body').toJSON()).toBe('database text');
    });

    test('reproduces why reconnects must never receive a destroyed Y.Doc', () => {
        const doc = new Y.Doc();
        let emittedUpdates = 0;
        doc.on('update', () => {
            emittedUpdates += 1;
        });
        doc.destroy();

        doc.getText('body').insert(0, 'silently unpersisted');

        expect(doc.getText('body').toJSON()).toBe('silently unpersisted');
        expect(emittedUpdates).toBe(0);
    });
});
