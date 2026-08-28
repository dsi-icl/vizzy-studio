import {
    ArchiveIcon,
    ArrowUpIcon,
    CircleNotchIcon,
    EyeIcon,
    GitBranchIcon,
    GlobeIcon,
    GlobeXIcon,
    PencilSimpleIcon,
    PlusIcon,
    StarIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import type { PublicDoc } from '@repo/db/collections';
import type { CommitDocument, ProjectStage } from '@repo/db/documents';
import { stageLayoutKey, stageLayoutsEqual, type StageLayout } from '@repo/db/schema';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@repo/ui/components/table';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Suspense, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { WallPresetPicker } from '~/components/WallPresetPicker';
import { isGlobalManager } from '~/lib/signageAccess';
import {
    $archiveStage,
    $createStage,
    $ensureMutableHead,
    $getCommit,
    $promoteBranchHead,
    $publishCommit,
    $setDefaultStage,
    $updateStage
} from '~/server/projects.fns';
import {
    commitsQueryOptions,
    projectQueryOptions,
    stageLayoutLimitsQueryOptions,
    wallLayoutTemplatesQueryOptions
} from '~/server/projects.queries';

type Commit = PublicDoc<CommitDocument>;

function topoSort(commits: Commit[], headCommitId: string | null): Commit[] {
    if (commits.length === 0) return [];
    const byId = new Map(commits.map((commit) => [commit.id, commit]));
    const sorted: Commit[] = [];
    const visited = new Set<string>();
    const walkChain = (start: Commit | undefined) => {
        let current = start;
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            sorted.push(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
    };
    walkChain(headCommitId ? byId.get(headCommitId) : undefined);
    for (const commit of commits) {
        if (commit.isMutableHead && !visited.has(commit.id)) walkChain(commit);
    }
    for (const commit of commits) {
        if (!visited.has(commit.id)) sorted.push(commit);
    }
    return sorted;
}

function CommitGraphNode({
    isFirst,
    isLast,
    isMutableHead,
    isPublished
}: {
    isFirst: boolean;
    isLast: boolean;
    isMutableHead: boolean;
    isPublished: boolean;
}) {
    return (
        <svg width={24} height="100%" className="min-h-10" aria-hidden>
            {!isFirst && (
                <line
                    x1={12}
                    y1={0}
                    x2={12}
                    y2="50%"
                    className="stroke-muted-foreground/40"
                    strokeWidth={2}
                />
            )}
            {!isLast && (
                <line
                    x1={12}
                    y1="50%"
                    x2={12}
                    y2="100%"
                    className="stroke-muted-foreground/40"
                    strokeWidth={2}
                />
            )}
            <circle
                cx={12}
                cy="50%"
                r={isMutableHead ? 5 : 4}
                className={
                    isMutableHead
                        ? 'fill-primary stroke-primary'
                        : isPublished
                          ? 'fill-green-500 stroke-green-500'
                          : 'fill-muted-foreground/60 stroke-muted-foreground/60'
                }
            />
        </svg>
    );
}

export const Route = createFileRoute('/_auth/quarry/projects/$projectId/commits')({
    loader: async ({ context, params }) => {
        const [project] = await Promise.all([
            context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
            context.queryClient.ensureQueryData(wallLayoutTemplatesQueryOptions()),
            context.queryClient.ensureQueryData(stageLayoutLimitsQueryOptions())
        ]);
        if (project?.defaultStageId) {
            await context.queryClient.ensureQueryData(
                commitsQueryOptions(params.projectId, project.defaultStageId)
            );
        }
        return { projectName: project?.name ?? 'Project' };
    },
    component: StagesTab,
    head: ({ loaderData }) => ({
        meta: [{ title: `Stages · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    })
});

function StagesTab() {
    const { projectId } = Route.useParams();
    const { data: user } = useSuspenseQuery(authQueryOptions());
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
    const globalManager = isGlobalManager(user);
    const [selectedStageId, setSelectedStageId] = useState(project.defaultStageId);
    const selectedStage =
        project.stages.find(({ id }) => id === selectedStageId) ??
        project.stages.find(({ id }) => id === project.defaultStageId) ??
        project.stages[0];
    if (!selectedStage) throw new Error('Project has no stages');

    return (
        <div className="grid min-h-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
            <StageList
                projectId={projectId}
                stages={project.stages}
                defaultStageId={project.defaultStageId}
                selectedStageId={selectedStage.id}
                onSelect={setSelectedStageId}
            />
            <div className="min-w-0">
                <Suspense
                    fallback={
                        <CircleNotchIcon
                            size={24}
                            className="mx-auto my-24 block animate-spin text-muted-foreground"
                        />
                    }
                >
                    <StageDetail
                        key={selectedStage.id}
                        projectId={projectId}
                        stage={selectedStage}
                        stages={project.stages}
                        isDefault={selectedStage.id === project.defaultStageId}
                        canPublish={globalManager || user?.trustedPublisher === true}
                    />
                </Suspense>
            </div>
        </div>
    );
}

function StageList({
    projectId,
    stages,
    defaultStageId,
    selectedStageId,
    onSelect
}: {
    projectId: string;
    stages: ProjectStage[];
    defaultStageId: string;
    selectedStageId: string;
    onSelect: (stageId: string) => void;
}) {
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [nameEdited, setNameEdited] = useState(false);
    const [layout, setLayout] = useState<StageLayout | null>(null);
    const { data: limits } = useSuspenseQuery(stageLayoutLimitsQueryOptions());
    const takenLayoutKeys = useMemo(
        () =>
            new Set(
                stages
                    .filter((stage) => !stage.archivedAt)
                    .map((stage) => stageLayoutKey(stage.layout))
            ),
        [stages]
    );
    const createMutation = useMutation({
        mutationFn: () => $createStage({ data: { projectId, name: name.trim(), layout: layout! } }),
        onSuccess: (stage) => {
            queryClient.invalidateQueries({ queryKey: ['projects'] });
            setCreating(false);
            onSelect(stage.id);
            toast.success('Stage created');
        },
        onError: (error) => toast.error(error.message)
    });

    const resetDraft = () => {
        setName('');
        setNameEdited(false);
        setLayout(null);
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="font-medium">Project stages</h3>
                <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                        if (!creating) resetDraft();
                        setCreating((value) => !value);
                    }}
                >
                    <PlusIcon /> Add
                </Button>
            </div>
            {creating && (
                <div className="space-y-3 rounded-xl border p-3">
                    <WallPresetPicker
                        idPrefix="new-stage"
                        value={layout}
                        takenLayoutKeys={takenLayoutKeys}
                        onChange={(nextLayout, preset) => {
                            setLayout(nextLayout);
                            if (!nameEdited) setName(preset?.name ?? '');
                        }}
                    />
                    <div className="space-y-1">
                        <Label htmlFor="new-stage-name">Name</Label>
                        <Input
                            id="new-stage-name"
                            value={name}
                            placeholder="Stage name"
                            onChange={(event) => {
                                setName(event.target.value);
                                setNameEdited(true);
                            }}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Current grid maximum: {limits.maxColumns}×{limits.maxRows}
                    </p>
                    <Button
                        size="sm"
                        className="w-full"
                        disabled={createMutation.isPending || !layout || !name.trim()}
                        onClick={() => createMutation.mutate()}
                    >
                        Create stage
                    </Button>
                </div>
            )}
            <div className="space-y-2">
                {[...stages]
                    .sort((left, right) => left.order - right.order)
                    .map((stage) => (
                        <button
                            type="button"
                            key={stage.id}
                            className={`w-full rounded-xl border p-3 text-left transition-colors ${
                                selectedStageId === stage.id
                                    ? 'border-primary bg-primary/5'
                                    : 'hover:bg-muted/50'
                            } ${stage.archivedAt ? 'opacity-60' : ''}`}
                            onClick={() => onSelect(stage.id)}
                        >
                            <span className="flex items-center gap-2 font-medium">
                                {stage.name}
                                {stage.id === defaultStageId && <StarIcon weight="fill" />}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                                {stage.layout.columns}×{stage.layout.rows} ·{' '}
                                {stage.layout.screenWidth}×{stage.layout.screenHeight}px
                            </span>
                            <span className="mt-2 flex gap-1">
                                {stage.publishedCommitId && (
                                    <Badge variant="default">Published</Badge>
                                )}
                                {stage.archivedAt && <Badge variant="secondary">Archived</Badge>}
                            </span>
                        </button>
                    ))}
            </div>
        </div>
    );
}

function StageDetail({
    projectId,
    stage,
    stages,
    isDefault,
    canPublish
}: {
    projectId: string;
    stage: ProjectStage;
    stages: ProjectStage[];
    isDefault: boolean;
    canPublish: boolean;
}) {
    const { data: commits } = useSuspenseQuery(commitsQueryOptions(projectId, stage.id));
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [name, setName] = useState(stage.name);
    const [layout, setLayout] = useState<StageLayout | null>(stage.layout);
    const [openingEditor, setOpeningEditor] = useState(false);
    const takenLayoutKeys = useMemo(
        () =>
            new Set(
                stages
                    .filter((other) => !other.archivedAt && other.id !== stage.id)
                    .map((other) => stageLayoutKey(other.layout))
            ),
        [stages, stage.id]
    );
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['projects'] });

    const updateMutation = useMutation({
        mutationFn: () =>
            $updateStage({
                data: { projectId, stageId: stage.id, name: name.trim(), layout: layout! }
            }),
        onSuccess: () => {
            invalidate();
            toast.success('Stage updated');
        },
        onError: (error) => toast.error(error.message)
    });
    const defaultMutation = useMutation({
        mutationFn: () => $setDefaultStage({ data: { projectId, stageId: stage.id } }),
        onSuccess: () => {
            invalidate();
            toast.success('Default stage updated');
        },
        onError: (error) => toast.error(error.message)
    });
    const archiveMutation = useMutation({
        mutationFn: () => $archiveStage({ data: { projectId, stageId: stage.id } }),
        onSuccess: () => {
            invalidate();
            toast.success('Stage archived');
        },
        onError: (error) => toast.error(error.message)
    });
    const publishMutation = useMutation({
        mutationFn: (commitId: string | null) =>
            $publishCommit({ data: { projectId, stageId: stage.id, commitId } }),
        onSuccess: (published) => {
            invalidate();
            toast.success(published ? 'Stage published' : 'Stage unpublished');
        },
        onError: (error) => toast.error(error.message)
    });
    const promoteMutation = useMutation({
        mutationFn: (branchCommitId: string) =>
            $promoteBranchHead({ data: { projectId, branchCommitId } }),
        onSuccess: () => {
            invalidate();
            queryClient.invalidateQueries({
                queryKey: ['projects', projectId, 'stages', stage.id, 'commits']
            });
            toast.success('Branch promoted to stage HEAD');
        },
        onError: (error) => toast.error(error.message)
    });
    const sorted = useMemo(
        () => topoSort(commits, stage.headCommitId),
        [commits, stage.headCommitId]
    );

    const openStageEditor = async () => {
        setOpeningEditor(true);
        try {
            const commitId = await $ensureMutableHead({
                data: { projectId, stageId: stage.id }
            });
            const commit = await $getCommit({ data: { id: commitId } });
            const slideId = commit?.content.slides[0]?.id;
            if (!slideId) throw new Error('Stage has no slides');
            await navigate({
                to: '/quarry/editor/$projectId/$commitId/$slideId',
                params: { projectId, commitId, slideId }
            });
        } catch (error) {
            setOpeningEditor(false);
            toast.error(error instanceof Error ? error.message : 'Could not open stage');
        }
    };

    return (
        <div className="min-w-0 space-y-5">
            <div className="space-y-4 rounded-2xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 className="font-medium">{stage.name}</h3>
                        <p className="text-xs text-muted-foreground">
                            {isDefault
                                ? 'Default editing and global Gallery stage'
                                : 'Independent stage history'}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {!stage.archivedAt && (
                            <Button size="sm" onClick={openStageEditor} disabled={openingEditor}>
                                {openingEditor ? (
                                    <CircleNotchIcon className="animate-spin" />
                                ) : (
                                    <PencilSimpleIcon />
                                )}
                                Edit stage
                            </Button>
                        )}
                        {!isDefault && !stage.archivedAt && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => defaultMutation.mutate()}
                            >
                                <StarIcon /> Make default
                            </Button>
                        )}
                        {!stage.archivedAt && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => archiveMutation.mutate()}
                            >
                                <ArchiveIcon /> Archive
                            </Button>
                        )}
                    </div>
                </div>
                {!stage.archivedAt && (
                    <>
                        <div className="space-y-1">
                            <Label htmlFor="stage-name">Stage name</Label>
                            <Input
                                id="stage-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </div>
                        <WallPresetPicker
                            idPrefix="stage-layout"
                            value={layout}
                            takenLayoutKeys={takenLayoutKeys}
                            onChange={(nextLayout) => setLayout(nextLayout)}
                        />
                        {stage.publishedCommitId &&
                            layout &&
                            !stageLayoutsEqual(layout, stage.layout) && (
                                <p className="text-xs text-amber-600 dark:text-amber-500">
                                    This stage has a published commit. Changing the wall re-renders
                                    that published content on the new grid, and layers keep their
                                    current pixel positions — you will need to reposition them.
                                </p>
                            )}
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={updateMutation.isPending || !layout || !name.trim()}
                            onClick={() => updateMutation.mutate()}
                        >
                            Save stage settings
                        </Button>
                    </>
                )}
            </div>

            <div className="overflow-hidden rounded-2xl border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-6 px-0" />
                            <TableHead>Message</TableHead>
                            <TableHead>Author</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {sorted.length === 0 && (
                            <TableRow>
                                <TableCell
                                    colSpan={6}
                                    className="py-8 text-center text-muted-foreground"
                                >
                                    Open this stage in the Editor to create its HEAD.
                                </TableCell>
                            </TableRow>
                        )}
                        {sorted.map((commit, index) => {
                            const isPublished = commit.id === stage.publishedCommitId;
                            return (
                                <TableRow key={commit.id}>
                                    <TableCell className="h-12 w-6 px-0 py-0!">
                                        <CommitGraphNode
                                            isFirst={index === 0}
                                            isLast={index === sorted.length - 1}
                                            isMutableHead={commit.isMutableHead}
                                            isPublished={isPublished}
                                        />
                                    </TableCell>
                                    <TableCell className="font-medium">{commit.message}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {commit.authorEmail ?? '-'}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        <DateDisplay
                                            value={commit.updatedAt ?? commit.createdAt}
                                            fallback="-"
                                        />
                                    </TableCell>
                                    <TableCell>
                                        {isPublished && <Badge>Published</Badge>}
                                        {commit.isMutableHead &&
                                            commit.id !== stage.headCommitId && (
                                                <Badge variant="outline">
                                                    <GitBranchIcon /> Branch
                                                </Badge>
                                            )}
                                    </TableCell>
                                    <TableCell className="flex items-center gap-1">
                                        <Button
                                            render={
                                                <Link
                                                    to="/quarry/view/$projectId/$commitId"
                                                    params={{ projectId, commitId: commit.id }}
                                                />
                                            }
                                            variant="outline"
                                            size="xs"
                                            nativeButton={false}
                                        >
                                            <EyeIcon /> View
                                        </Button>
                                        {commit.isMutableHead &&
                                            commit.id !== stage.headCommitId && (
                                                <Button
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={() =>
                                                        promoteMutation.mutate(commit.id)
                                                    }
                                                >
                                                    <ArrowUpIcon /> Promote
                                                </Button>
                                            )}
                                        {canPublish &&
                                            (isPublished ? (
                                                <Button
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={() => publishMutation.mutate(null)}
                                                >
                                                    <GlobeXIcon /> Unpublish
                                                </Button>
                                            ) : (
                                                <Button
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={() =>
                                                        publishMutation.mutate(commit.id)
                                                    }
                                                >
                                                    <GlobeIcon /> Publish
                                                </Button>
                                            ))}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
