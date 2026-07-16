import { freshAuthMiddleware } from '@repo/auth/tanstack/middleware';
import type { AuthContext } from '@repo/db/documents';
import { createServerFn } from '@tanstack/react-start';

import { z } from '~/lib/zod';

import { logAuditFailure, logAuditSuccess } from './audit';
import {
    finalizeFirstAdminForUser,
    getBootstrapStatus,
    requestBootstrapSetupCodeDisplay,
    submitBootstrapAdminAndSmtp,
    verifyBootstrapOtpAndFinalize,
    verifyBootstrapSetupCode
} from './bootstrap';

function buildBootstrapAuditContext(params: {
    operation: string;
    authContext?: AuthContext | null;
}) {
    return {
        authContext: params.authContext ?? { guest: true },
        executionContext: {
            surface: 'serverfn' as const,
            operation: params.operation
        }
    };
}

export const $bootstrapStatus = createServerFn({ method: 'GET' }).handler(async () =>
    getBootstrapStatus()
);

export const $requestBootstrapSetupCodeDisplay = createServerFn({ method: 'POST' }).handler(
    async () => {
        const auditContext = buildBootstrapAuditContext({
            operation: '$requestBootstrapSetupCodeDisplay'
        });
        try {
            await requestBootstrapSetupCodeDisplay();
            await logAuditSuccess({
                action: 'BOOTSTRAP_SETUP_CODE_REQUESTED',
                resourceType: 'bootstrap',
                resourceId: 'setup_code',
                ...auditContext
            });
        } catch (error) {
            await logAuditFailure({
                action: 'BOOTSTRAP_SETUP_CODE_REQUEST_FAILED',
                resourceType: 'bootstrap',
                resourceId: 'setup_code',
                error: error instanceof Error ? error.message : String(error),
                ...auditContext
            });
            throw error;
        }
    }
);

export const $verifyBootstrapSetupCode = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            code: z.string().min(1)
        })
    )
    .handler(async ({ data }) => {
        const auditContext = buildBootstrapAuditContext({
            operation: '$verifyBootstrapSetupCode'
        });
        try {
            await verifyBootstrapSetupCode({ code: data.code });
            await logAuditSuccess({
                action: 'BOOTSTRAP_SETUP_CODE_VERIFIED',
                resourceType: 'bootstrap',
                resourceId: 'setup_code',
                ...auditContext
            });
        } catch (error) {
            await logAuditFailure({
                action: 'BOOTSTRAP_SETUP_CODE_VERIFY_FAILED',
                resourceType: 'bootstrap',
                resourceId: 'setup_code',
                error: error instanceof Error ? error.message : String(error),
                ...auditContext
            });
            throw error;
        }
    });

export const $submitBootstrapAdminAndSmtp = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            adminEmail: z.email(),
            smtp: z.object({
                host: z.string().min(1),
                port: z.number().int().positive(),
                secure: z.boolean(),
                requireTLS: z.boolean(),
                ignoreTLS: z.boolean(),
                tlsRejectUnauthorized: z.boolean(),
                tlsServername: z.string(),
                connectionTimeoutMs: z.number().int().positive(),
                user: z.string().min(1),
                pass: z.string().min(1),
                from: z.email()
            })
        })
    )
    .handler(async ({ data }) => {
        const auditContext = buildBootstrapAuditContext({
            operation: '$submitBootstrapAdminAndSmtp'
        });
        try {
            await submitBootstrapAdminAndSmtp({
                adminEmail: data.adminEmail,
                smtp: data.smtp
            });
            await logAuditSuccess({
                action: 'BOOTSTRAP_SMTP_SUBMITTED',
                resourceType: 'bootstrap',
                resourceId: data.adminEmail.toLowerCase(),
                changes: { adminEmail: data.adminEmail.toLowerCase() },
                ...auditContext
            });
        } catch (error) {
            await logAuditFailure({
                action: 'BOOTSTRAP_SMTP_SUBMIT_FAILED',
                resourceType: 'bootstrap',
                resourceId: data.adminEmail.toLowerCase(),
                error: error instanceof Error ? error.message : String(error),
                ...auditContext
            });
            throw error;
        }
    });

export const $verifyBootstrapOtpAndFinalize = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            otp: z.string().min(1)
        })
    )
    .handler(async ({ data }) => {
        const auditContext = buildBootstrapAuditContext({
            operation: '$verifyBootstrapOtpAndFinalize'
        });
        try {
            await verifyBootstrapOtpAndFinalize({ otp: data.otp });
            await logAuditSuccess({
                action: 'BOOTSTRAP_FINALIZED',
                resourceType: 'bootstrap',
                resourceId: 'bootstrap',
                ...auditContext
            });
        } catch (error) {
            await logAuditFailure({
                action: 'BOOTSTRAP_FINALIZE_FAILED',
                resourceType: 'bootstrap',
                resourceId: 'bootstrap',
                error: error instanceof Error ? error.message : String(error),
                ...auditContext
            });
            throw error;
        }
    });

export const $finalizeFirstAdminForCurrentUser = createServerFn({ method: 'POST' })
    .middleware([freshAuthMiddleware])
    .handler(async ({ context }) => {
        const role: NonNullable<AuthContext['user']>['role'] =
            context.user.role === 'admin'
                ? 'admin'
                : context.user.role === 'operator'
                  ? 'operator'
                  : 'user';
        const authContext: AuthContext = {
            user: {
                email: context.user.email,
                role
            }
        };
        const auditContext = buildBootstrapAuditContext({
            operation: '$finalizeFirstAdminForCurrentUser',
            authContext
        });
        try {
            const result = await finalizeFirstAdminForUser({
                userId: context.user?.id ?? null,
                email: context.user.email
            });
            if (result.promoted) {
                await logAuditSuccess({
                    action: 'BOOTSTRAP_FIRST_ADMIN_PROMOTED',
                    actorId: context.user.email,
                    resourceType: 'bootstrap',
                    resourceId: context.user.email.toLowerCase(),
                    ...auditContext
                });
            }
            return result;
        } catch (error) {
            await logAuditFailure({
                action: 'BOOTSTRAP_FIRST_ADMIN_PROMOTION_FAILED',
                actorId: context.user.email,
                resourceType: 'bootstrap',
                resourceId: context.user.email.toLowerCase(),
                error: error instanceof Error ? error.message : String(error),
                ...auditContext
            });
            throw error;
        }
    });
