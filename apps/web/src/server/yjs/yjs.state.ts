import * as Y from 'yjs';

/** Merge state-based Yjs updates without allowing last-writer-wins data loss. */
export function mergeYjsSnapshots(
    current: Uint8Array | null,
    proposed: Uint8Array,
    replaceCurrent = false
): Uint8Array {
    const mergedDoc = new Y.Doc();
    try {
        if (current && !replaceCurrent) Y.applyUpdate(mergedDoc, current);
        Y.applyUpdate(mergedDoc, proposed);
        return Y.encodeStateAsUpdate(mergedDoc);
    } finally {
        mergedDoc.destroy();
    }
}
