import { createFileRoute } from '@tanstack/react-router';

import { buildInfo } from '~/lib/buildInfo';
import { logAuditSuccess } from '~/server/audit';

export const Route = createFileRoute('/api/version')({
    server: {
        handlers: {
            GET: async ({ request }) => {
                await logAuditSuccess({
                    action: 'VERSION_READ',
                    resourceType: 'config',
                    resourceId: 'build-info',
                    executionContext: {
                        surface: 'http',
                        operation: 'GET /api/version',
                        request
                    }
                });
                return Response.json({
                    name: 'Vizzy Studio',
                    commit: buildInfo.commitSha,
                    builtAt: buildInfo.builtAt
                });
            }
        }
    }
});
