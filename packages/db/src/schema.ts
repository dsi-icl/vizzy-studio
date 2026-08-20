import { z } from 'zod';

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
