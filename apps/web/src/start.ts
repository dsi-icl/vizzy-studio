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

let rateLimitAuditCount = 0;
let rateLimitAuditResetAt = Date.now() + 60_000;
const MAX_RATE_LIMIT_AUDITS_PER_MINUTE = 10;
const SERVE_BUN_IDLE_TIMEOUT_SECONDS = 65;
let serveBunTimeoutLogged = false;

function shouldAuditRateLimitGlobal(now: number): boolean {
    if (now > rateLimitAuditResetAt) {
        rateLimitAuditCount = 0;
        rateLimitAuditResetAt = now + 60_000;
    }
    if (rateLimitAuditCount >= MAX_RATE_LIMIT_AUDITS_PER_MINUTE) {
        return false;
    }
    rateLimitAuditCount++;
    return true;
}

const startRateLimitMiddleware = createMiddleware().server(async ({ next, request }) => {
    const method = request.method.toUpperCase();
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const isRead = method === 'GET' || method === 'HEAD';
    if (!isMutation && !isRead) {
        return next();
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith('/serve/')) {
        // Bun otherwise closes an in-flight request after ten seconds without
        // response bytes, before Serve's 30s fetch and 55s polling limits.
        const bunServer = (
            request as Request & {
                runtime?: {
                    bun?: { server?: { timeout: (req: Request, seconds: number) => void } };
                };
            }
        ).runtime?.bun?.server;
        try {
            if (bunServer) bunServer.timeout(request, SERVE_BUN_IDLE_TIMEOUT_SECONDS);
            if (!serveBunTimeoutLogged && process.env.NODE_ENV === 'production') {
                serveBunTimeoutLogged = true;
                console.info(
                    `[Serve] Bun request idle timeout: ${bunServer ? SERVE_BUN_IDLE_TIMEOUT_SECONDS + 's' : 'unavailable'}`
                );
            }
        } catch (error) {
            if (!serveBunTimeoutLogged) {
                serveBunTimeoutLogged = true;
                console.warn('[Serve] Could not extend Bun request idle timeout', error);
            }
        }
    }
    // Exempt resumable upload chunk streams (PATCH) which stream bytes in small parts.
    // Upload creation (POST) and termination (DELETE) remain subject to rate limits.
    if (url.pathname.startsWith('/api/uploads/') && method === 'PATCH') {
        return next();
    }

    const ip = getClientIpFromHeaders(request.headers);
    const subjectKey = isMutation
        ? buildRateLimitSubjectKey({ ip })
        : buildRateLimitSubjectKey({ ip: ip && ip !== 'unknown' ? `get:${ip}` : null });
    const rate = checkRateLimit({
        subjectKey
    });

    if (rate.allowed) return next();

    const now = Date.now();
    console.warn(`[RateLimit] Route rate limited: ${method} ${url.pathname} (ip: ${ip})`);
    if (shouldAuditRateLimit(subjectKey, now) && shouldAuditRateLimitGlobal(now)) {
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
    if (requestUrl.pathname.startsWith('/api/proxy') || requestUrl.pathname.startsWith('/serve/')) {
        return next();
    }

    const isDev = process.env.NODE_ENV === 'development';
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
    setResponseHeader('X-Frame-Options', 'SAMEORIGIN');
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
    // Serve validates its own launch ticket or per-route cookie and wall binding.
    // Its screen and asset requests do not use the app's session context.
    if (new URL(request.url).pathname.startsWith('/serve/')) return next();
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
