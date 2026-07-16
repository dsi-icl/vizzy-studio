import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_guest')({
    beforeLoad: async ({ context, location }) => {
        const REDIRECT_URL = '/quarry';
        const pathname = location.pathname.replace(/\/+$/, '') || '/';
        const isPhotosPage = pathname === '/photos';
        if (isPhotosPage) {
            return {
                redirectUrl: REDIRECT_URL
            };
        }

        const user = await context.queryClient.ensureQueryData({
            ...authQueryOptions(),
            revalidateIfStale: true
        });
        if (user) {
            throw redirect({
                to: REDIRECT_URL
            });
        }

        return {
            redirectUrl: REDIRECT_URL
        };
    },
    component: RouteComponent,
    head: () => ({
        meta: [{ title: 'Sign In · Vizzy Studio' }]
    })
});

function RouteComponent() {
    return (
        <div className="absolute top-0 left-0 flex min-h-svh min-w-svw flex-col bg-background">
            <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 md:p-16">
                <div className="w-full max-w-sm">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}
