import { authSessionQueryOptions } from '@repo/auth/tanstack/queries';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth/quarry/editor')({
    head: () => ({
        meta: [{ title: 'Editor · Projects · Vizzy Studio' }]
    }),
    component: AppLayout
});

function AppLayout() {
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;

    return (
        <div
            className={`container flex h-full max-h-full min-h-0 w-full max-w-full min-w-full flex-col overflow-hidden pb-13 ${isImpersonating ? 'pt-28' : 'pt-18'}`}
        >
            <Outlet />
        </div>
    );
}
