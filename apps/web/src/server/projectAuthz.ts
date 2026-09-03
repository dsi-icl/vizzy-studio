import '@tanstack/react-start/server-only';
import type { ProjectDocument } from '@repo/db/documents';

import { validateUploadToken } from '~/lib/uploadTokens';
import { dbCol } from '~/server/collections';

type Actor = {
    email: string;
    role?: string;
    trustedPublisher?: boolean;
};

function isAdmin(role: string | null | undefined): boolean {
    return role === 'admin';
}

function isOperator(role: string | null | undefined): boolean {
    return role === 'operator';
}

function hasProjectMembership(
    project: Pick<ProjectDocument, 'createdBy' | 'collaborators'>,
    email: string
): boolean {
    if (project.createdBy === email) return true;
    return project.collaborators.some((c) => c?.email === email);
}

function hasCollaboratorRole(
    project: Pick<ProjectDocument, 'collaborators'>,
    email: string,
    roles: string[]
): boolean {
    return project.collaborators.some((c) => c?.email === email && roles.includes(c?.role));
}

export async function canViewProject(actor: Actor, projectId: string): Promise<boolean> {
    if (!projectId) return false;
    if (isAdmin(actor.role)) return true;
    const project = await dbCol.projects.findById(projectId);
    if (!project) return false;
    return hasProjectMembership(project, actor.email);
}

export async function canEditProject(actor: Actor, projectId: string): Promise<boolean> {
    if (!projectId) return false;
    if (isAdmin(actor.role)) return true;
    const project = await dbCol.projects.findById(projectId);
    if (!project) return false;
    return hasCollaboratorRole(project, actor.email, ['owner', 'editor']);
}

export async function ownsProject(actor: Actor, projectId: string): Promise<boolean> {
    if (!projectId) return false;
    if (isAdmin(actor.role)) return true;
    const project = await dbCol.projects.findById(projectId);
    if (!project) return false;
    return hasCollaboratorRole(project, actor.email, ['owner']);
}

export function canPublishProject(actor: Actor): boolean {
    if (isAdmin(actor.role)) return true;
    if (isOperator(actor.role)) return true;
    return actor.trustedPublisher === true;
}

export function canViewProjectAudits(actor: Actor): boolean {
    return isAdmin(actor.role) || isOperator(actor.role);
}

export async function resolveProjectIdForCommit(commitId: string): Promise<string | null> {
    if (!commitId) return null;
    const commit = await dbCol.commits.findById(commitId);
    if (!commit?.projectId) return null;
    return String(commit.projectId);
}

export async function resolveProjectIdForAsset(assetId: string): Promise<string | null> {
    if (!assetId) return null;
    const asset = await dbCol.assets.findById(assetId);
    if (!asset?.projectId) return null;
    return String(asset.projectId);
}

export function resolveProjectIdForUploadToken(token: string): string | null {
    const data = validateUploadToken(token);
    return data?.projectId ?? null;
}

export function actorFromAuthContext(authContext: {
    user?: {
        email?: string | null;
        role?: string | null;
        trustedPublisher?: boolean | null;
    } | null;
}): Actor | null {
    const email = authContext.user?.email;
    if (!email) return null;
    return {
        email,
        role: authContext.user?.role ?? undefined,
        trustedPublisher: authContext.user?.trustedPublisher === true
    };
}
