import { z } from '~/lib/zod';

// ── Layer schemas ────────────────────────────────────────────────────────────

const LayerPositionStateSchema = z.object({
    cx: z.number(),
    cy: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number(),
    scaleX: z.number(),
    scaleY: z.number()
});

export type LayerPositionState = z.infer<typeof LayerPositionStateSchema>;

const LayerFilterStateSchema = z.object({
    enabled: z.boolean().default(false),
    grayscale: z.boolean().default(false),
    invert: z.boolean().default(false),
    brightness: z.number().default(100),
    contrast: z.number().default(100),
    hueRotate: z.number().default(0),
    saturation: z.number().default(100),
    blur: z.number().default(0)
});

export type LayerFilterState = z.infer<typeof LayerFilterStateSchema>;

const LayerConfigStateSchema = z
    .object({
        zIndex: z.number(),
        visible: z.boolean().default(true),
        filters: LayerFilterStateSchema.optional()
    })
    .extend(LayerPositionStateSchema.shape);

const LayerPlaybackStateSchema = z.object({
    status: z.enum(['playing', 'paused']),
    anchorMediaTime: z.number(),
    anchorServerTime: z.number()
});

const LayerBaseSchema = z.object({ numericId: z.number(), config: LayerConfigStateSchema });

// Legacy commits may store variant metadata in inconsistent shapes.
// Normalize any non-array or non-numeric values to undefined.
const OptionalSizesSchema = z
    .preprocess((value) => {
        if (!Array.isArray(value)) return undefined;
        const numericSizes = value.filter((size): size is number => typeof size === 'number');
        return numericSizes.length > 0 ? numericSizes : undefined;
    }, z.array(z.number()))
    .optional();

const LayerSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('video'),
            url: z.string(),
            stillImage: z.string().optional(),
            loop: z.boolean(),
            duration: z.number(),
            rvfcActive: z.boolean(),
            blurhash: z.string().optional(),
            playback: LayerPlaybackStateSchema
        })
        .extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('image'),
            url: z.string(),
            blurhash: z.string().optional()
        })
        .extend(LayerBaseSchema.shape),
    z.object({ type: z.literal('graph') }).extend(LayerBaseSchema.shape),
    z.object({ type: z.literal('text'), textHtml: z.string() }).extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('map'),
            view: z.object({
                latitude: z.number(),
                longitude: z.number(),
                zoom: z.number(),
                bearing: z.number(),
                pitch: z.number()
            })
        })
        .extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('web'),
            url: z.string(),
            proxy: z.boolean().optional(),
            scale: z.number().default(1),
            stillImage: z.string().optional(),
            stillImageSizes: OptionalSizesSchema,
            blurhash: z.string().optional()
        })
        .extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('line'),
            line: z.array(z.number()),
            strokeColor: z.string(),
            strokeDash: z.array(z.number()),
            strokeWidth: z.number()
        })
        .extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('shape'),
            shape: z.enum(['rectangle', 'circle']),
            fill: z.string(),
            strokeColor: z.string(),
            strokeDash: z.array(z.number()),
            strokeWidth: z.number()
        })
        .extend(LayerBaseSchema.shape),
    z
        .object({
            type: z.literal('background'),
            backgroundType: z
                .enum(['solid', 'i-pattern', 'waves', 'particle'])
                .default('i-pattern'),
            backgroundColor: z.string().default('#0a0a14'),
            atmosphereColor: z.string().default('#1a1a3a'),
            motifColor1: z.string().default('#2a1a4a'),
            motifColor2: z.string().default('#0a2a3a'),
            noiseSeed: z.number().default(0),
            speedFactor: z.number().default(1)
        })
        .extend(LayerBaseSchema.shape)
]);

export type Layer = z.infer<typeof LayerSchema>;

// ── Hello schema (exported separately for handshake-only validation) ─────────

const HelloMessageBaseSchema = z.object({ type: z.literal('hello') });

export const HelloSchema = z.discriminatedUnion('specimen', [
    HelloMessageBaseSchema.extend({
        specimen: z.literal('wall'),
        wallId: z.string(),
        col: z.number(),
        row: z.number(),
        devicePublicKey: z.string().optional()
    }),
    HelloMessageBaseSchema.extend({
        specimen: z.literal('controller'),
        wallId: z.string(),
        devicePublicKey: z.string().optional()
    }),
    HelloMessageBaseSchema.extend({
        specimen: z.literal('editor')
    }),
    HelloMessageBaseSchema.extend({
        specimen: z.literal('gallery'),
        wallId: z.string().optional(),
        devicePublicKey: z.string().optional()
    })
]);

// ── Full message schema (kept for diagnostics fallback & client-side use) ────

export const GSMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('server_hello'),
        commit: z.string(),
        builtAt: z.string()
    }),
    z.discriminatedUnion('specimen', [
        HelloMessageBaseSchema.extend({
            type: z.literal('hello'),
            specimen: z.literal('wall'),
            wallId: z.string(),
            col: z.number(),
            row: z.number(),
            devicePublicKey: z.string().optional()
        }),
        HelloMessageBaseSchema.extend({
            type: z.literal('hello'),
            specimen: z.literal('controller'),
            wallId: z.string(),
            devicePublicKey: z.string().optional()
        }),
        HelloMessageBaseSchema.extend({
            type: z.literal('hello'),
            specimen: z.literal('editor')
        }),
        HelloMessageBaseSchema.extend({
            type: z.literal('hello'),
            specimen: z.literal('gallery'),
            wallId: z.string().optional(),
            devicePublicKey: z.string().optional()
        })
    ]),
    z.object({
        type: z.literal('hello_challenge'),
        nonce: z.string()
    }),
    z.object({
        type: z.literal('hello_auth'),
        proof: z
            .object({
                signature: z.string().optional(),
                portalToken: z.string().optional()
            })
            .refine(
                (proof) =>
                    (typeof proof.signature === 'string' && proof.signature.length > 0) ||
                    (typeof proof.portalToken === 'string' && proof.portalToken.length > 0),
                { message: 'hello_auth.proof requires at least one auth credential' }
            )
    }),
    z.object({
        type: z.literal('hello_authenticated')
    }),
    z.object({
        type: z.literal('auth_denied'),
        reason: z.enum(['missing_session']).optional()
    }),
    z.object({
        type: z.literal('switch_scope'),
        projectId: z.string(),
        commitId: z.string(),
        slideId: z.string()
    }),
    z.object({
        type: z.literal('hydrate'),
        layers: LayerSchema.array(),
        projectId: z.string().optional(),
        commitId: z.string().optional(),
        slideId: z.string().optional(),
        customRender: z
            .object({
                url: z.string(),
                compat: z.boolean().default(false),
                proxy: z.boolean().default(false)
            })
            .optional(),
        boundSource: z.enum(['live', 'gallery']).optional()
    }),
    z.object({ type: z.literal('rehydrate_please') }),
    z.object({
        type: z.literal('upsert_layer'),
        origin: z.string().regex(/^(editor|controller|yjs):[a-z0-9_]+$/),
        layer: LayerSchema
    }),
    z.object({ type: z.literal('delete_layer'), numericId: z.number() }),
    z.object({
        type: z.literal('video_play'),
        numericId: z.number(),
        issuedAt: z.number().optional()
    }),
    z.object({
        type: z.literal('video_pause'),
        numericId: z.number(),
        issuedAt: z.number().optional()
    }),
    z.object({
        type: z.literal('video_seek'),
        numericId: z.number(),
        mediaTime: z.number(),
        issuedAt: z.number().optional(),
        playback: LayerPlaybackStateSchema.optional()
    }),
    z.object({
        type: z.literal('video_sync'),
        numericId: z.number(),
        playback: LayerPlaybackStateSchema
    }),
    z.object({
        type: z.literal('processing_progress'),
        numericId: z.number(),
        progress: z.number()
    }),
    z.object({ type: z.literal('clear_stage') }),
    z.object({ type: z.literal('ping') }),
    z.object({ type: z.literal('pong'), t0: z.number(), t1: z.number(), t2: z.number() }),
    z.object({ type: z.literal('reboot'), immediate: z.boolean().optional() }),
    z.object({
        type: z.literal('stage_save'),
        message: z.string(),
        isAutoSave: z.boolean().optional()
    }),
    z.object({
        type: z.literal('stage_save_response'),
        success: z.boolean(),
        commitId: z.string().optional(),
        error: z.string().optional()
    }),
    z.object({ type: z.literal('stage_dirty') }),
    z.object({ type: z.literal('leave_scope') }),
    z.object({
        type: z.literal('bind_wall'),
        wallId: z.string(),
        projectId: z.string(),
        commitId: z.string(),
        slideId: z.string()
    }),
    z.object({ type: z.literal('unbind_wall'), wallId: z.string() }),
    z.object({
        type: z.literal('wall_binding_status'),
        wallId: z.string(),
        bound: z.boolean(),
        projectId: z.string().optional(),
        commitId: z.string().optional(),
        slideId: z.string().optional(),
        customRenderUrl: z.string().nullish(),
        boundSource: z.enum(['live', 'gallery']).optional()
    }),
    z.object({
        type: z.literal('wall_node_count'),
        wallId: z.string(),
        connectedNodes: z.number()
    }),
    z.object({ type: z.literal('seed_scope'), layers: LayerSchema.array() }),
    z.object({
        type: z.literal('update_slides'),
        commitId: z.string(),
        slides: z.array(z.object({ id: z.string(), order: z.number(), name: z.string() }))
    }),
    z.object({
        type: z.literal('slides_updated'),
        commitId: z.string(),
        slides: z.array(z.object({ id: z.string(), order: z.number(), name: z.string() }))
    }),
    z.object({
        type: z.literal('asset_added'),
        projectId: z.string(),
        asset: z.object({
            id: z.string(),
            name: z.string(),
            url: z.string(),
            size: z.number(),
            mimeType: z.string().optional(),
            blurhash: z.string().optional(),
            previewUrl: z.string().optional(),
            sizes: OptionalSizesSchema,
            createdAt: z.string(),
            createdBy: z.string()
        })
    }),
    z.object({
        type: z.literal('gallery_state'),
        wallId: z.string().optional(),
        walls: z.array(
            z.object({
                wallId: z.string(),
                connectedNodes: z.number(),
                bound: z.boolean(),
                projectId: z.string().optional(),
                commitId: z.string().optional(),
                slideId: z.string().optional(),
                source: z.enum(['live', 'gallery']).optional()
            })
        ),
        publishedProjects: z.array(
            z.object({
                projectId: z.string(),
                publishedCommitId: z.string().nullable().optional()
            })
        )
    }),
    z.object({
        type: z.literal('request_bind_wall'),
        requestId: z.string(),
        wallId: z.string(),
        projectId: z.string(),
        commitId: z.string(),
        slideId: z.string()
    }),
    z.object({
        type: z.literal('bind_override_requested'),
        requestId: z.string(),
        wallId: z.string(),
        projectId: z.string(),
        commitId: z.string(),
        slideId: z.string(),
        expiresAt: z.number(),
        requesterEmail: z.email().optional()
    }),
    z.object({
        type: z.literal('bind_override_decision'),
        requestId: z.string(),
        wallId: z.string(),
        allow: z.boolean()
    }),
    z.object({
        type: z.literal('bind_override_result'),
        requestId: z.string(),
        wallId: z.string(),
        allow: z.boolean(),
        reason: z
            .enum(['approved', 'denied', 'timeout', 'not_required', 'invalid', 'unknown_wall'])
            .optional()
    }),
    z.object({
        type: z.literal('wall_binding_changed'),
        wallId: z.string(),
        bound: z.boolean(),
        projectId: z.string().optional(),
        commitId: z.string().optional(),
        slideId: z.string().optional(),
        source: z.enum(['live', 'gallery']).optional()
    }),
    z.object({
        type: z.literal('wall_unbound'),
        wallId: z.string()
    }),
    z.object({
        type: z.literal('projects_changed'),
        projectId: z.string().optional()
    }),
    z.object({
        type: z.literal('device_enrollment'),
        id: z.string()
    })
]);

export type GSMessage = z.infer<typeof GSMessageSchema>;

// ── Client-side extended layer types ─────────────────────────────────────────

export type LayerWithWallComponentState = Layer & { el?: HTMLElement; visible?: boolean };

export type LayerWithWallEngineState = LayerWithWallComponentState & {
    startPos: LayerPositionState;
    targetPos: LayerPositionState;
    animStartTime: number;
    animDuration: number;
};

export type LayerWithEditorState = Layer & { progress?: number; isUploading?: boolean };

// ── Scope utilities ──────────────────────────────────────────────────────────

/** Human-readable scope label for logging and client display */
export function makeScopeLabel(projectId: string, commitId: string, slideId: string): string {
    return `e:${projectId}:${commitId}:${slideId}`;
}

export interface ScopeState {
    layers: Map<number, Layer>;
    projectId: string;
    commitId: string;
    slideId: string;
    dirty: boolean;
    /** Cached JSON payload for hydrate messages. Invalidated on any layer mutation. */
    hydrateCache: string | null;
    /** Optional custom render URL from the project configuration. */
    customRenderUrl?: string;
    /** Whether the custom render URL should be displayed in compatibility mode. */
    customRenderCompat?: boolean;
    /** Whether custom render should be loaded via the built-in proxy. */
    customRenderProxy?: boolean;
}

export interface Slide {
    id: string;
    order: number;
    name: string;
}
