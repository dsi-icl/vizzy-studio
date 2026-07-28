import {
    ArrowDownIcon,
    ArrowLeftIcon,
    ArrowUpIcon,
    PlusIcon,
    TrashIcon,
    WarningIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import type { SignageSlideEntry } from '@repo/db/documents';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminWallsQueryOptions } from '~/server/admin.queries';
import { $deleteSignageSlideshow, $updateSignageSlideshow } from '~/server/signage.fns';
import {
    signageEntryStatusQueryOptions,
    signageSlideshowQueryOptions,
    signageSlideshowsQueryOptions,
    signageSourcesQueryOptions
} from '~/server/signage.queries';

export const Route = createFileRoute('/admin/signage/$slideshowId')({
    loader: ({ context, params }) =>
        Promise.all([
            context.queryClient.ensureQueryData(signageSlideshowQueryOptions(params.slideshowId)),
            context.queryClient.ensureQueryData(signageEntryStatusQueryOptions(params.slideshowId))
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
    const [collaboratorText, setCollaboratorText] = useState(
        initial.collaborators.map(({ email, role }) => `${email},${role}`).join('\n')
    );
    const isGlobalManager = user?.role === 'admin' || user?.role === 'operator';
    const sourcesQuery = useQuery(signageSourcesQueryOptions(draft.layout));
    const wallsQuery = useQuery({
        ...adminWallsQueryOptions(),
        enabled: isGlobalManager
    });
    const statusByEntryId = new Map(persistedStatus.map((status) => [status.entry.id, status]));

    const saveMutation = useMutation({
        mutationFn: () => {
            const collaborators = collaboratorText
                .split(/\r?\n/)
                .map((line) => {
                    const [email, role] = line.split(',').map((part) => part.trim());
                    return {
                        email,
                        role: role === 'viewer' ? ('viewer' as const) : ('editor' as const)
                    };
                })
                .filter(({ email }) => email.length > 0);
            return $updateSignageSlideshow({
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
                    collaborators
                }
            });
        },
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

    const updateDimension = (key: keyof typeof draft.layout, value: string) => {
        setDraft((current) => ({
            ...current,
            layout: {
                ...current.layout,
                [key]: Math.max(1, Number.parseInt(value, 10) || 1)
            }
        }));
    };

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

    const updateEntry = (index: number, patch: Partial<SignageSlideEntry>) => {
        setDraft((current) => ({
            ...current,
            entries: current.entries.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, ...patch } : entry
            )
        }));
    };

    const moveEntry = (index: number, direction: -1 | 1) => {
        const target = index + direction;
        if (target < 0 || target >= draft.entries.length) return;
        setDraft((current) => {
            const entries = current.entries.slice();
            [entries[index], entries[target]] = [entries[target], entries[index]];
            return { ...current, entries };
        });
    };

    return (
        <div className="space-y-6 pb-10">
            <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" render={<Link to="/admin/signage" />}>
                    <ArrowLeftIcon /> Slideshows
                </Button>
                <div className="flex gap-2">
                    <Button
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate()}
                    >
                        <TrashIcon /> Delete
                    </Button>
                    <Button
                        disabled={saveMutation.isPending || !draft.name.trim()}
                        onClick={() => saveMutation.mutate()}
                    >
                        Save
                    </Button>
                </div>
            </div>

            <section className="space-y-4 rounded-lg border p-4">
                <h3 className="font-medium">Configuration</h3>
                <div className="grid gap-3 md:grid-cols-5">
                    <div className="space-y-1">
                        <Label htmlFor="slideshow-name">Name</Label>
                        <Input
                            id="slideshow-name"
                            value={draft.name}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    name: event.target.value
                                }))
                            }
                        />
                    </div>
                    {(
                        [
                            ['columns', 'Columns'],
                            ['rows', 'Rows'],
                            ['screenWidth', 'Screen width'],
                            ['screenHeight', 'Screen height']
                        ] as const
                    ).map(([key, label]) => (
                        <div key={key} className="space-y-1">
                            <Label htmlFor={`layout-${key}`}>{label}</Label>
                            <Input
                                id={`layout-${key}`}
                                type="number"
                                min={1}
                                value={draft.layout[key]}
                                onChange={(event) => updateDimension(key, event.target.value)}
                            />
                        </div>
                    ))}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                    <div className="space-y-1">
                        <Label htmlFor="display-duration">Default display (ms)</Label>
                        <Input
                            id="display-duration"
                            type="number"
                            min={100}
                            value={draft.defaultDisplayDurationMs}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    defaultDisplayDurationMs: Math.max(
                                        100,
                                        Number.parseInt(event.target.value, 10) || 100
                                    )
                                }))
                            }
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="gap-duration">Default gap (ms)</Label>
                        <Input
                            id="gap-duration"
                            type="number"
                            min={0}
                            value={draft.defaultGapDurationMs}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    defaultGapDurationMs: Math.max(
                                        0,
                                        Number.parseInt(event.target.value, 10) || 0
                                    )
                                }))
                            }
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="gap-mode">Gap mode</Label>
                        <select
                            id="gap-mode"
                            className="h-8 w-full border border-input bg-input/30 px-2.5 text-sm"
                            value={draft.gapMode}
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
                <div>
                    <h3 className="font-medium">Published sources</h3>
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
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => addSlides(source.projectId, source.slides)}
                                    >
                                        <PlusIcon /> Import project
                                    </Button>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {source.slides.map((slide) => (
                                        <Button
                                            key={slide.id}
                                            size="sm"
                                            variant="ghost"
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
                        No accessible published stage matches this layout.
                    </p>
                )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <h3 className="font-medium">Loop entries</h3>
                {draft.entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Import a project or add individual published slides.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {draft.entries.map((entry, index) => {
                            const status = statusByEntryId.get(entry.id);
                            return (
                                <div
                                    key={entry.id}
                                    className="grid items-center gap-2 rounded border p-3 md:grid-cols-[1fr_140px_140px_auto]"
                                >
                                    <div>
                                        <div className="text-sm font-medium">
                                            {status?.slideName ?? entry.slideId}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {status?.projectName ?? entry.projectId}
                                            {status?.stageName ? ` · ${status.stageName}` : ''}
                                        </div>
                                        {status && !status.valid && (
                                            <div className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                                                <WarningIcon /> Skipped: {status.reason}
                                            </div>
                                        )}
                                        {!status && (
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                Save to validate this new entry.
                                            </div>
                                        )}
                                    </div>
                                    <Input
                                        aria-label="Display duration override"
                                        type="number"
                                        min={100}
                                        placeholder="Default display"
                                        value={entry.displayDurationMs ?? ''}
                                        onChange={(event) =>
                                            updateEntry(index, {
                                                displayDurationMs: event.target.value
                                                    ? Math.max(
                                                          100,
                                                          Number.parseInt(event.target.value, 10) ||
                                                              100
                                                      )
                                                    : undefined
                                            })
                                        }
                                    />
                                    <Input
                                        aria-label="Gap duration override"
                                        type="number"
                                        min={0}
                                        placeholder="Default gap"
                                        value={entry.gapDurationMs ?? ''}
                                        onChange={(event) =>
                                            updateEntry(index, {
                                                gapDurationMs: event.target.value
                                                    ? Math.max(
                                                          0,
                                                          Number.parseInt(event.target.value, 10) ||
                                                              0
                                                      )
                                                    : undefined
                                            })
                                        }
                                    />
                                    <div className="flex gap-1">
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === 0}
                                            onClick={() => moveEntry(index, -1)}
                                        >
                                            <ArrowUpIcon />
                                        </Button>
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === draft.entries.length - 1}
                                            onClick={() => moveEntry(index, 1)}
                                        >
                                            <ArrowDownIcon />
                                        </Button>
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() =>
                                                setDraft((current) => ({
                                                    ...current,
                                                    entries: current.entries.filter(
                                                        ({ id }) => id !== entry.id
                                                    )
                                                }))
                                            }
                                        >
                                            <TrashIcon />
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div>
                    <h3 className="font-medium">Sharing</h3>
                    <p className="text-xs text-muted-foreground">
                        One collaborator per line: email,editor or email,viewer.
                    </p>
                </div>
                <Textarea
                    value={collaboratorText}
                    onChange={(event) => setCollaboratorText(event.target.value)}
                    placeholder={'operator@example.com,editor\nobserver@example.com,viewer'}
                />
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <div>
                    <h3 className="font-medium">Wall targets</h3>
                    <p className="text-xs text-muted-foreground">
                        Only admins and operators can change targets or activation.
                    </p>
                </div>
                {isGlobalManager &&
                    wallsQuery.data?.map((wall) => (
                        <label key={wall.wallId} className="flex items-center gap-2 text-sm">
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
                            {wall.name || wall.wallId}
                            <span className="font-mono text-xs text-muted-foreground">
                                {wall.wallId}
                            </span>
                        </label>
                    ))}
                {!isGlobalManager && (
                    <p className="text-sm text-muted-foreground">
                        {draft.targetWallIds.length
                            ? draft.targetWallIds.join(', ')
                            : 'No walls assigned.'}
                    </p>
                )}
                <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                        type="checkbox"
                        checked={draft.enabled}
                        disabled={!isGlobalManager}
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
        </div>
    );
}
