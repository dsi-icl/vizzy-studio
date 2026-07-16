import { auth } from '@repo/auth/auth';
import { createFileRoute } from '@tanstack/react-router';

import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';

async function handleAuth(request: Request) {
    const response = await auth.handler(request);
    const status = response.status;
    if (status >= 500) {
        await logAuditFailure({
            action: 'AUTH_HANDLER_FAILED',
            reasonCode: `HTTP_${status}`,
            executionContext: {
                surface: 'http',
                operation: `${request.method} /api/auth/$`,
                request
            }
        });
    } else if (status === 401 || status === 403) {
        await logAuditDenied({
            action: 'AUTH_HANDLER_DENIED',
            reasonCode: `HTTP_${status}`,
            executionContext: {
                surface: 'http',
                operation: `${request.method} /api/auth/$`,
                request
            }
        });
    } else if (status < 400) {
        await logAuditSuccess({
            action: 'AUTH_HANDLER_SUCCESS',
            executionContext: {
                surface: 'http',
                operation: `${request.method} /api/auth/$`,
                request
            }
        });
    }
    return response;
}

export const Route = createFileRoute('/api/auth/$')({
    server: {
        handlers: {
            GET: ({ request }) => handleAuth(request),
            POST: ({ request }) => handleAuth(request)
        }
    }
});
