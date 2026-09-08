import { createFileRoute } from '@tanstack/react-router';

import { buildInfo } from '~/lib/buildInfo';

export const Route = createFileRoute('/api/version')({
    server: {
        handlers: {
            GET: async () => {
                return Response.json({
                    name: 'Vizzy Studio',
                    commit: buildInfo.commitSha,
                    builtAt: buildInfo.builtAt
                });
            }
        }
    }
});
