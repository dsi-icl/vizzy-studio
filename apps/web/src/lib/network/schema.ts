import { DEFAULT_FONT_OPTION_ID } from '~/lib/fontFamilyOptions';
import { z } from '~/lib/zod';

export const MAX_NETWORK_NODES = 1000;
export const MAX_NETWORK_EDGES = 3000;
export const MAX_NETWORK_FILE_BYTES = 2 * 1024 * 1024;
export const NETWORK_WIDTH = 1000;
export const NETWORK_HEIGHT = 650;

const Id = z.string().trim().min(1).max(160);
export const NetworkDataSchema = z
    .object({
        nodes: z
            .array(
                z.object({
                    id: Id,
                    label: z.string().max(160).optional(),
                    group: z.string().max(80).optional()
                })
            )
            .min(1)
            .max(MAX_NETWORK_NODES),
        edges: z
            .array(
                z.object({
                    source: Id,
                    target: Id,
                    weight: z.number().positive().max(10000).optional(),
                    influence: z.number().min(-5).max(5).optional()
                })
            )
            .max(MAX_NETWORK_EDGES)
    })
    .superRefine((data, ctx) => {
        const ids = new Set<string>();
        for (const node of data.nodes) {
            if (ids.has(node.id))
                ctx.addIssue({ code: 'custom', message: `Duplicate node ID: ${node.id}` });
            ids.add(node.id);
        }
        for (const edge of data.edges) {
            if (!ids.has(edge.source) || !ids.has(edge.target)) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Unknown node in edge: ${edge.source} → ${edge.target}`
                });
            }
        }
    });

export const DEFAULT_NETWORK_SETTINGS = {
    charge: -180,
    linkDistance: 80,
    linkStrength: 0.5,
    collisionRadius: 18,
    nodeRadius: 7,
    edgeWidth: 1.5,
    showLabels: false,
    labelFontFamily: DEFAULT_FONT_OPTION_ID,
    labelFontSize: 14,
    nodeColor: '#ffffff',
    colorByGroup: false,
    labelColor: '#ffffff',
    edgeColor: '#ffffff',
    relationshipColors: {
        positive: '#22c55e',
        negative: '#ef4444',
        neutral: '#94a3b8'
    },
    motionStrength: 0.65,
    paused: false
};

export const NetworkSettingsSchema = z.object({
    charge: z.number().min(-1000).max(0),
    linkDistance: z.number().min(10).max(300),
    linkStrength: z.number().min(0).max(1),
    collisionRadius: z.number().min(1).max(80),
    nodeRadius: z.number().min(2).max(20),
    edgeWidth: z.number().min(0.5).max(5),
    showLabels: z.boolean(),
    labelGroup: z.string().max(80).optional(),
    labelFontFamily: z.string().max(160).default(DEFAULT_FONT_OPTION_ID),
    labelFontSize: z.number().min(8).max(48).default(14),
    nodeColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
    colorByGroup: z.boolean().default(false),
    motionStrength: z.number().min(0).max(2).default(0.65),
    labelColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
    edgeColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
    relationshipColors: z
        .object({
            positive: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            negative: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            neutral: z.string().regex(/^#[0-9a-fA-F]{6}$/)
        })
        .default(DEFAULT_NETWORK_SETTINGS.relationshipColors),
    paused: z.boolean().default(false)
});

export const NetworkInfluenceSchema = z.object({
    activeNodeId: Id,
    values: z.record(Id, z.number().min(0).max(100)),
    propagation: z.number().min(0).max(1),
    visibleNodeIds: z.array(Id).max(MAX_NETWORK_NODES).optional()
});

export const NetworkSchema = z
    .object({
        name: z.string().trim().min(1).max(100),
        data: NetworkDataSchema,
        settings: NetworkSettingsSchema,
        source: z.enum(['import', 'live-example', 'custom']).default('import'),
        reheat: z.number().int().nonnegative().default(0),
        nodeMove: z
            .object({
                nodeId: Id,
                x: z.number().min(0).max(NETWORK_WIDTH),
                y: z.number().min(0).max(NETWORK_HEIGHT),
                revision: z.number().int().nonnegative()
            })
            .optional(),
        influence: NetworkInfluenceSchema.optional(),
        // A paused network stores the preview's frozen layout. Running networks
        // omit positions so ongoing simulation frames never dirty the document.
        positions: z
            .array(
                z.object({
                    x: z.number().min(0).max(NETWORK_WIDTH),
                    y: z.number().min(0).max(NETWORK_HEIGHT)
                })
            )
            .max(MAX_NETWORK_NODES)
            .optional()
    })
    .superRefine((network, ctx) => {
        if (network.positions && network.positions.length !== network.data.nodes.length) {
            ctx.addIssue({ code: 'custom', message: 'Each node needs a saved position.' });
        }
        if (
            network.nodeMove &&
            !network.data.nodes.some((node) => node.id === network.nodeMove!.nodeId)
        )
            ctx.addIssue({ code: 'custom', message: 'Moved node is missing.' });
        if (network.influence) {
            const ids = new Set(network.data.nodes.map((node) => node.id));
            if (!ids.has(network.influence.activeNodeId))
                ctx.addIssue({ code: 'custom', message: 'Selected influence node is missing.' });
            for (const id of Object.keys(network.influence.values))
                if (!ids.has(id))
                    ctx.addIssue({ code: 'custom', message: `Unknown influence node: ${id}` });
            const visible = network.influence.visibleNodeIds;
            if (visible) {
                if (new Set(visible).size !== visible.length)
                    ctx.addIssue({ code: 'custom', message: 'Displayed nodes must be unique.' });
                for (const id of visible)
                    if (!ids.has(id))
                        ctx.addIssue({ code: 'custom', message: `Unknown displayed node: ${id}` });
            }
        }
    });

export type NetworkData = z.infer<typeof NetworkDataSchema>;
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;
export type Network = z.infer<typeof NetworkSchema>;
export type NetworkPositions = Array<{ x: number; y: number }>;
export type NetworkView = { data: NetworkData; positions: NetworkPositions };

export const EXAMPLE_NETWORK: NetworkData = {
    nodes: [
        { id: 'Vizzy', group: 'Platform' },
        { id: 'Research', group: 'People' },
        { id: 'Design', group: 'People' },
        { id: 'Engineering', group: 'People' },
        { id: 'Data', group: 'Resources' },
        { id: 'Models', group: 'Resources' },
        { id: 'Images', group: 'Resources' },
        { id: 'Wall', group: 'Platform' },
        { id: 'Editor', group: 'Platform' },
        { id: 'Networks', group: 'Outputs' },
        { id: 'Maps', group: 'Outputs' },
        { id: 'Stories', group: 'Outputs' }
    ],
    edges: [
        ['Vizzy', 'Research'],
        ['Vizzy', 'Design'],
        ['Vizzy', 'Engineering'],
        ['Research', 'Data'],
        ['Research', 'Models'],
        ['Design', 'Images'],
        ['Engineering', 'Editor'],
        ['Editor', 'Wall'],
        ['Vizzy', 'Wall'],
        ['Data', 'Networks'],
        ['Data', 'Maps'],
        ['Images', 'Stories'],
        ['Models', 'Networks'],
        ['Design', 'Stories'],
        ['Wall', 'Networks'],
        ['Wall', 'Maps'],
        ['Wall', 'Stories']
    ].map(([source, target]) => ({ source: source!, target: target! }))
};
