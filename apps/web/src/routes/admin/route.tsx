import {
    ActivityIcon,
    CastleTurretIcon,
    ChartBarIcon,
    GearIcon,
    FolderIcon,
    ImageIcon,
    MonitorIcon,
    UsersIcon,
    PanoramaIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
    createFileRoute,
    Outlet,
    redirect,
    useLocation,
    useNavigate,
    useRouterState
} from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { Suspense, useMemo } from 'react';

import { SubHeaderSlotOutlet, SubHeaderSlotProvider } from '~/lib/subHeaderSlot';
import { $finalizeFirstAdminForCurrentUser } from '~/server/bootstrap.fns';

export const Route = createFileRoute('/admin')({
    beforeLoad: async ({ context, location }) => {
        let user = await context.queryClient.ensureQueryData({
            ...authQueryOptions(),
            revalidateIfStale: true
        });
        if (!user) throw redirect({ to: '/login' });
        const promotion = await $finalizeFirstAdminForCurrentUser();
        if (promotion.promoted) {
            await context.queryClient.invalidateQueries({ queryKey: authQueryOptions().queryKey });
            user = await context.queryClient.fetchQuery({
                ...authQueryOptions()
            });
        }
        const role = user?.role;
        if (role !== 'admin' && role !== 'operator') throw redirect({ to: '/quarry' });
        if (role === 'operator') {
            const pathname = location.pathname.replace(/\/+$/, '') || '/admin';
            const allowed =
                pathname === '/admin' ||
                pathname === '/admin/users' ||
                pathname === '/admin/projects' ||
                pathname === '/admin/assets';
            if (!allowed) throw redirect({ to: '/admin/users' });
        }
        return { user };
    },
    component: AdminLayout,
    head: () => ({
        meta: [{ title: 'Admin · Vizzy Studio' }]
    })
});

const ADMIN_NAV = [
    { to: '/admin/users', label: 'Users', icon: UsersIcon },
    { to: '/admin/projects', label: 'Projects', icon: FolderIcon },
    { to: '/admin/audits', label: 'Audits', icon: ActivityIcon },
    { to: '/admin/walls', label: 'Walls', icon: PanoramaIcon },
    { to: '/admin/devices', label: 'Devices', icon: MonitorIcon },
    { to: '/admin/assets', label: 'Public Assets', icon: ImageIcon },
    { to: '/admin/config', label: 'Config', icon: GearIcon },
    { to: '/admin/stats', label: 'Stats', icon: ChartBarIcon }
] as const;

const OPERATOR_NAV = ADMIN_NAV.filter(
    (tab) => tab.to === '/admin/users' || tab.to === '/admin/projects' || tab.to === '/admin/assets'
);

const TAB_ORDER = {
    users: 0,
    projects: 1,
    audits: 2,
    walls: 3,
    devices: 4,
    assets: 5,
    config: 6,
    stats: 7
} as const;

type AdminTabKey = keyof typeof TAB_ORDER;

const TAB_SUBHEADERS: Record<AdminTabKey, { title: string; description?: string }> = {
    users: { title: 'Users' },
    projects: { title: 'Projects' },
    audits: {
        title: 'Audit Explorer',
        description: 'Cross-project audit trail with filters for operational investigation.'
    },
    walls: { title: 'Walls' },
    devices: { title: 'Devices' },
    assets: {
        title: 'Public Media Library',
        description: 'Assets uploaded here are visible in every project\u2019s media library.'
    },
    config: {
        title: 'Configuration',
        description: 'Secrets are encrypted at rest in the config collection.'
    },
    stats: { title: 'Stats' }
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

function getTabFromPath(pathname: string): AdminTabKey {
    if (pathname.startsWith('/admin/projects')) return 'projects';
    if (pathname.startsWith('/admin/audits')) return 'audits';
    if (pathname.startsWith('/admin/walls')) return 'walls';
    if (pathname.startsWith('/admin/devices')) return 'devices';
    if (pathname.startsWith('/admin/assets')) return 'assets';
    if (pathname.startsWith('/admin/config')) return 'config';
    if (pathname.startsWith('/admin/stats')) return 'stats';
    return 'users';
}

function AdminLayout() {
    const { data: user } = useSuspenseQuery(authQueryOptions());
    const location = useLocation();
    const navigate = useNavigate();
    const nav = useMemo(() => (user?.role === 'operator' ? OPERATOR_NAV : ADMIN_NAV), [user?.role]);
    const currentTab = getTabFromPath(location.pathname);
    const resolvedPathname = useRouterState({
        select: (s) => s.location.pathname
    });

    return (
        <SubHeaderSlotProvider>
            <div className="flex h-full flex-col overflow-hidden pt-14 pb-14">
                <div className="mx-auto w-full max-w-6xl shrink-0 px-6 pt-4">
                    <div className="mb-6 flex items-center gap-3">
                        <CastleTurretIcon size={18} />
                        <h2 className="text-xl font-semibold">Administration</h2>
                    </div>

                    <Tabs
                        value={currentTab}
                        onValueChange={(value) => {
                            const tab = nav.find((t) => t.to.split('/').pop() === value);
                            if (!tab) return;
                            navigate({ to: tab.to as any });
                        }}
                        className="mb-0"
                    >
                        <TabsList variant="line">
                            {nav.map(({ to, label, icon: Icon }) => {
                                const key = to.split('/').pop() as AdminTabKey;
                                return (
                                    <TabsTrigger key={to} value={key}>
                                        <span className="flex items-center gap-1.5">
                                            <Icon size={14} />
                                            {label}
                                        </span>
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>
                    </Tabs>

                    <div className="flex items-start justify-between">
                        <div>
                            {/* <h3 className="text-base font-medium">
                                {TAB_SUBHEADERS[currentTab].title}
                            </h3> */}
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
                                    <Suspense
                                        fallback={
                                            <div className="space-y-3">
                                                <div className="h-7 w-40 animate-pulse rounded bg-muted" />
                                                <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/30" />
                                                <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/30" />
                                            </div>
                                        }
                                    >
                                        <Outlet />
                                    </Suspense>
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
