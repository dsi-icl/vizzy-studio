import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/admin/')({
    beforeLoad: async ({ context }) => {
        const user = await context.queryClient.ensureQueryData(authQueryOptions());
        throw redirect({
            to:
                user?.role === 'admin' || user?.role === 'operator'
                    ? '/admin/users'
                    : '/admin/signage'
        });
    },
    head: () => ({
        meta: [{ title: 'Admin · Vizzy Studio' }]
    }),
    component: () => null
});
