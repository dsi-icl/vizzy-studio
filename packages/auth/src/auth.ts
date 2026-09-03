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
            canManageSignage: {
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
            sendVerificationOTP: async ({ email, otp, type }) => {
                if (env.NODE_ENV !== 'test' && !checkOtpRateLimit(email)) {
                    console.warn(`[Auth] OTP dispatch rate limited for ${email}`);
                    throw new Error(
                        'Too many OTP requests for this email. Please wait a few minutes before trying again.'
                    );
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
