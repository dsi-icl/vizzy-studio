import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

import { $finalizeFirstAdminForCurrentUser } from '~/server/bootstrap.fns';

export const Route = createFileRoute('/_auth')({
    beforeLoad: async ({ context }) => {
        let user = await context.queryClient.ensureQueryData({
            ...authQueryOptions(),
            revalidateIfStale: true
        });
        if (!user) {
            throw redirect({ to: '/login' });
        }

        const promotion = await $finalizeFirstAdminForCurrentUser();
        if (promotion.promoted) {
            await context.queryClient.invalidateQueries({ queryKey: authQueryOptions().queryKey });
            user = await context.queryClient.fetchQuery({
                ...authQueryOptions()
            });
        }

        // return context for use in child routes & loaders
        return { user };
    },
    component: Outlet,
    head: () => ({
        meta: [{ title: 'Quarry · Vizzy Studio' }]
    })
});
