import { config, z } from 'zod';

// This schema is consumed by browser bundles as well as the database layer.
// Keep Zod from probing eval/new Function under the application's CSP.
config({ jitless: true });

export const DEFAULT_STAGE_LAYOUT = {
    columns: 16,
    rows: 4,
    screenWidth: 1920,
    screenHeight: 1080
} as const;

export const StageLayout = z.object({
    columns: z.int().positive(),
    rows: z.int().positive(),
    screenWidth: z.int().positive(),
    screenHeight: z.int().positive()
});
export type StageLayout = z.infer<typeof StageLayout>;

export function stageLayoutKey(layout: StageLayout): string {
    return `${layout.columns}x${layout.rows}@${layout.screenWidth}x${layout.screenHeight}`;
}

export function stageLayoutsEqual(left: StageLayout, right: StageLayout): boolean {
    return stageLayoutKey(left) === stageLayoutKey(right);
}

export const ProjectStage = z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    order: z.number().int().nonnegative(),
    layout: StageLayout,
    headCommitId: z.string().nullable(),
    publishedCommitId: z.string().nullable(),
    archivedAt: z.number().nullable().optional()
});
export type ProjectStage = z.infer<typeof ProjectStage>;

export const CollaboratorRole = z.enum(['owner', 'editor', 'viewer']);
export type CollaboratorRole = z.infer<typeof CollaboratorRole>;

export const Collaborator = z.object({
    email: z.email(),
    role: CollaboratorRole
});
export type Collaborator = z.infer<typeof Collaborator>;

export const ProjectVisibility = z.enum(['public', 'private']);
export type ProjectVisibility = z.infer<typeof ProjectVisibility>;

export const SignageCollaborator = z.object({
    email: z.email(),
    role: z.enum(['viewer', 'editor'])
});

export const SignageSlideEntry = z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    slideId: z.string().min(1),
    displayDurationMs: z.int().positive().optional(),
    gapDurationMs: z.int().nonnegative().optional()
});

// Only new Deep Zoom images carry these fields. Absence keeps the existing
// image path; reading an old asset must never infer or backfill this metadata.
const ImageDeepZoomDimensions = z.object({
    schemaVersion: z.literal(1),
    width: z.int().positive(),
    height: z.int().positive()
});

export const ImageTileSource = z.object({
    // Identifies immutable content, including its version. Reprocessing must
    // publish a new sourceId so saved layers/commits retain their old content.
    sourceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    tileSize: z.literal(512),
    maxZoom: z.int().nonnegative(),
    format: z.literal('webp')
});
export type ImageTileSource = z.infer<typeof ImageTileSource>;

export const ImageDeepZoomAsset = z.discriminatedUnion('status', [
    ImageDeepZoomDimensions.extend({ status: z.enum(['queued', 'processing']) }),
    ImageDeepZoomDimensions.extend({ status: z.literal('ready'), tiles: ImageTileSource }),
    ImageDeepZoomDimensions.extend({ status: z.literal('failed'), error: z.string().min(1) })
]);
export type ImageDeepZoomAsset = z.infer<typeof ImageDeepZoomAsset>;

// A layer carries only a ready snapshot, never job status. Its existing `url`
// continues to identify the original asset; config still owns all transforms.
export const ImageDeepZoomLayer = ImageDeepZoomDimensions.extend({
    assetId: z.string().min(1),
    previewUrl: z.string().min(1),
    tiles: ImageTileSource
});
export type ImageDeepZoomLayer = z.infer<typeof ImageDeepZoomLayer>;
