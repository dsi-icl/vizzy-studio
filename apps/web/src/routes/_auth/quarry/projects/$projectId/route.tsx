import {
    ArrowLeftIcon,
    CircleNotchIcon,
    ClockIcon,
    FolderIcon,
    GlobeIcon,
    GitBranchIcon,
    ImageIcon,
    PencilSimpleIcon,
    UsersIcon,
    CodeIcon
} from '@phosphor-icons/react';
import { authQueryOptions, authSessionQueryOptions } from '@repo/auth/tanstack/queries';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
    createFileRoute,
    Link,
    Outlet,
    useLocation,
    useNavigate,
    useRouterState
} from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SubHeaderSlotOutlet, SubHeaderSlotProvider } from '~/lib/subHeaderSlot';
import {
    $ensureMutableHead,
    $getCommit,
    $publishCommit,
    $publishCustomRenderProject
} from '~/server/projects.fns';
import { projectQueryOptions } from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/projects/$projectId')({
    loader: async ({ context, params }) => {
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    component: ProjectLayout,
    head: ({ loaderData }) => ({
        meta: [{ title: `${loaderData?.projectName ?? 'Project'} · Quarry · Vizzy Studio` }]
    })
});

const TAB_ORDER = {
    info: 0,
    permissions: 1,
    commits: 2,
    history: 3,
    assets: 4,
    controller: 5
} as const;
type TabKey = keyof typeof TAB_ORDER;

const ALL_TABS: { key: TabKey; label: string; to: string; icon: any }[] = [
    { key: 'info', label: 'Project Info', to: '.', icon: FolderIcon },
    { key: 'permissions', label: 'Permissions', to: './permissions', icon: UsersIcon },
    { key: 'commits', label: 'Commits', to: './commits', icon: GitBranchIcon },
    { key: 'history', label: 'History', to: './history', icon: ClockIcon },
    { key: 'assets', label: 'Assets', to: './assets', icon: ImageIcon },
    { key: 'controller', label: 'Controller', to: './controller_editor', icon: CodeIcon }
];

const CUSTOM_RENDER_HIDDEN_TABS: ReadonlySet<TabKey> = new Set(['commits', 'assets']);

const TAB_SUBHEADERS: Record<TabKey, { title: string; description?: string }> = {
    info: {
        title: 'Project Information',
        description: 'Manage projects metadata and gallery images.'
    },
    permissions: {
        title: 'Collaborators',
        description: 'Manage who can view or edit this project.'
    },
    commits: {
        title: 'Commit History',
        description: 'Select a commit to publish it to the public gallery.'
    },
    history: {
        title: 'Audit Log',
        description: 'A record of all changes made to this project.'
    },
    assets: {
        title: 'Project Media',
        description: 'Manage the media assets associated with this project.'
    },
    controller: {
        title: 'Controller Editor',
        description: 'Edit the custom controller for this project.'
    }
};

const slidePanelVariants = {
    enter: () => ({
        opacity: 0,
        filter: 'blur(2px)'
    }),
    center: {
        opacity: 1,
        filter: 'blur(0px)'
    },
    exit: () => ({
        opacity: 0,
        filter: 'blur(2px)'
    })
};

function getTabFromPath(pathname: string): TabKey {
    if (pathname.endsWith('/permissions')) return 'permissions';
    if (pathname.endsWith('/commits')) return 'commits';
    if (pathname.endsWith('/history')) return 'history';
    if (pathname.endsWith('/assets')) return 'assets';
    if (pathname.endsWith('/controller_editor')) return 'controller';
    return 'info';
}

function ProjectLayout() {
    const { projectId } = Route.useParams();
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
    const { data: user } = useSuspenseQuery(authQueryOptions());
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const location = useLocation();
    const navigate = useNavigate();
    const currentTab = getTabFromPath(location.pathname);
    const hasCustomRender = !!project.customRenderUrl;
    const canPublish =
        user?.role === 'admin' || user?.role === 'operator' || user?.trustedPublisher === true;
    const tabs = (
        hasCustomRender ? ALL_TABS.filter((t) => !CUSTOM_RENDER_HIDDEN_TABS.has(t.key)) : ALL_TABS
    ).filter((t) => t.key !== 'controller' || user?.role === 'admin');
    const queryClient = useQueryClient();
    const [openingEditor, setOpeningEditor] = useState(false);
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;

    const publishCustomRender = useMutation({
        mutationFn: () => $publishCustomRenderProject({ data: { projectId } }),
        onSuccess: () => {
            toast.success('Project published');
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        }
    });

    const unpublishCustomRender = useMutation({
        mutationFn: () => $publishCommit({ data: { projectId, commitId: null } }),
        onSuccess: () => {
            toast.success('Project unpublished');
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        }
    });

    const resolvedPathname = useRouterState({
        select: (s) => s.location.pathname
    });

    return (
        <SubHeaderSlotProvider>
            <div
                className={`flex h-full flex-col overflow-hidden pb-14 ${isImpersonating ? 'pt-24' : 'pt-14'}`}
            >
                <div className="mx-auto w-full max-w-6xl shrink-0 px-6 pt-4">
                    <div className="mb-6 flex items-center gap-3">
                        <Button
                            render={<Link to="/quarry" />}
                            variant="ghost"
                            size="icon-sm"
                            nativeButton={false}
                            className="w-5 justify-start"
                        >
                            <ArrowLeftIcon />
                        </Button>
                        <h2 className="text-xl font-semibold">{project.name}</h2>
                        {project.publishedCommitId && (
                            <Badge variant="default" className="text-xs">
                                Published
                            </Badge>
                        )}
                        {!hasCustomRender && (
                            <Button
                                variant="default"
                                size="sm"
                                className="ml-auto"
                                disabled={openingEditor}
                                onClick={async () => {
                                    setOpeningEditor(true);
                                    try {
                                        const headCommitId = await $ensureMutableHead({
                                            data: { projectId }
                                        });
                                        const commit = await $getCommit({
                                            data: { id: headCommitId }
                                        });
                                        const firstSlideId =
                                            commit?.content?.slides?.[0]?.id ?? 'default';
                                        await navigate({
                                            to: '/quarry/editor/$projectId/$commitId/$slideId',
                                            params: {
                                                projectId,
                                                commitId: headCommitId,
                                                slideId: firstSlideId
                                            }
                                        });
                                    } catch (error) {
                                        toast.error(
                                            error instanceof Error
                                                ? error.message
                                                : 'Failed to open editor'
                                        );
                                        setOpeningEditor(false);
                                    }
                                }}
                            >
                                {openingEditor ? (
                                    <>
                                        <CircleNotchIcon className="animate-spin" />
                                        Opening editor...
                                    </>
                                ) : (
                                    <>
                                        <PencilSimpleIcon weight="bold" /> Edit
                                    </>
                                )}
                            </Button>
                        )}
                        {hasCustomRender &&
                            canPublish &&
                            (project.publishedCommitId ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="ml-auto"
                                    disabled={unpublishCustomRender.isPending}
                                    onClick={() => unpublishCustomRender.mutate()}
                                >
                                    <GlobeIcon weight="bold" /> Unpublish
                                </Button>
                            ) : (
                                <Button
                                    variant="default"
                                    size="sm"
                                    className="ml-auto"
                                    disabled={publishCustomRender.isPending}
                                    onClick={() => publishCustomRender.mutate()}
                                >
                                    <GlobeIcon weight="bold" /> Publish
                                </Button>
                            ))}
                    </div>

                    <Tabs
                        value={currentTab}
                        onValueChange={(value) => {
                            const tab = tabs.find((t) => t.key === value);
                            if (tab) {
                                navigate({
                                    from: '/quarry/projects/$projectId',
                                    to: tab.to
                                });
                            }
                        }}
                        className="mb-0"
                    >
                        <TabsList variant="line">
                            {tabs.map((tab) => (
                                <TabsTrigger key={tab.key} value={tab.key}>
                                    <span className="flex items-center gap-1.5">
                                        <tab.icon size={14} />
                                        {tab.label}
                                    </span>
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </Tabs>

                    <div className="mt-6 flex items-start justify-between">
                        <div>
                            <h3 className="text-base font-medium">
                                {TAB_SUBHEADERS[currentTab].title}
                            </h3>
                            {TAB_SUBHEADERS[currentTab].description && (
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {TAB_SUBHEADERS[currentTab].description}
                                </p>
                            )}
                        </div>
                        <SubHeaderSlotOutlet />
                    </div>
                </div>

                <div className="relative mx-auto min-h-0 w-full max-w-6xl flex-1">
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent" />
                    <div className="h-full scrollbar-none overflow-y-auto px-6 pt-8 pb-6">
                        <div className="relative grid">
                            <AnimatePresence mode="sync" initial={false}>
                                <motion.div
                                    key={resolvedPathname}
                                    className="col-start-1 row-start-1 w-full"
                                    variants={slidePanelVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                >
                                    <Outlet />
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t from-background to-transparent" />
                </div>
            </div>
        </SubHeaderSlotProvider>
    );
}
