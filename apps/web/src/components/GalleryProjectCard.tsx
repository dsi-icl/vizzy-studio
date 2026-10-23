import { useAuth } from '@repo/auth/tanstack/hooks';
import type { Project } from '@repo/ui/components/project-card';
import { ProjectCard } from '@repo/ui/components/project-card';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { bindGalleryWallAndWait } from '~/lib/galleryBindAck';
import { GalleryEngine } from '~/lib/galleryEngine';
import { useGalleryStore } from '~/lib/galleryStore';
import { createSignedServerFnFetch } from '~/lib/signedFetch';
import { $issueControllerPortalToken } from '~/server/portal.fns';
import { $issueBoundServeLaunch } from '~/server/serve.fns';
import { wallsQueryOptions } from '~/server/walls.queries';

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
}

export function GalleryProjectCard({
    project,
    autoOpenSignal,
    forceDemoteFullscreenSignal,
    forceCloseMinimizedSignal,
    forceCloseSignal,
    allowWallActions = true
}: GalleryProjectCardProps) {
    const { user } = useAuth();

    const wallId = useGalleryStore((s) => s.wallId);
    const isEnrolledDevice = useGalleryStore((s) => s.isEnrolledDevice);
    const canUserManageWalls = Boolean(user) && allowWallActions;
    const canEnrolledDeviceLoad = isEnrolledDevice && !user && allowWallActions;
    const { data: walls = [] } = useQuery({
        ...wallsQueryOptions(),
        enabled: canUserManageWalls || canEnrolledDeviceLoad
    });

    const availableWalls =
        canUserManageWalls || canEnrolledDeviceLoad
            ? walls.map((wall) => ({
                  id: wall.wallId,
                  name: wall.name,
                  connectedNodes: wall.connectedNodes,
                  isBound: Boolean(wall.boundProjectId)
              }))
            : [];

    const isCustom = Boolean(project.controlPath);

    const handleLoadProject = useCallback(
        async (wallId: string) => {
            const commitId = project.publishedCommitId;
            if (!commitId) {
                toast.error('This project has no published commit');
                return false;
            }

            try {
                const engine = GalleryEngine.getInstance();
                if (!(await engine.waitUntilReady())) {
                    throw new Error('Gallery connection is not ready');
                }
                const binding = { wallId, projectId: project.id, commitId };
                if (isCustom) {
                    // A serve grant is tied to the current wall binding. Wait
                    // for this bind to finish before opening the controller;
                    // otherwise a prior binding can issue a grant that the new
                    // bind immediately invalidates.
                    await bindGalleryWallAndWait(engine, binding);
                } else {
                    if (!engine.sendJSON({ type: 'bind_wall', ...binding, slideId: 'default' })) {
                        throw new Error('Gallery connection is not ready');
                    }
                }
                toast.success('Project loaded on wall');
                return true;
            } catch (e: any) {
                toast.error(e?.message ?? 'Could not load project on wall');
                return false;
            }
        },
        [isCustom, project.id, project.publishedCommitId]
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

    const handleControllerLaunchRequest = useCallback(
        async (wallId: string) => {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                try {
                    const launch = await $issueBoundServeLaunch({
                        data: { wallId, projectId: project.id, entry: 'control' },
                        fetch: createSignedServerFnFetch({ deviceKind: 'gallery', wallId })
                    });
                    return launch;
                } catch (error) {
                    if (attempt < 7 && String(error).includes('Wall is not bound')) {
                        await new Promise((resolve) => setTimeout(resolve, 200));
                        continue;
                    }
                    console.warn('[Gallery] Could not obtain demo controller launch', error);
                    return null;
                }
            }
            return null;
        },
        [project.id]
    );

    const canLoad = canUserManageWalls || canEnrolledDeviceLoad;
    // The gallery route only sets `controlPath` for custom projects.
    const previewHref =
        user && project.publishedCommitId && !isCustom
            ? `/quarry/view/${encodeURIComponent(project.id)}/${encodeURIComponent(project.publishedCommitId)}`
            : undefined;
    const previewDisabledReason =
        user && isCustom ? 'Preview is unavailable because this is a custom project.' : undefined;

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
            onControllerTokenRequest={
                canLoad && !isCustom ? handleControllerTokenRequest : undefined
            }
            onControllerLaunchRequest={
                canLoad && isCustom ? handleControllerLaunchRequest : undefined
            }
            presetWallId={wallId}
            hideWallPicker={canEnrolledDeviceLoad}
        />
    );
}
