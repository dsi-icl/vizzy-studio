import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    CaretUpDownIcon,
    DotsThreeVerticalIcon,
    GlobeIcon,
    GlobeXIcon,
    MagnifyingGlassIcon,
    PlusIcon
} from '@phosphor-icons/react';
import type { ProjectDocument } from '@repo/db/documents';

type Project = Omit<ProjectDocument, '_id' | '_version'>;
import { authSessionQueryOptions } from '@repo/auth/tanstack/queries';
import { Badge } from '@repo/ui/components/badge';
import AnimatedBlurPattern from '@repo/ui/components/blur-pattern';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from '@repo/ui/components/dropdown-menu';
import { Input } from '@repo/ui/components/input';
import { ProjectImage } from '@repo/ui/components/project-image';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    useReactTable,
    type SortingState
} from '@tanstack/react-table';
import { useState } from 'react';
import { toast } from 'sonner';

import { $archiveProject, $publishCommit, $restoreProject } from '~/server/projects.fns';
import { projectsQueryOptions } from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(projectsQueryOptions());
    },
    component: QuarryIndex,
    head: () => ({
        meta: [{ title: 'Projects · Quarry · Vizzy Studio' }]
    })
});

const columnHelper = createColumnHelper<Project>();

function QuarryIndex() {
    const [showArchived, setShowArchived] = useState(false);
    const [globalFilter, setGlobalFilter] = useState('');
    const [sorting, setSorting] = useState<SortingState>([]);
    // Suspense-load the default set so the page renders immediately,
    // then use a non-suspending query for the toggled variant.
    const { data: defaultProjects } = useSuspenseQuery(projectsQueryOptions(false));
    const { data: archivedProjects } = useQuery({
        ...projectsQueryOptions(true),
        enabled: showArchived
    });
    const projects = showArchived ? (archivedProjects ?? defaultProjects) : defaultProjects;
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['projects'] });

    const archiveMutation = useMutation({
        mutationFn: (id: string) => $archiveProject({ data: { id } }),
        onSuccess: () => {
            toast.success('Project archived');
            invalidate();
        },
        onError: (e) => toast.error(e.message)
    });

    const restoreMutation = useMutation({
        mutationFn: (id: string) => $restoreProject({ data: { id } }),
        onSuccess: () => {
            toast.success('Project restored');
            invalidate();
        },
        onError: (e) => toast.error(e.message)
    });

    const unpublishMutation = useMutation({
        mutationFn: (projectId: string) => $publishCommit({ data: { projectId, commitId: null } }),
        onSuccess: () => {
            toast.success('Project unpublished');
            invalidate();
        },
        onError: (e) => toast.error(e.message)
    });

    const columns = [
        columnHelper.display({
            id: 'thumbnail',
            header: '',
            size: 58,
            cell: (info) => {
                const heroUrl = info.row.original.heroImages?.[0];
                return (
                    <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                        {heroUrl ? (
                            <ProjectImage
                                src={heroUrl}
                                alt={info.row.original.name}
                                className="h-full w-full"
                                imgClassName="object-cover"
                            />
                        ) : (
                            <AnimatedBlurPattern
                                seed={info.row.original.name}
                                width={400}
                                height={400}
                                className="h-full w-full"
                            />
                        )}
                    </div>
                );
            },
            enableSorting: false
        }),
        columnHelper.accessor('name', {
            header: ({ column }) => (
                <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => column.toggleSorting()}
                >
                    Name <CaretUpDownIcon className="size-3" />
                </button>
            ),
            cell: (info) => (
                <div>
                    <div className="flex items-center gap-2 font-medium">
                        {info.getValue()}
                        {info.row.original.deletedAt && (
                            <Badge variant="secondary" className="text-xs">
                                Archived
                            </Badge>
                        )}
                        {info.row.original.visibility === 'public' && (
                            <Badge variant="default" className="text-xs">
                                Public
                            </Badge>
                        )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {info.row.original.authorOrganisation}
                    </p>
                </div>
            )
        }),
        columnHelper.accessor('tags', {
            header: 'Tags',
            cell: (info) => (
                <div className="flex flex-wrap gap-1">
                    {info
                        .getValue()
                        .slice(0, 3)
                        .map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                                {tag}
                            </Badge>
                        ))}
                </div>
            ),
            enableSorting: false
        }),
        columnHelper.accessor('collaborators', {
            header: 'Collaborators',
            cell: (info) => <span className="text-muted-foreground">{info.getValue().length}</span>,
            enableSorting: false
        }),
        columnHelper.accessor('updatedAt', {
            header: ({ column }) => (
                <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => column.toggleSorting()}
                >
                    Updated <CaretUpDownIcon className="size-3" />
                </button>
            ),
            cell: (info) => (
                <DateDisplay value={info.getValue()} className="text-muted-foreground" />
            )
        }),
        columnHelper.display({
            id: 'actions',
            cell: (info) => {
                const project = info.row.original;
                return (
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            className="rounded-lg p-1 hover:bg-muted"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <DotsThreeVerticalIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {project.publishedCommitId ? (
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        unpublishMutation.mutate(project.id);
                                    }}
                                >
                                    <GlobeXIcon /> Unpublish
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem disabled>
                                    <GlobeIcon /> Publish (select a commit first)
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {project.deletedAt ? (
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        restoreMutation.mutate(project.id);
                                    }}
                                >
                                    <ArrowCounterClockwiseIcon />
                                    Restore
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem
                                    variant="destructive"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        archiveMutation.mutate(project.id);
                                    }}
                                >
                                    <ArchiveIcon />
                                    Archive
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                );
            }
        })
    ];

    // oxlint-disable-next-line
    const table = useReactTable({
        data: projects,
        columns,
        state: { globalFilter, sorting },
        onGlobalFilterChange: setGlobalFilter,
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getSortedRowModel: getSortedRowModel(),
        globalFilterFn: (row, _columnId, filterValue: string) => {
            const search = filterValue.toLowerCase();
            const p = row.original;
            return (
                p.name.toLowerCase().includes(search) ||
                p.authorOrganisation.toLowerCase().includes(search) ||
                p.tags.some((t) => t.toLowerCase().includes(search))
            );
        }
    });

    return (
        <div
            className={`flex h-full flex-col overflow-hidden pb-14 ${isImpersonating ? 'pt-24' : 'pt-14'}`}
        >
            <div className="mx-auto w-full max-w-5xl shrink-0 px-6 pt-4">
                <div className="mb-6 flex items-center justify-between">
                    <h2 className="text-xl font-semibold">Projects</h2>
                    <Button render={<Link to="/quarry/projects/new" />} nativeButton={false}>
                        <PlusIcon /> New project
                    </Button>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <MagnifyingGlassIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Search projects..."
                            value={globalFilter}
                            onChange={(e) => setGlobalFilter(e.target.value)}
                            className="pl-9"
                        />
                    </div>
                    <Button
                        variant={showArchived ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setShowArchived(!showArchived)}
                    >
                        <ArchiveIcon />
                        {showArchived ? 'Hide archived' : 'Show archived'}
                    </Button>
                </div>
            </div>

            <div className="relative mx-auto min-h-0 w-full max-w-5xl flex-1">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent" />
                <div className="h-full scrollbar-none overflow-y-auto px-6 py-6">
                    {table.getRowModel().rows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-12 text-muted-foreground">
                            <p>No projects found</p>
                            <Button
                                render={<Link to="/quarry/projects/new" />}
                                variant="outline"
                                size="sm"
                                nativeButton={false}
                            >
                                Create your first project
                            </Button>
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-2xl border">
                            <table className="w-full text-sm">
                                <thead>
                                    {table.getHeaderGroups().map((headerGroup) => (
                                        <tr
                                            key={headerGroup.id}
                                            className="border-b bg-muted/50 text-left"
                                        >
                                            {headerGroup.headers.map((header) => (
                                                <th
                                                    key={header.id}
                                                    className="px-4 py-3 font-medium text-muted-foreground"
                                                >
                                                    {header.isPlaceholder
                                                        ? null
                                                        : flexRender(
                                                              header.column.columnDef.header,
                                                              header.getContext()
                                                          )}
                                                </th>
                                            ))}
                                        </tr>
                                    ))}
                                </thead>
                                <tbody>
                                    {table.getRowModel().rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-muted/30"
                                            onClick={() =>
                                                navigate({
                                                    to: '/quarry/projects/$projectId',
                                                    params: { projectId: row.original.id }
                                                })
                                            }
                                        >
                                            {row.getVisibleCells().map((cell) => (
                                                <td key={cell.id} className="px-4 py-3">
                                                    {flexRender(
                                                        cell.column.columnDef.cell,
                                                        cell.getContext()
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t from-background to-transparent" />
            </div>
        </div>
    );
}
