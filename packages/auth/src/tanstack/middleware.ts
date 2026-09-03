import { createMiddleware } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';

import { _getAuthSession } from './functions';

function normalizeRole(role: unknown): 'admin' | 'operator' | 'user' {
    if (role === 'admin' || role === 'operator') return role;
    return 'user';
}

/**
 * Middleware to force authentication on server requests (including server functions), and add the user to the context.
 *
 * Follows the cookieCache option in the auth config (template default: 5 mins). This is recommended for most cases, like route-level data fetching operations where some staleness may be acceptable and reduced server load is beneficial.
 *
 * @see https://better-auth.com/docs/concepts/session-management#cookie-cache
 */
export const authMiddleware = createMiddleware().server(async ({ next, context }) => {
    const authSession = await _getAuthSession();
    const user = authSession?.user ?? null;

    if (!user) {
        setResponseStatus(401);
        throw new Error('Unauthorized');
    }

    return next({
        context: {
            ...(context ?? {}),
            user,
            authContext: {
                user: {
                    email: user.email,
                    role: normalizeRole(user.role),
                    ...(user.trustedPublisher === true ? { trustedPublisher: true } : {}),
                    ...(user.canManageSignage === true ? { canManageSignage: true } : {}),
                    ...(typeof authSession?.session?.impersonatedBy === 'string' &&
                    authSession.session.impersonatedBy.length > 0
                        ? { impersonatedBy: authSession.session.impersonatedBy }
                        : {})
                }
            }
        }
    });
});

/**
 * Middleware to force authentication on server requests (including server functions), and add the user to the context.
 *
 * Auth cookie cache is disabled, and fresh user session is always fetched from database. This is recommended for sensitive/destructive operations and mutations that require the freshest auth state, e.g. to prevent a user from performing an action after their session has expired or been revoked.
 *
 * @see https://better-auth.com/docs/concepts/session-management#cookie-cache
 */
export const freshAuthMiddleware = createMiddleware().server(async ({ next, context }) => {
    const authSession = await _getAuthSession({
        // ensure session is fresh
        // https://better-auth.com/docs/concepts/session-management#cookie-cache
        disableCookieCache: true
    });
    const user = authSession?.user ?? null;

    if (!user) {
        setResponseStatus(401);
        throw new Error('Unauthorized');
    }

    return next({
        context: {
            ...(context ?? {}),
            user,
            authContext: {
                user: {
                    email: user.email,
                    role: normalizeRole(user.role),
                    ...(user.trustedPublisher === true ? { trustedPublisher: true } : {}),
                    ...(user.canManageSignage === true ? { canManageSignage: true } : {}),
                    ...(typeof authSession?.session?.impersonatedBy === 'string' &&
                    authSession.session.impersonatedBy.length > 0
                        ? { impersonatedBy: authSession.session.impersonatedBy }
                        : {})
                }
            }
        }
    });
});

export const adminMiddleware = createMiddleware().server(async ({ next, context }) => {
    const authSession = await _getAuthSession();
    const user = authSession?.user ?? null;

    if (!user) {
        setResponseStatus(401);
        throw new Error('Unauthorized');
    }

    if (user.role !== 'admin') {
        setResponseStatus(403);
        throw new Error('Forbidden');
    }

    return next({
        context: {
            ...(context ?? {}),
            user,
            authContext: {
                user: {
                    email: user.email,
                    role: normalizeRole(user.role),
                    ...(user.trustedPublisher === true ? { trustedPublisher: true } : {}),
                    ...(user.canManageSignage === true ? { canManageSignage: true } : {}),
                    ...(typeof authSession?.session?.impersonatedBy === 'string' &&
                    authSession.session.impersonatedBy.length > 0
                        ? { impersonatedBy: authSession.session.impersonatedBy }
                        : {})
                }
            }
        }
    });
});

export const operatorMiddleware = createMiddleware().server(async ({ next, context }) => {
    const authSession = await _getAuthSession();
    const user = authSession?.user ?? null;

    if (!user) {
        setResponseStatus(401);
        throw new Error('Unauthorized');
    }

    if (user.role !== 'admin' && user.role !== 'operator') {
        setResponseStatus(403);
        throw new Error('Forbidden');
    }

    return next({
        context: {
            ...(context ?? {}),
            user,
            authContext: {
                user: {
                    email: user.email,
                    role: normalizeRole(user.role),
                    ...(user.trustedPublisher === true ? { trustedPublisher: true } : {}),
                    ...(user.canManageSignage === true ? { canManageSignage: true } : {}),
                    ...(typeof authSession?.session?.impersonatedBy === 'string' &&
                    authSession.session.impersonatedBy.length > 0
                        ? { impersonatedBy: authSession.session.impersonatedBy }
                        : {})
                }
            }
        }
    });
});

/** Allows platform operators and users explicitly granted signage-management access. */
export const signageMiddleware = createMiddleware().server(async ({ next, context }) => {
    const authSession = await _getAuthSession();
    const user = authSession?.user ?? null;

    if (!user) {
        setResponseStatus(401);
        throw new Error('Unauthorized');
    }

    if (user.role !== 'admin' && user.role !== 'operator' && user.canManageSignage !== true) {
        setResponseStatus(403);
        throw new Error('Forbidden');
    }

    return next({
        context: {
            ...(context ?? {}),
            user,
            authContext: {
                user: {
                    email: user.email,
                    role: normalizeRole(user.role),
                    ...(user.trustedPublisher === true ? { trustedPublisher: true } : {}),
                    ...(user.canManageSignage === true ? { canManageSignage: true } : {}),
                    ...(typeof authSession?.session?.impersonatedBy === 'string' &&
                    authSession.session.impersonatedBy.length > 0
                        ? { impersonatedBy: authSession.session.impersonatedBy }
                        : {})
                }
            }
        }
    });
});
