import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth/quarry/projects')({
    head: () => ({
        meta: [{ title: 'Projects · Quarry · Vizzy Studio' }]
    }),
    component: AppLayout
});

function AppLayout() {
    return (
        <div className="h-full w-full">
            <Outlet />
        </div>
    );
}
