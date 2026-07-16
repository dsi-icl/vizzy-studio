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
    out.add('http://localhost:3000');
    out.add('http://127.0.0.1:3000');
    out.add('http://localhost:5173');
    out.add('http://127.0.0.1:5173');
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

export const auth = betterAuth({
    baseURL: {
        allowedHosts: safeAllowedHosts,
        fallback: safeAllowedHosts[0]
    },
    trustedOrigins: async (request) => {
        const dynamic = new Set(trustedOriginSeeds);
        if (request) {
            const requestOrigin = toOrigin(request.url);
            if (requestOrigin) dynamic.add(requestOrigin);
            const originHeader = request.headers.get('origin');
            if (originHeader) {
                const normalized = toOrigin(originHeader) ?? originHeader;
                if (normalized) dynamic.add(normalized);
            }
        }
        return Array.from(dynamic);
    },
    secret: env.SERVER_AUTH_SECRET || 'degraded-mode-secret',
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
        tanstackStartCookies(),
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
                const html = await render(OtpEmail({ otp }));
                await sendAuthEmail({
                    to: email,
                    subject: 'Your Vizzy Studio OTP',
                    html,
                    fallbackLog: `OTP to ${email} : ${otp} (${type})`
                });
            }
        })
    ],

    // https://www.better-auth.com/docs/concepts/session-management#session-caching
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60 // 5 minutes
        }
    }
});
