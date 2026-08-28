import {
    ArrowsClockwiseIcon,
    ArrowLeftIcon,
    CheckCircleIcon,
    PlusIcon,
    TrashIcon,
    UserPlusIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import type { SignageSlideEntry } from '@repo/db/documents';
import { stageLayoutsEqual } from '@repo/db/schema';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { SignageEntryList } from '~/components/SignageEntryList';
import { WallPresetPicker } from '~/components/WallPresetPicker';
import { canEditSlideshow, isGlobalManager } from '~/lib/signageAccess';
import { adminWallsQueryOptions } from '~/server/admin.queries';
import { wallLayoutTemplatesQueryOptions } from '~/server/projects.queries';
import { $deleteSignageSlideshow, $updateSignageSlideshow } from '~/server/signage.fns';
import {
    signageEntryStatusQueryOptions,
    signageRuntimeStatusQueryOptions,
    signageSlideshowQueryOptions,
    signageSlideshowsQueryOptions,
    signageSourcesQueryOptions
} from '~/server/signage.queries';

export const Route = createFileRoute('/admin/signage/$slideshowId')({
    loader: ({ context, params }) =>
        Promise.all([
            context.queryClient.ensureQueryData(signageSlideshowQueryOptions(params.slideshowId)),
            context.queryClient.ensureQueryData(signageEntryStatusQueryOptions(params.slideshowId)),
            context.queryClient.ensureQueryData(wallLayoutTemplatesQueryOptions())
        ]),
    component: SignageDetail,
    head: () => ({ meta: [{ title: 'Configure Signage · Vizzy Studio' }] })
});

function SignageDetail() {
    const { slideshowId } = Route.useParams();
    const { data: slideshow } = useSuspenseQuery(signageSlideshowQueryOptions(slideshowId));
    return <SignageEditor key={`${slideshow.id}:${slideshow.updatedAt}`} initial={slideshow} />;
}

function SignageEditor({
    initial
}: {
    initial: Awaited<ReturnType<typeof import('~/server/signage.fns').$getSignageSlideshow>>;
}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { data: user } = useSuspenseQuery(authQueryOptions());
    const { data: persistedStatus } = useSuspenseQuery(signageEntryStatusQueryOptions(initial.id));
    const [draft, setDraft] = useState(initial);
    const globalManager = isGlobalManager(user);
    const canEdit = canEditSlideshow(user, initial);
    const canDelete = canEdit && (globalManager || !initial.enabled);
    const sourcesQuery = useQuery(signageSourcesQueryOptions(draft.layout));
    const runtimeQuery = useQuery(signageRuntimeStatusQueryOptions(initial.id));
    const wallsQuery = useQuery({
        ...adminWallsQueryOptions(),
        enabled: globalManager
    });
    const statusByEntryId = new Map(persistedStatus.map((status) => [status.entry.id, status]));

    const saveMutation = useMutation({
        mutationFn: () =>
            $updateSignageSlideshow({
                data: {
                    id: draft.id,
                    name: draft.name,
                    layout: draft.layout,
                    defaultDisplayDurationMs: draft.defaultDisplayDurationMs,
                    defaultGapDurationMs: draft.defaultGapDurationMs,
                    gapMode: draft.gapMode,
                    entries: draft.entries,
                    targetWallIds: draft.targetWallIds,
                    enabled: draft.enabled,
                    collaborators: draft.collaborators.filter(
                        ({ email }) => email.trim().length > 0
                    )
                }
            }),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['signage', 'slideshows'] }),
                queryClient.invalidateQueries({
                    queryKey: ['signage', 'slideshows', initial.id]
                })
            ]);
            toast.success('Slideshow saved');
        },
        onError: (error: Error) => toast.error(error.message)
    });

    const deleteMutation = useMutation({
        mutationFn: () => $deleteSignageSlideshow({ data: { id: initial.id } }),
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: signageSlideshowsQueryOptions().queryKey
            });
            navigate({ to: '/admin/signage' });
        },
        onError: (error: Error) => toast.error(error.message)
    });

    const addSlides = (projectId: string, slides: Array<{ id: string }>) => {
        setDraft((current) => ({
            ...current,
            entries: [
                ...current.entries,
                ...slides.map(
                    ({ id }): SignageSlideEntry => ({
                        id: crypto.randomUUID(),
                        projectId,
                        slideId: id
                    })
                )
            ]
        }));
    };

    const refreshProjectSlides = (projectId: string, slides: Array<{ id: string }>) => {
        setDraft((current) => ({
            ...current,
            entries: (() => {
                const existing = current.entries.filter((entry) => entry.projectId === projectId);
                const insertAt = current.entries.findIndex(
                    (entry) => entry.projectId === projectId
                );
                const retained = current.entries.filter((entry) => entry.projectId !== projectId);
                const refreshed = slides.map(({ id }): SignageSlideEntry => {
                    const previous = existing.find((entry) => entry.slideId === id);
                    return (
                        previous ?? {
                            id: crypto.randomUUID(),
                            projectId,
                            slideId: id
                        }
                    );
                });
                const target = insertAt < 0 ? retained.length : insertAt;
                return [...retained.slice(0, target), ...refreshed, ...retained.slice(target)];
            })()
        }));
        toast.success('Project entries refreshed from the latest stage content');
    };

    const updateDefaultSeconds = (
        key: 'defaultDisplayDurationMs' | 'defaultGapDurationMs',
        value: string,
        minimumMs: number
    ) => {
        const seconds = Number.parseFloat(value);
        setDraft((current) => ({
            ...current,
            [key]: Math.max(minimumMs, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1_000))
        }));
    };

    const runtime = runtimeQuery.data;
    const runtimeEntry = runtime?.currentEntryId
        ? statusByEntryId.get(runtime.currentEntryId)
        : undefined;
    const secondsToTransition = runtime?.nextTransitionAt
        ? Math.max(0, Math.ceil((runtime.nextTransitionAt - runtimeQuery.dataUpdatedAt) / 1_000))
        : null;

    return (
        <div className="space-y-6 pb-10">
            <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" render={<Link to="/admin/signage" />}>
                    <ArrowLeftIcon /> Slideshows
                </Button>
                <div className="flex gap-2">
                    <Button
                        variant="destructive"
                        disabled={!canDelete || deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate()}
                    >
                        <TrashIcon /> Delete
                    </Button>
                    <Button
                        disabled={!canEdit || saveMutation.isPending || !draft.name.trim()}
                        onClick={() => saveMutation.mutate()}
                    >
                        Save
                    </Button>
                </div>
            </div>

            {!canEdit && (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                    You have read-only access to this slideshow.
                </p>
            )}

            <section className="space-y-4 rounded-lg border p-4">
                <h3 className="font-medium">Configuration</h3>
                <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                        <Label htmlFor="slideshow-name">Name</Label>
                        <Input
                            id="slideshow-name"
                            value={draft.name}
                            disabled={!canEdit}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    name: event.target.value
                                }))
                            }
                        />
                    </div>
                    <WallPresetPicker
                        idPrefix="slideshow-layout"
                        value={draft.layout}
                        disabled={!canEdit}
                        onChange={(layout) => {
                            if (!layout) return;
                            setDraft((current) => ({ ...current, layout }));
                        }}
                    />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                    <div className="space-y-1">
                        <Label htmlFor="display-duration">Default display (seconds)</Label>
                        <Input
                            id="display-duration"
                            type="number"
                            min={0.1}
                            step={0.1}
                            disabled={!canEdit}
                            value={draft.defaultDisplayDurationMs / 1_000}
                            onChange={(event) =>
                                updateDefaultSeconds(
                                    'defaultDisplayDurationMs',
                                    event.target.value,
                                    100
                                )
                            }
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="gap-duration">Default gap (seconds)</Label>
                        <Input
                            id="gap-duration"
                            type="number"
                            min={0}
                            step={0.1}
                            disabled={!canEdit}
                            value={draft.defaultGapDurationMs / 1_000}
                            onChange={(event) =>
                                updateDefaultSeconds('defaultGapDurationMs', event.target.value, 0)
                            }
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="gap-mode">Gap mode</Label>
                        <select
                            id="gap-mode"
                            className="h-8 w-full border border-input bg-input/30 px-2.5 text-sm disabled:opacity-50"
                            value={draft.gapMode}
                            disabled={!canEdit}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    gapMode: event.target.value === 'blank' ? 'blank' : 'hold'
                                }))
                            }
                        >
                            <option value="hold">Hold current slide</option>
                            <option value="blank">Black frame</option>
                        </select>
                    </div>
                </div>
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 className="font-medium">Playback status</h3>
                        <p className="text-xs text-muted-foreground">
                            Live status from the server-authoritative slideshow runner.
                        </p>
                    </div>
                    <Badge
                        variant={
                            runtime?.state === 'running'
                                ? 'default'
                                : runtime?.state === 'waiting'
                                  ? 'destructive'
                                  : 'outline'
                        }
                    >
                        {runtimeQuery.isLoading
                            ? 'Loading'
                            : runtime?.state === 'running'
                              ? runtime.phase === 'gap'
                                  ? 'Gap'
                                  : 'Playing'
                              : runtime?.state === 'waiting'
                                ? 'Waiting for a valid entry'
                                : runtime?.state === 'starting'
                                  ? 'Starting'
                                  : 'Disabled'}
                    </Badge>
                </div>

                {runtime?.state === 'running' && (
                    <div className="rounded-lg bg-muted/40 p-3 text-sm">
                        <div className="flex items-center gap-2 font-medium">
                            <CheckCircleIcon className="text-green-600" />
                            {runtimeEntry?.slideName ?? runtime.currentEntryId}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {runtimeEntry?.projectName}
                            {runtimeEntry?.stageName ? ` · ${runtimeEntry.stageName}` : ''}
                            {secondsToTransition !== null
                                ? ` · Next transition in ${secondsToTransition}s`
                                : ''}
                        </div>
                    </div>
                )}

                {runtimeQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading walls…</p>
                ) : runtime?.walls.length ? (
                    <div className="grid gap-2 md:grid-cols-2">
                        {runtime.walls.map((wall) => (
                            <div
                                key={wall.wallId}
                                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
                            >
                                <span className="font-mono text-xs">{wall.wallId}</span>
                                <span
                                    className={
                                        wall.lastBindError
                                            ? 'text-xs text-destructive'
                                            : wall.suppressed
                                              ? 'text-xs text-amber-600'
                                              : 'text-xs text-muted-foreground'
                                    }
                                >
                                    {wall.lastBindError
                                        ? `Bind failed: ${wall.lastBindError}`
                                        : wall.suppressed
                                          ? 'Editor presenting'
                                          : 'Server controlled'}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">No target walls assigned.</p>
                )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div>
                    <h3 className="font-medium">Slide sources</h3>
                    <p className="text-xs text-muted-foreground">
                        Only the unique active stage matching all four layout values is shown.
                    </p>
                </div>
                {sourcesQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading sources…</p>
                ) : sourcesQuery.data?.length ? (
                    <div className="space-y-3">
                        {sourcesQuery.data.map((source) => (
                            <div key={source.projectId} className="rounded border p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">
                                            {source.projectName}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {source.stageName}
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={!canEdit}
                                            onClick={() =>
                                                addSlides(source.projectId, source.slides)
                                            }
                                        >
                                            <PlusIcon /> Add all
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={!canEdit}
                                            onClick={() =>
                                                refreshProjectSlides(
                                                    source.projectId,
                                                    source.slides
                                                )
                                            }
                                        >
                                            <ArrowsClockwiseIcon /> Refresh imported
                                        </Button>
                                    </div>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {source.slides.map((slide) => (
                                        <Button
                                            key={slide.id}
                                            size="sm"
                                            variant="ghost"
                                            disabled={!canEdit}
                                            onClick={() => addSlides(source.projectId, [slide])}
                                        >
                                            <PlusIcon /> {slide.name}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        No accessible stage matches this layout.
                    </p>
                )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div>
                    <h3 className="font-medium">Loop entries</h3>
                    <p className="text-xs text-muted-foreground">
                        Drag entries to reorder them. Timing overrides are in seconds.
                    </p>
                </div>
                {draft.entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Import a project or add individual slides.
                    </p>
                ) : (
                    <SignageEntryList
                        entries={draft.entries}
                        statuses={persistedStatus}
                        defaultDisplayDurationMs={draft.defaultDisplayDurationMs}
                        defaultGapDurationMs={draft.defaultGapDurationMs}
                        onChange={(entries) => setDraft((current) => ({ ...current, entries }))}
                        readOnly={!canEdit}
                    />
                )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="font-medium">Sharing</h3>
                        <p className="text-xs text-muted-foreground">
                            Editors can update the loop; viewers have read-only access.
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!canEdit}
                        onClick={() =>
                            setDraft((current) => ({
                                ...current,
                                collaborators: [
                                    ...current.collaborators,
                                    { email: '', role: 'viewer' }
                                ]
                            }))
                        }
                    >
                        <UserPlusIcon /> Add collaborator
                    </Button>
                </div>
                {draft.collaborators.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                        This slideshow has no collaborators.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {draft.collaborators.map((collaborator, index) => (
                            <div
                                key={`collaborator-${index}`}
                                className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_140px_auto]"
                            >
                                <Input
                                    type="email"
                                    aria-label={`Collaborator ${index + 1} email`}
                                    placeholder="person@example.com"
                                    value={collaborator.email}
                                    disabled={!canEdit}
                                    onChange={(event) =>
                                        setDraft((current) => ({
                                            ...current,
                                            collaborators: current.collaborators.map(
                                                (candidate, candidateIndex) =>
                                                    candidateIndex === index
                                                        ? {
                                                              ...candidate,
                                                              email: event.target.value
                                                          }
                                                        : candidate
                                            )
                                        }))
                                    }
                                />
                                <select
                                    aria-label={`Collaborator ${index + 1} role`}
                                    className="h-8 rounded-md border border-input bg-transparent px-2.5 text-sm disabled:opacity-50 dark:bg-input/30"
                                    value={collaborator.role}
                                    disabled={!canEdit}
                                    onChange={(event) =>
                                        setDraft((current) => ({
                                            ...current,
                                            collaborators: current.collaborators.map(
                                                (candidate, candidateIndex) =>
                                                    candidateIndex === index
                                                        ? {
                                                              ...candidate,
                                                              role:
                                                                  event.target.value === 'editor'
                                                                      ? 'editor'
                                                                      : 'viewer'
                                                          }
                                                        : candidate
                                            )
                                        }))
                                    }
                                >
                                    <option value="viewer">Viewer</option>
                                    <option value="editor">Editor</option>
                                </select>
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`Remove collaborator ${index + 1}`}
                                    disabled={!canEdit}
                                    onClick={() =>
                                        setDraft((current) => ({
                                            ...current,
                                            collaborators: current.collaborators.filter(
                                                (_, candidateIndex) => candidateIndex !== index
                                            )
                                        }))
                                    }
                                >
                                    <TrashIcon />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {globalManager && (
                <section className="space-y-3 rounded-lg border p-4">
                    <div>
                        <h3 className="font-medium">Wall targets</h3>
                        <p className="text-xs text-muted-foreground">
                            A wall can only be targeted by one enabled slideshow at a time.
                        </p>
                    </div>
                    {wallsQuery.data?.map((wall) => {
                        const template = wall.layoutTemplate;
                        const layoutMatches = template && stageLayoutsEqual(template, draft.layout);
                        return (
                            <label
                                key={wall.wallId}
                                className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                            >
                                <input
                                    type="checkbox"
                                    checked={draft.targetWallIds.includes(wall.wallId)}
                                    onChange={(event) =>
                                        setDraft((current) => ({
                                            ...current,
                                            targetWallIds: event.target.checked
                                                ? [...current.targetWallIds, wall.wallId]
                                                : current.targetWallIds.filter(
                                                      (wallId) => wallId !== wall.wallId
                                                  )
                                        }))
                                    }
                                />
                                <span>{wall.name || wall.wallId}</span>
                                <span className="font-mono text-xs text-muted-foreground">
                                    {wall.wallId}
                                </span>
                                <Badge
                                    variant={
                                        !template
                                            ? 'outline'
                                            : layoutMatches
                                              ? 'secondary'
                                              : 'destructive'
                                    }
                                >
                                    {!template
                                        ? 'No layout template'
                                        : layoutMatches
                                          ? 'Layout matches'
                                          : `${template.columns}×${template.rows} · ${template.screenWidth}×${template.screenHeight}px`}
                                </Badge>
                            </label>
                        );
                    })}
                    <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    enabled: event.target.checked
                                }))
                            }
                        />
                        Enable server-driven loop
                    </label>
                </section>
            )}
        </div>
    );
}
