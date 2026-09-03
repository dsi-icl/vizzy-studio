import crypto from 'node:crypto';

import { createMiddleware, createStart, createCsrfMiddleware } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';

import { buildBaseCsp, serializeCsp } from '~/lib/csp';
import { logAuditDenied } from '~/server/audit';
import {
    buildRateLimitSubjectKey,
    checkRateLimit,
    getClientIpFromHeaders
} from '~/server/rateLimit';
import { resolveRequestAuthContext } from '~/server/requestAuthContext';
import { touchUserLastSeenThrottled } from '~/server/user-last-seen';

const lastRateLimitAuditSeen = new Map<string, number>();

function shouldAuditRateLimit(key: string, now: number): boolean {
    const last = lastRateLimitAuditSeen.get(key) ?? 0;
    if (now - last < 60_000) return false;
    lastRateLimitAuditSeen.set(key, now);
    if (lastRateLimitAuditSeen.size > 5_000) {
        for (const [k, ts] of lastRateLimitAuditSeen) {
            if (now - ts >= 60_000) lastRateLimitAuditSeen.delete(k);
        }
    }
    return true;
}

const startRateLimitMiddleware = createMiddleware().server(async ({ next, request }) => {
    const method = request.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return next();
    }

    const url = new URL(request.url);
    // Exempt resumable upload streams which have their own chunk-level throttling and token checks.
    if (url.pathname.startsWith('/api/uploads/')) {
        return next();
    }

    const ip = getClientIpFromHeaders(request.headers);
    const subjectKey = buildRateLimitSubjectKey({ ip });
    const rate = checkRateLimit({
        subjectKey
    });

    if (rate.allowed) return next();

    const now = Date.now();
    if (shouldAuditRateLimit(subjectKey, now)) {
        void logAuditDenied({
            action: 'START_ROUTE_RATE_LIMITED',
            resourceType: 'start_route',
            resourceId: `${method}:${url.pathname}`,
            reasonCode: 'RATE_LIMITED',
            changes: { retryAfterMs: rate.retryAfterMs, ip }
        }).catch(() => {});
    }

    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000))
        }
    });
});

const cspMiddleware = createMiddleware().server(({ next, request }) => {
    if (request.method !== 'GET') {
        return next();
    }

    const requestUrl = new URL(request.url);
    // Proxied third-party HTML should not inherit the app's CSP policy.
    // The proxy route applies its own controls (allowlist, timeout, size caps, authz).
    if (requestUrl.pathname.startsWith('/api/proxy')) {
        return next();
    }

    const isDev = import.meta.env.DEV;
    const nonce = crypto.randomBytes(16).toString('base64');
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = forwardedHost || requestUrl.host;
    const protocol =
        forwardedProto ||
        (requestUrl.protocol === 'https:'
            ? 'https'
            : isDev || host.startsWith('localhost')
              ? 'http'
              : 'https');
    const reportUrl = `${protocol}://${host}/api/report-csp`;

    const cspDirectives = buildBaseCsp({
        nonce,
        isDev,
        pathname: requestUrl.pathname,
        reportUrl
    });
    const headerName = isDev ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    setResponseHeader(headerName, serializeCsp(cspDirectives));
    setResponseHeader('Reporting-Endpoints', `csp-endpoint="${reportUrl}"`);
    setResponseHeader(
        'Report-To',
        JSON.stringify({
            group: 'csp-endpoint',
            max_age: 60 * 60 * 24,
            endpoints: [{ url: reportUrl }]
        })
    );

    return next({
        context: { nonce, cspDirectives, cspHeaderName: headerName }
    });
});

const csrfMiddleware = createCsrfMiddleware({
    filter: (ctx) => ctx.handlerType === 'serverFn'
});

const authContextMiddleware = createMiddleware().server(async ({ next, request, context }) => {
    const { authContext } = await resolveRequestAuthContext(request);
    touchUserLastSeenThrottled(authContext.user?.email);
    return next({
        context: {
            nonce: undefined,
            ...(context ?? {}),
            authContext
        }
    });
});

export const startInstance = createStart(() => {
    return {
        requestMiddleware: [
            startRateLimitMiddleware,
            csrfMiddleware,
            cspMiddleware,
            authContextMiddleware
        ]
    };
});
