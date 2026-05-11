import { TriangleDashedIcon } from '@phosphor-icons/react';
import { useAuth } from '@repo/auth/tanstack/hooks';
import { Button } from '@repo/ui/components/button';
import type { Project } from '@repo/ui/components/project-card';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { GalleryProjectCard } from '~/components/GalleryProjectCard';
import { getOrCreateDeviceIdentity } from '~/lib/deviceIdentity';
import { GalleryEngine } from '~/lib/galleryEngine';
import { initGalleryStore, useGalleryStore } from '~/lib/galleryStore';
import { publishedProjectsQueryOptions } from '~/server/projects.queries';
import { wallsQueryOptions } from '~/server/walls.queries';

export const Route = createFileRoute('/gallery/')({
    loader: ({ context, location }) => {
        context.queryClient.ensureQueryData(publishedProjectsQueryOptions());
        if (typeof window !== 'undefined') {
            const params = new URLSearchParams(location.searchStr);
            initGalleryStore({
                wallId: params.get('w') || null,
                enrollmentModeEnabled: params.has('enroll')
            });
        }
    },
    component: HomePage,
    head: () => ({
        meta: [{ title: 'Gallery · Vizzy Studio' }]
    })
});

type ProjectWithId = Project & { id: string; publishedCommitId?: string | null };
type WallListEntry = {
    wallId: string;
    name: string;
    connectedNodes: number;
    boundProjectId?: string | null;
    boundCommitId?: string | null;
    boundSlideId?: string | null;
    boundSource?: 'live' | 'gallery' | null;
};

function HomePage() {
    const { user } = useAuth();
    const [activeTag, setActiveTag] = useState<string | null>(null);
    const [enrollmentQrDataUrl, setEnrollmentQrDataUrl] = useState<string | null>(null);
    const [autoOpenRevision, setAutoOpenRevision] = useState(0);
    const [liveSessionRevision, setLiveSessionRevision] = useState(0);
    const [syncedCloseRevision, setSyncedCloseRevision] = useState(0);
    const [syncedCloseProjectId, setSyncedCloseProjectId] = useState<string | null>(null);
    const { data: publishedProjects = [] } = useQuery(publishedProjectsQueryOptions());
    const { data: walls = [] } = useQuery({
        ...wallsQueryOptions(),
        enabled: Boolean(user)
    });
    const queryClient = useQueryClient();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const [pendingOverride, setPendingOverride] = useState<{
        requestId: string;
        wallId: string;
        projectId: string;
        commitId: string;
        slideId: string;
        expiresAt: number;
        requesterEmail?: string;
    } | null>(null);
    const [overrideClockNow, setOverrideClockNow] = useState<number>(() => Date.now());
    const filtersAsideRef = useRef<HTMLElement | null>(null);
    const liveBoundForTargetRef = useRef(false);
    const lastGalleryBoundProjectRef = useRef<string | null>(null);

    const wallId = useGalleryStore((s) => s.wallId);
    const deviceEnrollmentId = useGalleryStore((s) => s.deviceEnrollmentId);
    const enrollmentModeEnabled = useGalleryStore((s) => s.enrollmentModeEnabled);

    useEffect(() => {
        const params = new URLSearchParams(searchStr);
        initGalleryStore({
            wallId: params.get('w') || null,
            enrollmentModeEnabled: params.has('enroll')
        });
    }, [searchStr]);

    const galleryEnrollmentGateActive = enrollmentModeEnabled && Boolean(deviceEnrollmentId);

    const galleryEngine = useMemo(
        () => (typeof window !== 'undefined' ? GalleryEngine.getInstance() : null),
        // Re-derive the engine whenever the effective wallId changes so the
        // singleton is recreated for the correct wall.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [wallId]
    );

    useEffect(() => {
        liveBoundForTargetRef.current = false;
    }, [wallId]);

    useEffect(() => {
        if (!galleryEngine) return;
        const wallsQueryKey = wallsQueryOptions().queryKey;
        const publishedProjectsQueryKey = publishedProjectsQueryOptions().queryKey;
        const triggerSyncedCardClose = (projectId: string | null) => {
            if (!projectId) return;
            setSyncedCloseProjectId(projectId);
            setSyncedCloseRevision((v) => v + 1);
        };
        const updateCurrentGalleryBoundProject = (nextProjectId: string | null) => {
            const previousProjectId = lastGalleryBoundProjectRef.current;
            if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) {
                triggerSyncedCardClose(previousProjectId);
            }
            lastGalleryBoundProjectRef.current = nextProjectId;
        };
        const handleLiveBindingStatus = (
            nextWallId: string,
            bound: boolean,
            source?: 'live' | 'gallery',
            projectId?: string
        ) => {
            if (!wallId || nextWallId !== wallId) return;
            const isLiveBound = bound && source === 'live';
            const isContinuationOfCurrentProject =
                isLiveBound &&
                typeof projectId === 'string' &&
                projectId.length > 0 &&
                lastGalleryBoundProjectRef.current === projectId;
            if (isLiveBound && !liveBoundForTargetRef.current && !isContinuationOfCurrentProject) {
                setLiveSessionRevision((v) => v + 1);
            }
            liveBoundForTargetRef.current = isLiveBound;
        };

        const setWallBinding = (
            wallState:
                | {
                      wallId: string;
                      connectedNodes?: number;
                      bound: boolean;
                      projectId?: string;
                      commitId?: string;
                      slideId?: string;
                      source?: 'live' | 'gallery';
                  }
                | {
                      wallId: string;
                      connectedNodes?: number;
                      boundProjectId: string | null;
                      boundCommitId: string | null;
                      boundSlideId: string | null;
                      boundSource: 'live' | 'gallery' | null;
                  }
        ) => {
            queryClient.setQueryData<WallListEntry[]>(wallsQueryKey, (current) => {
                const list: WallListEntry[] = Array.isArray(current) ? [...current] : [];
                const idx = list.findIndex((wall) => wall.wallId === wallState.wallId);
                const existing: WallListEntry | undefined = idx >= 0 ? list[idx] : undefined;

                const next: WallListEntry = existing
                    ? { ...existing }
                    : {
                          wallId: wallState.wallId,
                          name: wallState.wallId,
                          connectedNodes:
                              typeof wallState.connectedNodes === 'number'
                                  ? wallState.connectedNodes
                                  : 0,
                          boundProjectId: null,
                          boundCommitId: null,
                          boundSlideId: null,
                          boundSource: null
                      };

                if ('bound' in wallState) {
                    next.boundProjectId = wallState.bound ? (wallState.projectId ?? null) : null;
                    next.boundCommitId = wallState.bound ? (wallState.commitId ?? null) : null;
                    next.boundSlideId = wallState.bound ? (wallState.slideId ?? null) : null;
                    next.boundSource = wallState.bound ? (wallState.source ?? null) : null;
                } else {
                    next.boundProjectId = wallState.boundProjectId;
                    next.boundCommitId = wallState.boundCommitId;
                    next.boundSlideId = wallState.boundSlideId;
                    next.boundSource = wallState.boundSource;
                }

                if (typeof wallState.connectedNodes === 'number') {
                    next.connectedNodes = wallState.connectedNodes;
                }

                if (idx >= 0) {
                    list[idx] = next;
                } else {
                    list.push(next);
                }
                return list;
            });
        };

        const unsubs = [
            galleryEngine.onGalleryState((snapshot) => {
                queryClient.setQueryData<WallListEntry[]>(wallsQueryKey, (current) => {
                    const byWallId = new Map(
                        (Array.isArray(current) ? current : []).map((wall) => [wall.wallId, wall])
                    );
                    for (const wall of snapshot.walls) {
                        const existing = byWallId.get(wall.wallId);
                        byWallId.set(wall.wallId, {
                            wallId: wall.wallId,
                            name: existing?.name ?? wall.wallId,
                            connectedNodes: wall.connectedNodes,
                            boundProjectId: wall.bound ? (wall.projectId ?? null) : null,
                            boundCommitId: wall.bound ? (wall.commitId ?? null) : null,
                            boundSlideId: wall.bound ? (wall.slideId ?? null) : null,
                            boundSource: wall.bound ? (wall.source ?? null) : null
                        });
                    }
                    return Array.from(byWallId.values());
                });
                const currentWallId = useGalleryStore.getState().wallId;
                if (currentWallId) {
                    const targetWall = snapshot.walls.find((wall) => wall.wallId === currentWallId);
                    if (targetWall) {
                        handleLiveBindingStatus(
                            targetWall.wallId,
                            targetWall.bound,
                            targetWall.source,
                            targetWall.projectId
                        );
                        const isGalleryBound =
                            targetWall.bound &&
                            targetWall.source === 'gallery' &&
                            Boolean(targetWall.projectId);
                        if (isGalleryBound && targetWall.projectId) {
                            updateCurrentGalleryBoundProject(targetWall.projectId);
                        } else if (targetWall.bound && targetWall.source === 'live') {
                            const isContinuation =
                                typeof targetWall.projectId === 'string' &&
                                targetWall.projectId.length > 0 &&
                                lastGalleryBoundProjectRef.current === targetWall.projectId;
                            if (!isContinuation) {
                                const previouslyBoundProject = lastGalleryBoundProjectRef.current;
                                if (previouslyBoundProject)
                                    triggerSyncedCardClose(previouslyBoundProject);
                                updateCurrentGalleryBoundProject(null);
                            }
                        } else {
                            const previouslyBoundProject = lastGalleryBoundProjectRef.current;
                            if (previouslyBoundProject)
                                triggerSyncedCardClose(previouslyBoundProject);
                            updateCurrentGalleryBoundProject(null);
                        }
                    } else {
                        handleLiveBindingStatus(currentWallId, false);
                        const previouslyBoundProject = lastGalleryBoundProjectRef.current;
                        if (previouslyBoundProject) triggerSyncedCardClose(previouslyBoundProject);
                        updateCurrentGalleryBoundProject(null);
                    }
                }
            }),
            galleryEngine.onProjectsChanged(() => {
                void queryClient.invalidateQueries({
                    queryKey: publishedProjectsQueryKey
                });
            }),
            galleryEngine.onWallBindingChanged((event) => {
                setWallBinding({
                    wallId: event.wallId,
                    bound: event.bound,
                    projectId: event.projectId,
                    commitId: event.commitId,
                    slideId: event.slideId,
                    source: event.source
                });
                if (wallId && event.wallId === wallId) {
                    setAutoOpenRevision((v) => v + 1);
                    if (event.bound && event.source === 'gallery' && event.projectId) {
                        updateCurrentGalleryBoundProject(event.projectId);
                    } else if (!event.bound) {
                        const previouslyBoundProject = lastGalleryBoundProjectRef.current;
                        if (previouslyBoundProject) triggerSyncedCardClose(previouslyBoundProject);
                        updateCurrentGalleryBoundProject(null);
                    } else if (event.source === 'live') {
                        const isContinuation =
                            typeof event.projectId === 'string' &&
                            event.projectId.length > 0 &&
                            lastGalleryBoundProjectRef.current === event.projectId;
                        if (!isContinuation) {
                            updateCurrentGalleryBoundProject(null);
                        }
                    }
                }
                handleLiveBindingStatus(event.wallId, event.bound, event.source, event.projectId);
            }),
            galleryEngine.onWallUnbound((event) => {
                setWallBinding({
                    wallId: event.wallId,
                    bound: false
                });
                if (wallId && event.wallId === wallId) {
                    setAutoOpenRevision((v) => v + 1);
                    const previouslyBoundProject = lastGalleryBoundProjectRef.current;
                    if (previouslyBoundProject) triggerSyncedCardClose(previouslyBoundProject);
                    updateCurrentGalleryBoundProject(null);
                }
                handleLiveBindingStatus(event.wallId, false);
            }),
            galleryEngine.onBindOverrideRequested((req) => {
                if (!wallId || req.wallId !== wallId) return;
                setPendingOverride(req);
                toast.message(`${formatRequesterLabel(req.requesterEmail)} wants to take over.`);
            }),
            galleryEngine.onBindOverrideResult((result) => {
                if (!pendingOverride || result.requestId !== pendingOverride.requestId) return;
                setPendingOverride(null);
                if (!result.allow) {
                    toast.message(
                        result.reason === 'timeout'
                            ? 'The takeover request expired.'
                            : result.reason === 'unknown_wall'
                              ? 'This wall no longer exists.'
                              : 'Takeover request declined.'
                    );
                }
            })
        ];
        return () => {
            for (const unsub of unsubs) unsub();
        };
    }, [galleryEngine, queryClient, wallId, pendingOverride]);

    useEffect(() => {
        const deviceId = deviceEnrollmentId?.trim();
        if (!enrollmentModeEnabled || !deviceId) return;
        let cancelled = false;
        Promise.resolve()
            .then(async () => {
                const identity = await getOrCreateDeviceIdentity('gallery');
                const signature = await identity.signPayload(deviceId);
                const payload = JSON.stringify({
                    did: deviceId,
                    sig: signature
                });
                return QRCode.toDataURL(payload, {
                    margin: 0,
                    width: 240,
                    errorCorrectionLevel: 'L',
                    color: {
                        dark: '#939393FF',
                        light: '#00000000'
                    }
                });
            })
            .then((url) => {
                if (!cancelled) setEnrollmentQrDataUrl(url);
            })
            .catch(() => {
                if (!cancelled) setEnrollmentQrDataUrl(null);
            });
        return () => {
            cancelled = true;
        };
    }, [deviceEnrollmentId, enrollmentModeEnabled]);

    useEffect(() => {
        if (!pendingOverride) return;
        const tick = () => {
            setOverrideClockNow(Date.now());
        };
        tick();
        const id = window.setInterval(tick, 250);
        return () => window.clearInterval(id);
    }, [pendingOverride]);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        if (pendingOverride) {
            document.body.setAttribute('data-takeover-lock', '1');
            return () => {
                document.body.removeAttribute('data-takeover-lock');
            };
        }
        document.body.removeAttribute('data-takeover-lock');
    }, [pendingOverride]);

    useEffect(() => {
        if (typeof document === 'undefined') return;

        const updateMinimizedLeft = () => {
            const aside = filtersAsideRef.current;
            if (!aside) return;
            const left = Math.max(16, Math.round(aside.getBoundingClientRect().left));
            document.documentElement.style.setProperty('--gallery-minimized-left', `${left}px`);
        };

        updateMinimizedLeft();
        const rafId = window.requestAnimationFrame(updateMinimizedLeft);
        window.addEventListener('resize', updateMinimizedLeft);

        return () => {
            window.cancelAnimationFrame(rafId);
            window.removeEventListener('resize', updateMinimizedLeft);
            document.documentElement.style.removeProperty('--gallery-minimized-left');
        };
    }, []);

    const formatRequesterLabel = (email?: string) => {
        // TODO Lookup through university LDAP to get names maybe ?
        return `${email}`;
    };

    const overrideSecondsLeft = pendingOverride
        ? Math.ceil(Math.max(0, pendingOverride.expiresAt - overrideClockNow) / 1000)
        : 0;

    const decideOverride = (allow: boolean) => {
        if (!galleryEngine || !pendingOverride) return;
        galleryEngine.decideBindOverride(pendingOverride.requestId, pendingOverride.wallId, allow);
        setPendingOverride(null);
    };

    const projectsData: ProjectWithId[] = useMemo(
        () =>
            publishedProjects.map((p) => ({
                id: p.id,
                name: p.name,
                author: p.authorOrganisation,
                description: p.description,
                tags: p.tags,
                publishedCommitId: p.publishedCommitId,
                customControlUrl: (p as { customControlUrl?: string }).customControlUrl,
                customRenderUrl: (p as { customRenderUrl?: string | null }).customRenderUrl,
                imageUrl: p.heroImages[0] ?? '',
                blurhash: (p as { heroImageBlurhash?: string }).heroImageBlurhash,
                sizes: (p as { heroImageSizes?: number[] }).heroImageSizes,
                images: (() => {
                    const heroImages = Array.isArray(p.heroImages) ? p.heroImages : [];
                    const metaBySrc = new Map(
                        (
                            (
                                p as {
                                    heroImageMeta?: Array<{
                                        src: string;
                                        blurhash?: string;
                                        sizes?: number[];
                                    }>;
                                }
                            ).heroImageMeta ?? []
                        ).map((entry) => [entry.src, entry])
                    );

                    return heroImages.map((src) => {
                        const meta = metaBySrc.get(src);
                        return {
                            src,
                            blurhash: meta?.blurhash,
                            sizes: meta?.sizes
                        };
                    });
                })()
            })),
        [publishedProjects]
    );

    const allTags = useMemo(() => {
        const tags = new Set<string>();
        for (const p of projectsData) {
            for (const t of p.tags) {
                tags.add(t);
            }
        }
        return Array.from(tags);
    }, [projectsData]);

    const filteredProjects = useMemo(() => {
        if (!activeTag) return projectsData;
        return projectsData.filter((p) => p.tags.includes(activeTag));
    }, [activeTag, projectsData]);

    const autoOpenProjectId = useMemo(() => {
        if (!wallId) return null;
        const targetWall = walls.find((wall) => wall.wallId === wallId);
        if (!targetWall?.boundProjectId) return null;
        const boundSource = (targetWall as { boundSource?: 'live' | 'gallery' | null }).boundSource;
        if (boundSource === 'live') return null;
        return targetWall.boundProjectId;
    }, [wallId, walls]);

    const autoOpenBindingSignature = useMemo(() => {
        if (!wallId) return null;
        const targetWall = walls.find((wall) => wall.wallId === wallId);
        if (!targetWall?.boundProjectId) return null;
        const boundSource = (targetWall as { boundSource?: 'live' | 'gallery' | null }).boundSource;
        if (boundSource === 'live') return null;
        const withCommit = targetWall as {
            boundCommitId?: string | null;
            boundSlideId?: string | null;
        };
        return [
            wallId,
            targetWall.boundProjectId,
            withCommit.boundCommitId ?? '',
            withCommit.boundSlideId ?? '',
            boundSource ?? ''
        ].join(':');
    }, [wallId, walls]);

    const autoOpenSignal = useMemo(() => {
        if (!wallId || !autoOpenProjectId || !autoOpenBindingSignature) return null;
        return `wall:${wallId}:project:${autoOpenProjectId}:sig:${autoOpenBindingSignature}:rev:${autoOpenRevision}`;
    }, [wallId, autoOpenProjectId, autoOpenBindingSignature, autoOpenRevision]);

    const liveSessionStartedSignal = useMemo(() => {
        if (!wallId) return null;
        return `wall:${wallId}:live:${liveSessionRevision}`;
    }, [wallId, liveSessionRevision]);
    const syncedCloseSignal = useMemo(() => {
        if (!wallId || syncedCloseRevision <= 0) return null;
        return `wall:${wallId}:close:${syncedCloseProjectId}:rev:${syncedCloseRevision}`;
    }, [wallId, syncedCloseProjectId, syncedCloseRevision]);

    useEffect(() => {
        if (!autoOpenProjectId) return;
        if (activeTag === null) return;
        setActiveTag(null);
    }, [autoOpenProjectId, activeTag]);

    if (galleryEnrollmentGateActive) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-5 bg-background px-6 text-center text-neutral-500">
                <TriangleDashedIcon size={56} weight="thin" />
                <p className="text-center text-xl font-medium">
                    This gallery hasn't been registered yet
                </p>
                <div className="flex flex-col items-center p-10">
                    {enrollmentQrDataUrl ? (
                        <img
                            src={enrollmentQrDataUrl}
                            alt="Device enrollment QR code"
                            loading="eager"
                            fetchPriority="high"
                            decoding="async"
                            width={200}
                            height={200}
                        />
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col overflow-hidden pt-30 pb-30">
            {pendingOverride ? (
                <div className="fixed inset-0 z-80 flex items-center justify-center">
                    <div className="absolute inset-0 bg-background/90" />
                    <div className="relative z-81 w-[min(42rem,95vw)] rounded-lg border border-border bg-background p-4 shadow-2xl">
                        <div className="flex flex-col gap-3">
                            <div className="text-sm font-semibold">
                                Takeover request from{' '}
                                {formatRequesterLabel(pendingOverride.requesterEmail)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                <span className="font-bold">
                                    {formatRequesterLabel(pendingOverride.requesterEmail)}
                                </span>{' '}
                                wants to take over the wall. Approving will switch away from the
                                current live content.
                            </div>
                            <div className="text-xs text-muted-foreground">
                                For safety, this request auto-declines in {overrideSecondsLeft}s.
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => decideOverride(false)}
                                >
                                    Deny
                                </Button>
                                <Button size="sm" onClick={() => decideOverride(true)}>
                                    Approve
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-8 px-8 md:flex-row md:px-[5vw]">
                <aside ref={filtersAsideRef} className="w-full shrink-0 md:w-1/5">
                    <h2 className="mb-4 text-lg font-semibold">Filters</h2>
                    <div className="flex flex-wrap gap-2 md:flex-col md:flex-nowrap">
                        <Button
                            variant={!activeTag ? 'secondary' : 'ghost'}
                            onClick={() => setActiveTag(null)}
                            className="justify-start"
                        >
                            All ({projectsData.length})
                        </Button>
                        {allTags.map((tag) => (
                            <Button
                                key={tag}
                                variant={activeTag === tag ? 'secondary' : 'ghost'}
                                onClick={() => setActiveTag(tag)}
                                className="justify-start"
                            >
                                {tag}
                            </Button>
                        ))}
                    </div>
                </aside>
                <main className="relative min-h-0 w-full flex-1 md:w-4/5">
                    <div className="gallery-gradient pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent" />
                    <div className="h-full scrollbar-none overflow-y-auto py-6">
                        {filteredProjects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-12 text-muted-foreground">
                                <p>No published projects yet</p>
                            </div>
                        ) : (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                                <AnimatePresence mode="popLayout">
                                    {filteredProjects.map((project) => (
                                        <motion.div
                                            key={project.id}
                                            className="relative"
                                            layout
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.95 }}
                                            transition={{
                                                type: 'spring',
                                                duration: 0.3,
                                                bounce: 0.2
                                            }}
                                        >
                                            <GalleryProjectCard
                                                project={project}
                                                allowWallActions={!galleryEnrollmentGateActive}
                                                autoOpenSignal={
                                                    autoOpenProjectId === project.id
                                                        ? autoOpenSignal
                                                        : null
                                                }
                                                forceDemoteFullscreenSignal={
                                                    liveSessionStartedSignal
                                                }
                                                forceCloseMinimizedSignal={liveSessionStartedSignal}
                                                forceCloseSignal={
                                                    syncedCloseProjectId === project.id
                                                        ? syncedCloseSignal
                                                        : null
                                                }
                                            />
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </div>
                        )}
                    </div>
                    <div className="gallery-gradient pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t from-background to-transparent" />
                </main>
            </div>
        </div>
    );
}
