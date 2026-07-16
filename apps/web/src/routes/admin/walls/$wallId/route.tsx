import { Tabs, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import {
    createFileRoute,
    Outlet,
    useLocation,
    useNavigate,
    useRouterState
} from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';

import { adminDevicesForWallQueryOptions, adminWallQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/walls/$wallId')({
    loader: async ({ context, params }) => {
        const wall = await context.queryClient.ensureQueryData(
            adminWallQueryOptions(params.wallId)
        );
        context.queryClient.ensureQueryData(adminDevicesForWallQueryOptions(params.wallId));
        return {
            wallName: wall?.name || wall?.wallId || 'Wall'
        };
    },
    component: WallLayout,
    head: ({ loaderData }) => ({
        meta: [{ title: `${loaderData?.wallName ?? 'Wall'} · Admin · Vizzy Studio` }]
    })
});

const TAB_ORDER = { info: 0, devices: 1 } as const;
type WallTabKey = keyof typeof TAB_ORDER;

const TAB_SUBHEADERS: Record<WallTabKey, { title: string; description?: string }> = {
    info: { title: 'Info', description: 'Manage wall metadata and lifecycle actions.' },
    devices: { title: 'Assigned Devices', description: 'Devices currently assigned to this wall.' }
};

const slidePanelVariants = {
    enter: () => ({ opacity: 0, filter: 'blur(2px)' }),
    center: { opacity: 1, filter: 'blur(0px)' },
    exit: () => ({ opacity: 0, filter: 'blur(2px)' })
};

function getTabFromPath(pathname: string): WallTabKey {
    if (pathname.endsWith('/devices')) return 'devices';
    return 'info';
}

function WallLayout() {
    const { wallId } = Route.useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const currentTab = getTabFromPath(location.pathname);
    const resolvedPathname = useRouterState({ select: (s) => s.location.pathname });

    return (
        <div className="space-y-6">
            <Tabs
                value={currentTab}
                onValueChange={(value) => {
                    if (value === 'devices') {
                        navigate({ to: '/admin/walls/$wallId/devices', params: { wallId } });
                        return;
                    }
                    navigate({ to: '/admin/walls/$wallId', params: { wallId } });
                }}
            >
                <TabsList variant="line">
                    <TabsTrigger value="info">Info</TabsTrigger>
                    <TabsTrigger value="devices">Assigned Devices</TabsTrigger>
                </TabsList>
            </Tabs>

            <div>
                <h4 className="text-base font-medium">{TAB_SUBHEADERS[currentTab].title}</h4>
                {TAB_SUBHEADERS[currentTab].description ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                        {TAB_SUBHEADERS[currentTab].description}
                    </p>
                ) : null}
            </div>

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
    );
}
