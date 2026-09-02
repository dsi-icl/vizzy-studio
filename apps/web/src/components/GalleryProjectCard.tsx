import { useAuth } from '@repo/auth/tanstack/hooks';
import type { Project } from '@repo/ui/components/project-card';
import { ProjectCard } from '@repo/ui/components/project-card';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { GalleryEngine } from '~/lib/galleryEngine';
import { useGalleryStore } from '~/lib/galleryStore';
import { createSignedServerFnFetch } from '~/lib/signedFetch';
import { $issueControllerPortalToken } from '~/server/portal.fns';

interface GalleryProjectCardProps {
    project: Project & {
        id: string;
        publishedCommitId?: string | null;
    };
    autoOpenSignal?: string | number | null;
    forceDemoteFullscreenSignal?: string | number | null;
    forceCloseMinimizedSignal?: string | number | null;
    forceCloseSignal?: string | number | null;
    allowWallActions?: boolean;
    availableWalls?: Array<{
        id: string;
        name: string;
        connectedNodes: number;
        isBound?: boolean;
    }>;
}

export function GalleryProjectCard({
    project,
    autoOpenSignal,
    forceDemoteFullscreenSignal,
    forceCloseMinimizedSignal,
    forceCloseSignal,
    allowWallActions = true,
    availableWalls = []
}: GalleryProjectCardProps) {
    const { user } = useAuth();

    const wallId = useGalleryStore((s) => s.wallId);
    const isEnrolledDevice = useGalleryStore((s) => s.isEnrolledDevice);
    const canUserManageWalls = Boolean(user) && allowWallActions;
    const canEnrolledDeviceLoad = isEnrolledDevice && !user && allowWallActions;

    const handleLoadProject = useCallback(
        async (wallId: string) => {
            if (!project.publishedCommitId) {
                toast.error('This project has no published commit');
                return false;
            }

            try {
                const engine = GalleryEngine.getInstance();
                engine.sendJSON({
                    type: 'bind_wall',
                    wallId,
                    projectId: project.id,
                    commitId: project.publishedCommitId,
                    slideId: 'default'
                });
                toast.success('Project loaded on wall');
                return true;
            } catch (e: any) {
                toast.error(e?.message ?? 'Could not load project on wall');
                return false;
            }
        },
        [project.id, project.publishedCommitId]
    );

    const handleWallRebootRequest = useCallback(async (_wallId: string) => {
        try {
            const engine = GalleryEngine.getInstance();
            engine.sendJSON({ type: 'reboot' });
            return true;
        } catch (e: any) {
            toast.error(e?.message ?? 'Could not refresh wall screens');
            return false;
        }
    }, []);

    const handleWallUnbindRequest = useCallback(async (wallId: string) => {
        try {
            const engine = GalleryEngine.getInstance();
            engine.unbindWall(wallId);
            return true;
        } catch (e: any) {
            toast.error(e?.message ?? 'Could not unbind wall');
            return false;
        }
    }, []);

    const handleControllerTokenRequest = useCallback(async (wallId: string) => {
        const isWallNotBoundError = (error: unknown) => {
            const message =
                typeof error === 'object' && error !== null && 'message' in error
                    ? String((error as { message?: unknown }).message ?? '')
                    : '';
            return message.includes('Wall is not currently bound');
        };

        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        const maxAttempts = 8;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const result = await $issueControllerPortalToken({
                    data: { wallId },
                    fetch: createSignedServerFnFetch({
                        deviceKind: 'gallery',
                        wallId
                    })
                });
                return result.token;
            } catch (e: unknown) {
                if (isWallNotBoundError(e) && attempt < maxAttempts) {
                    await sleep(200);
                    continue;
                }
                toast.error(
                    (typeof e === 'object' && e !== null && 'message' in e
                        ? String((e as { message?: unknown }).message ?? '')
                        : '') || 'Could not initialize controller API token'
                );
                return null;
            }
        }

        return null;
    }, []);

    const canLoad = canUserManageWalls || canEnrolledDeviceLoad;
    const hasCustomRenderUrl =
        typeof project.customRenderUrl === 'string' && project.customRenderUrl.trim().length > 0;
    const previewHref =
        user && project.publishedCommitId && !hasCustomRenderUrl
            ? `/quarry/view/${encodeURIComponent(project.id)}/${encodeURIComponent(project.publishedCommitId)}`
            : undefined;
    const previewDisabledReason =
        user && hasCustomRenderUrl
            ? 'Preview is unavailable because this project uses a custom render URL.'
            : undefined;

    return (
        <ProjectCard
            project={project}
            previewHref={previewHref}
            previewDisabledReason={previewDisabledReason}
            autoOpenSignal={autoOpenSignal}
            forceDemoteFullscreenSignal={forceDemoteFullscreenSignal}
            forceCloseMinimizedSignal={forceCloseMinimizedSignal}
            forceCloseSignal={forceCloseSignal}
            availableWalls={availableWalls}
            onLoadProject={canLoad ? handleLoadProject : undefined}
            onWallRebootRequest={canLoad ? handleWallRebootRequest : undefined}
            onWallUnbindRequest={canLoad ? handleWallUnbindRequest : undefined}
            onControllerTokenRequest={canLoad ? handleControllerTokenRequest : undefined}
            presetWallId={wallId}
            hideWallPicker={canEnrolledDeviceLoad}
        />
    );
}
