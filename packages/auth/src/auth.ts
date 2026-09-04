import '@tanstack/react-start/server-only';
import { db } from '@repo/db';
import { getSmtpConfig } from '@repo/db/config';
import { OtpEmail } from '@repo/emails/OtpEmail';
import { env, splitCsv } from '@repo/env';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { betterAuth } from 'better-auth/minimal';
import { admin, createAccessControl, emailOTP, testUtils } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { render } from 'react-email';

import { createSmtpTransport } from './smtp';

const allowedHosts = splitCsv(env.ALLOWED_HOSTS);
const trustedOrigins = splitCsv(env.TRUSTED_ORIGINS);

function toOrigin(value: string): string | null {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function buildAllowedHosts(values: string[], fallbackBaseUrl: string): string[] {
    const seed = values.length > 0 ? values : [fallbackBaseUrl];
    const out = new Set<string>();
    for (const value of seed) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        out.add(trimmed);
        try {
            const url = new URL(trimmed);
            out.add(url.host);
            out.add(url.hostname);
        } catch {
            // Non-URL host strings are valid as-is.
        }
    }
    return Array.from(out);
}

function buildTrustedOrigins(values: string[], fallbackBaseUrl: string): string[] {
    const seed = values.length > 0 ? values : [fallbackBaseUrl];
    const out = new Set<string>();
    for (const value of seed) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        out.add(trimmed);
        const origin = toOrigin(trimmed);
        if (origin) out.add(origin);
    }
    // Dev ergonomics: sign-out/sign-in from local ports should not 403 due to origin strictness.
    if (env.NODE_ENV !== 'production') {
        out.add('http://localhost:3000');
        out.add('http://127.0.0.1:3000');
        out.add('http://localhost:5173');
        out.add('http://127.0.0.1:5173');
    }
    return Array.from(out);
}

const safeAllowedHosts = buildAllowedHosts(allowedHosts, env.VITE_BASE_URL);
const trustedOriginSeeds = buildTrustedOrigins(trustedOrigins, env.VITE_BASE_URL);

const adminAc = createAccessControl({
    user: [
        'create',
        'list',
        'set-role',
        'ban',
        'impersonate',
        'impersonate-admins',
        'delete',
        'set-password',
        'get',
        'update'
    ],
    session: ['list', 'revoke', 'delete']
});

const adminRole = adminAc.newRole({
    user: [
        'create',
        'list',
        'set-role',
        'ban',
        'impersonate',
        'delete',
        'set-password',
        'get',
        'update'
    ],
    session: ['list', 'revoke', 'delete']
});

const operatorRole = adminAc.newRole({
    user: ['update'],
    session: []
});

const userRole = adminAc.newRole({
    user: [],
    session: []
});

async function sendAuthEmail(input: {
    to: string;
    subject: string;
    html: string;
    fallbackLog: string;
}) {
    try {
        const smtp = await getSmtpConfig();
        if (!smtp) {
            console.warn(`[AuthMail] SMTP config missing in DB. ${input.fallbackLog}`);
            return;
        }

        const transporter = await createSmtpTransport(smtp);

        await transporter.sendMail({
            from: smtp.from,
            to: input.to,
            subject: input.subject,
            html: input.html
        });
    } catch (err) {
        console.error('[AuthMail] send failed', err, input.fallbackLog);
    }
}
const otpRateLimitMap = new Map<string, number[]>();
const OTP_WINDOW_MS = 5 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 3;

function checkOtpRateLimit(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    const now = Date.now();
    const timestamps = (otpRateLimitMap.get(normalized) ?? []).filter(
        (ts) => now - ts < OTP_WINDOW_MS
    );
    if (timestamps.length >= OTP_MAX_PER_WINDOW) {
        return false;
    }
    timestamps.push(now);
    otpRateLimitMap.set(normalized, timestamps);
    if (otpRateLimitMap.size > 10_000) {
        for (const [k, list] of otpRateLimitMap) {
            if (list.every((ts) => now - ts >= OTP_WINDOW_MS)) {
                otpRateLimitMap.delete(k);
            }
        }
    }
    return true;
}

const otpIpRateLimitMap = new Map<string, number[]>();
const OTP_IP_WINDOW_MS = 10 * 60 * 1000;
const OTP_IP_MAX_PER_WINDOW = 5;

function checkOtpIpRateLimit(ip: string): boolean {
    if (!ip || ip === 'unknown') return true;
    const now = Date.now();
    const timestamps = (otpIpRateLimitMap.get(ip) ?? []).filter(
        (ts) => now - ts < OTP_IP_WINDOW_MS
    );
    if (timestamps.length >= OTP_IP_MAX_PER_WINDOW) {
        return false;
    }
    timestamps.push(now);
    otpIpRateLimitMap.set(ip, timestamps);
    if (otpIpRateLimitMap.size > 10_000) {
        for (const [k, list] of otpIpRateLimitMap) {
            if (list.every((ts) => now - ts >= OTP_IP_WINDOW_MS)) {
                otpIpRateLimitMap.delete(k);
            }
        }
    }
    return true;
}

function getClientIpFromAuthContext(ctx: unknown): string {
    if (!ctx || typeof ctx !== 'object') return 'unknown';
    const c = ctx as {
        headers?: Headers | Record<string, unknown>;
        request?: { headers?: Headers | Record<string, unknown> };
    };
    const rawHeaders = c.headers ?? c.request?.headers;
    if (!rawHeaders) return 'unknown';

    if (typeof (rawHeaders as Headers).get === 'function') {
        const h = rawHeaders as Headers;
        const cf = h.get('cf-connecting-ip');
        if (cf) return cf.trim();
        const realIp = h.get('x-real-ip');
        if (realIp) return realIp.trim();
        const xff = h.get('x-forwarded-for');
        if (xff) {
            const first = xff.split(',')[0]?.trim();
            if (first) return first;
        }
        return 'unknown';
    }

    const rec = rawHeaders as Record<string, unknown>;
    const pick = (name: string): string | null => {
        const val = rec[name] ?? rec[name.toLowerCase()];
        if (typeof val === 'string') return val.trim();
        if (Array.isArray(val) && typeof val[0] === 'string') return val[0].trim();
        return null;
    };

    const cf = pick('cf-connecting-ip');
    if (cf) return cf;
    const realIp = pick('x-real-ip');
    if (realIp) return realIp;
    const xff = pick('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }

    return 'unknown';
}

export const auth = betterAuth({
    baseURL: {
        allowedHosts: safeAllowedHosts,
        fallback: safeAllowedHosts[0]
    },
    trustedOrigins: async (request) => {
        const origins = new Set(trustedOriginSeeds);
        if (request) {
            const requestOrigin = toOrigin(request.url);
            if (requestOrigin) {
                try {
                    const parsed = new URL(requestOrigin);
                    if (
                        safeAllowedHosts.includes(parsed.host) ||
                        safeAllowedHosts.includes(parsed.hostname)
                    ) {
                        origins.add(requestOrigin);
                    }
                } catch {
                    // Non-URL or unparseable origin ignored
                }
            }
        }
        return Array.from(origins);
    },
    secret:
        env.SERVER_AUTH_SECRET ||
        (env.NODE_ENV === 'production'
            ? (() => {
                  throw new Error('SERVER_AUTH_SECRET must be set in production');
              })()
            : 'degraded-mode-secret'),
    telemetry: {
        enabled: false
    },
    database: mongodbAdapter(db),
    user: {
        additionalFields: {
            trustedPublisher: {
                type: 'boolean',
                required: false,
                defaultValue: false,
                input: false
            },
            lastSeen: {
                type: 'date',
                required: false,
                input: false
            }
        }
    },

    // https://www.better-auth.com/docs/integrations/tanstack#usage-tips
    plugins: [
        admin({
            ac: adminAc,
            roles: {
                admin: adminRole,
                operator: operatorRole,
                user: userRole
            },
            adminRoles: ['admin']
        }),
        ...(env.NODE_ENV === 'test' ? [testUtils()] : []),
        emailOTP({
            sendVerificationOTP: async ({ email, otp, type }, ctx) => {
                if (env.NODE_ENV !== 'test') {
                    if (!checkOtpRateLimit(email)) {
                        console.warn(`[Auth] OTP dispatch rate limited for email: ${email}`);
                        throw new Error(
                            'Too many OTP requests for this email. Please wait a few minutes before trying again.'
                        );
                    }
                    const ip = getClientIpFromAuthContext(ctx);
                    if (!checkOtpIpRateLimit(ip)) {
                        console.warn(`[Auth] OTP dispatch rate limited for IP: ${ip}`);
                        throw new Error(
                            'Too many OTP requests from this IP address. Please wait a few minutes before trying again.'
                        );
                    }
                }
                const html = await render(OtpEmail({ otp }));
                await sendAuthEmail({
                    to: email,
                    subject: 'Your Vizzy Studio OTP',
                    html,
                    fallbackLog:
                        env.NODE_ENV === 'production'
                            ? `OTP to ${email} (${type})`
                            : `OTP to ${email} : ${otp} (${type})`
                });
            }
        }),
        tanstackStartCookies()
    ],

    // https://www.better-auth.com/docs/concepts/session-management#session-caching
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60 // 5 minutes
        }
    }
});
