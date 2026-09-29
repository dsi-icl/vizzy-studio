import type { AuthContext } from '@repo/db/documents';

import { PUBLIC_ASSET_PROJECT_ID } from './constants';

type RoleHolder = {
    role?: string | null;
};

type PublisherRoleHolder = RoleHolder & {
    trustedPublisher?: boolean | null;
    canManageSignage?: boolean | null;
};

export function isAdmin(role: string | null | undefined): boolean {
    return role === 'admin';
}

export function isOperator(role: string | null | undefined): boolean {
    return role === 'operator';
}

export function canViewProjectAudits(actor: RoleHolder | null | undefined): boolean {
    return isAdmin(actor?.role) || isOperator(actor?.role);
}

export function canPublishProject(actor: PublisherRoleHolder | null | undefined): boolean {
    if (isAdmin(actor?.role)) return true;
    if (isOperator(actor?.role)) return true;
    if (actor?.canManageSignage === true) return true;
    return actor?.trustedPublisher === true;
}

type AccessResult =
    | { allowed: true; public: boolean; projectId: string }
    | {
          allowed: false;
          missing: boolean;
          reason: string;
          statusMessage: string;
          projectId: string | null;
          details?: { wallId: string };
      };

/** Shared with original/preview files: soft deletion hides library entries, not saved references. */
export async function evaluateAssetReadAccess(
    asset: { projectId?: unknown; public?: boolean | null },
    auth: AuthContext,
    deps: {
        project: (id: string) => Promise<{
            deletedAt?: unknown;
            visibility: string;
            stages: Array<{ publishedCommitId?: string | null }>;
        } | null>;
        canView: (user: NonNullable<AuthContext['user']>, id: string) => Promise<boolean>;
        wall: (id: string) => Promise<{ boundProjectId?: string | null } | null>;
    }
): Promise<AccessResult> {
    const projectId =
        typeof asset.projectId === 'string' && asset.projectId ? asset.projectId : null;
    const deny = (
        reason: string,
        statusMessage: string,
        missing = false,
        details?: { wallId: string }
    ): AccessResult => ({
        allowed: false,
        missing,
        reason,
        statusMessage,
        projectId,
        ...(details ? { details } : {})
    });
    if (!projectId) return deny('ASSET_PROJECT_NOT_FOUND', 'Project Not Found', true);
    if (asset.public === true || projectId === PUBLIC_ASSET_PROJECT_ID)
        return { allowed: true, public: true, projectId };
    const project = await deps.project(projectId);
    if (!project || project.deletedAt)
        return deny('ASSET_PROJECT_NOT_FOUND', 'Project Not Found', true);
    if (project.visibility === 'public' && project.stages.some((stage) => stage.publishedCommitId))
        return { allowed: true, public: true, projectId };
    if (!auth.user && !auth.device) return deny('UNAUTHORIZED_GUEST', 'Unauthorized Guest');
    if (
        auth.user &&
        !isAdmin(auth.user.role) &&
        !(await deps.canView({ email: auth.user.email, role: auth.user.role }, projectId)) &&
        !auth.device
    )
        return deny('PROJECT_VIEW_FORBIDDEN', 'Unauthorized');
    // Preserve the existing media rule when both a user and a device are present.
    if (auth.device) {
        const wallId =
            typeof auth.device.wallId === 'string' && auth.device.wallId.length > 0
                ? auth.device.wallId
                : null;
        if (!wallId) return deny('DEVICE_WALL_ID_MISSING', 'Unauthorized Device');
        const wall = await deps.wall(wallId);
        if (!wall || wall.boundProjectId !== projectId)
            return deny('DEVICE_WALL_NOT_BOUND_TO_PROJECT', 'Unauthorized Wall', false, { wallId });
    }
    return { allowed: true, public: false, projectId };
}
