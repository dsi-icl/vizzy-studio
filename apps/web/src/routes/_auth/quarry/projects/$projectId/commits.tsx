import {
    ArrowUpIcon,
    CircleNotchIcon,
    EyeIcon,
    GitBranchIcon,
    GlobeIcon,
    GlobeXIcon,
    PencilSimpleIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import type { PublicDoc } from '@repo/db/collections';
import type { CommitDocument } from '@repo/db/documents';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
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
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { $promoteBranchHead, $publishCommit } from '~/server/projects.fns';
import { commitsQueryOptions, projectQueryOptions } from '~/server/projects.queries';

type Commit = PublicDoc<CommitDocument>;

/**
 * Sort commits topologically by walking the parentId chain from HEAD,
 * then from any other branch heads. Project HEAD branch comes first.
 */
function topoSort(commits: Commit[], headCommitId: string | null): Commit[] {
    if (commits.length === 0) return [];
    const byId = new Map(commits.map((c) => [c.id, c]));
    const sorted: Commit[] = [];
    const visited = new Set<string>();

    // Walk a chain from a starting commit
    const walkChain = (start: Commit | undefined) => {
        let current = start;
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            sorted.push(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
    };

    // 1. Walk from the project HEAD first
    const projectHead = headCommitId ? byId.get(headCommitId) : undefined;
    walkChain(projectHead);

    // 2. Walk from other mutable branch heads
    for (const c of commits) {
        if (c.isMutableHead && !visited.has(c.id)) {
            walkChain(c);
        }
    }

    // 3. Append any orphan commits not reachable from any head
    for (const c of commits) {
        if (!visited.has(c.id)) sorted.push(c);
    }

    return sorted;
}

/** Graph node for a single commit row */
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
    const cx = 12;
    const r = isMutableHead ? 5 : 4;
    return (
        <svg width={24} height="100%" className="min-h-10" aria-hidden>
            {/* Line above */}
            {!isFirst && (
                <line
                    x1={cx}
                    y1={0}
                    x2={cx}
                    y2="50%"
                    className="stroke-muted-foreground/40"
                    strokeWidth={2}
                />
            )}
            {/* Line below */}
            {!isLast && (
                <line
                    x1={cx}
                    y1="50%"
                    x2={cx}
                    y2="100%"
                    className="stroke-muted-foreground/40"
                    strokeWidth={2}
                />
            )}
            {/* Node circle */}
            <circle
                cx={cx}
                cy="50%"
                r={r}
                className={
                    isMutableHead
                        ? 'fill-primary stroke-primary'
                        : isPublished
                          ? 'fill-green-500 stroke-green-500'
                          : 'fill-muted-foreground/60 stroke-muted-foreground/60'
                }
                strokeWidth={isMutableHead ? 2 : 1.5}
            />
        </svg>
    );
}

export const Route = createFileRoute('/_auth/quarry/projects/$projectId/commits')({
    loader: async ({ context, params }) => {
        context.queryClient.ensureQueryData(commitsQueryOptions(params.projectId));
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    component: CommitsTab,
    head: ({ loaderData }) => ({
        meta: [{ title: `Commits · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    })
});

function CommitsTab() {
    const { projectId } = Route.useParams();
    const { data: user } = useSuspenseQuery(authQueryOptions());
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
    const { data: commits } = useSuspenseQuery(commitsQueryOptions(projectId));
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [openingEditorForCommitId, setOpeningEditorForCommitId] = useState<string | null>(null);

    const publishMutation = useMutation({
        mutationFn: (commitId: string | null) => $publishCommit({ data: { projectId, commitId } }),
        onSuccess: (isPublished) => {
            toast.success(isPublished ? 'Commit published' : 'Project unpublished');
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        },
        onError: (e) => toast.error(e.message)
    });

    const promoteMutation = useMutation({
        mutationFn: (branchCommitId: string) =>
            $promoteBranchHead({ data: { projectId, branchCommitId } }),
        onSuccess: () => {
            toast.success('Branch promoted to project HEAD');
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        },
        onError: (e) => toast.error(e.message)
    });

    const sorted = useMemo(
        () => topoSort(commits, project.headCommitId ?? null),
        [commits, project.headCommitId]
    );
    const canPublish =
        user?.role === 'admin' || user?.role === 'operator' || user?.trustedPublisher === true;

    const handleOpenEditor = async (input: { commitId: string; slideId: string }) => {
        setOpeningEditorForCommitId(input.commitId);
        try {
            await navigate({
                to: '/quarry/editor/$projectId/$commitId/$slideId',
                params: {
                    projectId,
                    commitId: input.commitId,
                    slideId: input.slideId
                }
            });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to open editor');
            setOpeningEditorForCommitId(null);
        }
    };

    if (commits.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-12 text-muted-foreground">
                <p>No commits yet</p>
                <p className="text-xs">Commits will appear here as changes are saved.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
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
                        {sorted.map((commit, idx) => {
                            const isPublished = commit.id === project.publishedCommitId;
                            return (
                                <TableRow key={commit.id}>
                                    <TableCell className="h-12 w-6 px-0 py-0!">
                                        <CommitGraphNode
                                            isFirst={idx === 0}
                                            isLast={idx === sorted.length - 1}
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
                                        {isPublished && (
                                            <Badge variant="default" className="text-xs">
                                                Published
                                            </Badge>
                                        )}
                                        {commit.isMutableHead &&
                                            commit.id !== project.headCommitId && (
                                                <Badge variant="outline" className="text-xs">
                                                    <GitBranchIcon /> Branch
                                                </Badge>
                                            )}
                                    </TableCell>
                                    <TableCell className="flex items-center gap-1">
                                        <Button
                                            render={
                                                <Link
                                                    to="/quarry/view/$projectId/$commitId"
                                                    params={{
                                                        projectId,
                                                        commitId: commit.id
                                                    }}
                                                />
                                            }
                                            variant="outline"
                                            size="xs"
                                            nativeButton={false}
                                        >
                                            <EyeIcon /> View
                                        </Button>
                                        {commit.isMutableHead &&
                                            commit.id !== project.headCommitId && (
                                                <Button
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={() =>
                                                        promoteMutation.mutate(commit.id)
                                                    }
                                                    disabled={promoteMutation.isPending}
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
                                                    disabled={publishMutation.isPending}
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
                                                    disabled={publishMutation.isPending}
                                                >
                                                    <GlobeIcon /> Publish
                                                </Button>
                                            ))}
                                        {commit.isMutableHead && commit.content?.slides?.[0]?.id ? (
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                onClick={() =>
                                                    handleOpenEditor({
                                                        commitId: commit.id,
                                                        slideId: commit.content.slides[0].id
                                                    })
                                                }
                                                disabled={openingEditorForCommitId !== null}
                                            >
                                                {openingEditorForCommitId === commit.id ? (
                                                    <>
                                                        <CircleNotchIcon className="animate-spin" />
                                                        Opening...
                                                    </>
                                                ) : (
                                                    <>
                                                        <PencilSimpleIcon /> Edit
                                                    </>
                                                )}
                                            </Button>
                                        ) : null}
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
