import type { ChangeStreamDocument } from 'mongodb';

import { dbCol } from '~/server/collections';

import { broadcastAssetToEditorsByProject } from './busState.broadcast';

export { broadcastAssetToEditorsByProject };

// Re-export here so callers that used to import from busState still resolve correctly.
// The implementation lives in broadcast.ts to keep asset-specific logic separate.
// (busState.broadcast already exports it; this file is the canonical module for assets.)

function startAssetChangeStream() {
    try {
        const changeStream = dbCol.assets.watch(
            [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }],
            {
                fullDocument: 'updateLookup'
            }
        );

        changeStream.on('change', (change: ChangeStreamDocument) => {
            if ('fullDocument' in change && change.fullDocument) {
                const rawAsset = change.fullDocument;
                if (rawAsset.hidden || rawAsset.deletedAt != null) return;
                // asset_added is the existing resource-list invalidation signal.
                // Reuse it for tile status updates; never upsert a layer here.
                if (change.operationType !== 'insert' && !rawAsset.deepZoom) return;
                broadcastAssetToEditorsByProject(String(rawAsset.projectId), {
                    id: String(rawAsset._id),
                    name: rawAsset.name,
                    url: rawAsset.url,
                    size: rawAsset.size,
                    // Convert null > undefined so JSON.stringify strips them
                    // (Zod z.string().optional() rejects null)
                    mimeType: rawAsset.mimeType ?? undefined,
                    blurhash: rawAsset.blurhash ?? undefined,
                    previewUrl: rawAsset.previewUrl ?? undefined,
                    deepZoom: rawAsset.deepZoom,
                    sizes: rawAsset.sizes ?? undefined,
                    createdAt: String(rawAsset.createdAt),
                    createdBy: String(rawAsset.createdBy)
                });
            }
        });

        changeStream.on('error', (err: unknown) => {
            console.error('[Bus] Asset change stream error:', err);
        });

        console.log('[Bus] Asset change stream started');
        return changeStream;
    } catch (err) {
        console.error('[Bus] Failed to start asset change stream:', err);
        return null;
    }
}

// HMR-safe: only start once
if (!(process as any).__ASSET_CHANGE_STREAM__) {
    (process as any).__ASSET_CHANGE_STREAM__ = startAssetChangeStream();
}
