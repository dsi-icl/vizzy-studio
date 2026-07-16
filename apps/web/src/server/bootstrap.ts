import '@tanstack/react-start/server-only';
import { randomBytes, createHash } from 'node:crypto';

import { createSmtpTransport } from '@repo/auth/smtp';
import { getConfigValue, getSmtpConfig, setConfigValue } from '@repo/db/config';
import { OtpEmail } from '@repo/emails/OtpEmail';
import { render } from 'react-email';

import { collections } from '~/server/collections';

const PHASE_KEY = 'bootstrap.phase';
const SETUP_CODE_HASH_KEY = 'bootstrap.setupCodeHash';
const SETUP_CODE_EXPIRES_AT_KEY = 'bootstrap.setupCodeExpiresAt';
const SETUP_CODE_REQUESTED_AT_KEY = 'bootstrap.setupCodeRequestedAt';
const SETUP_CODE_VERIFIED_AT_KEY = 'bootstrap.setupCodeVerifiedAt';
const PENDING_KEY = 'bootstrap.pending';
const FIRST_ADMIN_EMAIL_KEY = 'bootstrap.firstAdminEmail';
const SMTP_VERIFIED_AT_KEY = 'bootstrap.smtpVerifiedAt';
const COMPLETED_AT_KEY = 'bootstrap.completedAt';

const SETUP_CODE_TTL_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;

type BootstrapPhase =
    | 'intro'
    | 'code_requested'
    | 'code_verified'
    | 'smtp_pending_verification'
    | 'completed';

type BootstrapPendingPayload = {
    adminEmail: string;
    smtp: BootstrapSmtpInput;
    otpHash: string;
    otpExpiresAt: string;
};

export type BootstrapSmtpInput = {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    ignoreTLS: boolean;
    tlsRejectUnauthorized: boolean;
    tlsServername: string;
    connectionTimeoutMs: number;
    user: string;
    pass: string;
    from: string;
};

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function makeSetupCode(): string {
    return randomBytes(4).toString('hex').toUpperCase();
}

function makeOtpCode(): string {
    return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function hashValue(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nowIso(): string {
    return new Date().toISOString();
}

function addMs(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
}

function parseIso(value: string | null): number {
    if (!value) return 0;
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : 0;
}

function isExpired(iso: string | null): boolean {
    const at = parseIso(iso);
    if (!at) return true;
    return at <= Date.now();
}

async function getUserCount(): Promise<number> {
    return collections.users.countDocuments();
}

async function getAdminCount(): Promise<number> {
    return collections.users.countDocuments({ role: 'admin' });
}

function normalizeSmtpInput(input: BootstrapSmtpInput): BootstrapSmtpInput {
    return {
        host: input.host.trim(),
        port: input.port,
        secure: !!input.secure,
        requireTLS: !!input.requireTLS,
        ignoreTLS: !!input.ignoreTLS,
        tlsRejectUnauthorized: !!input.tlsRejectUnauthorized,
        tlsServername: input.tlsServername.trim(),
        connectionTimeoutMs: input.connectionTimeoutMs,
        user: input.user.trim(),
        pass: input.pass,
        from: normalizeEmail(input.from)
    };
}

async function getPhase(): Promise<BootstrapPhase> {
    const raw = await getConfigValue<string>(PHASE_KEY);
    if (
        raw === 'intro' ||
        raw === 'code_requested' ||
        raw === 'code_verified' ||
        raw === 'smtp_pending_verification' ||
        raw === 'completed'
    ) {
        return raw;
    }
    return 'intro';
}

async function setPhase(phase: BootstrapPhase): Promise<void> {
    await setConfigValue({
        key: PHASE_KEY,
        value: phase,
        encrypted: false,
        updatedBy: 'system:bootstrap'
    });
}

async function sendOtpWithSmtp(input: { smtp: BootstrapSmtpInput; to: string; otp: string }) {
    const transport = await createSmtpTransport(input.smtp);

    const html = await render(OtpEmail({ otp: input.otp }));
    await transport.sendMail({
        from: input.smtp.from,
        to: normalizeEmail(input.to),
        subject: 'Vizzy Studio Bootstrap Verification Code',
        html
    });
}

async function maybeAutoCompleteForExistingInstall(): Promise<boolean> {
    const [completedAt, users, admins, smtp] = await Promise.all([
        getConfigValue<string>(COMPLETED_AT_KEY),
        getUserCount(),
        getAdminCount(),
        getSmtpConfig()
    ]);

    if (completedAt) return true;
    if (users > 0 && admins > 0 && smtp) {
        const stamp = nowIso();
        await Promise.all([
            setConfigValue({
                key: SMTP_VERIFIED_AT_KEY,
                value: stamp,
                encrypted: false,
                updatedBy: 'system:bootstrap-auto'
            }),
            setConfigValue({
                key: COMPLETED_AT_KEY,
                value: stamp,
                encrypted: false,
                updatedBy: 'system:bootstrap-auto'
            }),
            setPhase('completed')
        ]);
        return true;
    }

    return false;
}

export async function getBootstrapStatus(): Promise<{
    requiresBootstrap: boolean;
    phase: BootstrapPhase;
    needsSetupCode: boolean;
    setupCodeRequestedAt: string | null;
    hasVerifiedSetupCode: boolean;
    needsAdminClaim: boolean;
    claimedEmail: string | null;
    smtpConfigured: boolean;
    smtpVerified: boolean;
}> {
    const isCompleted = await maybeAutoCompleteForExistingInstall();
    if (isCompleted) {
        return {
            requiresBootstrap: false,
            phase: 'completed',
            needsSetupCode: false,
            setupCodeRequestedAt: null,
            hasVerifiedSetupCode: true,
            needsAdminClaim: false,
            claimedEmail: await getConfigValue<string>(FIRST_ADMIN_EMAIL_KEY),
            smtpConfigured: true,
            smtpVerified: true
        };
    }

    const [
        phase,
        setupCodeRequestedAt,
        setupCodeVerifiedAt,
        claimedEmail,
        smtp,
        smtpVerifiedAt,
        users,
        admins
    ] = await Promise.all([
        getPhase(),
        getConfigValue<string>(SETUP_CODE_REQUESTED_AT_KEY),
        getConfigValue<string>(SETUP_CODE_VERIFIED_AT_KEY),
        getConfigValue<string>(FIRST_ADMIN_EMAIL_KEY),
        getSmtpConfig(),
        getConfigValue<string>(SMTP_VERIFIED_AT_KEY),
        getUserCount(),
        getAdminCount()
    ]);

    const smtpConfigured = !!smtp;
    const smtpVerified = !!smtpVerifiedAt;

    return {
        requiresBootstrap: true,
        phase,
        needsSetupCode: phase === 'intro' || phase === 'code_requested',
        setupCodeRequestedAt,
        hasVerifiedSetupCode: !!setupCodeVerifiedAt,
        needsAdminClaim: users === 0 || admins === 0,
        claimedEmail: claimedEmail ? normalizeEmail(claimedEmail) : null,
        smtpConfigured,
        smtpVerified
    };
}

export async function requestBootstrapSetupCodeDisplay(): Promise<void> {
    const status = await getBootstrapStatus();
    if (!status.requiresBootstrap) {
        throw new Error('Bootstrap is already complete.');
    }

    const code = makeSetupCode();
    const requestedAt = nowIso();
    const expiresAt = addMs(SETUP_CODE_TTL_MS);

    await Promise.all([
        setConfigValue({
            key: SETUP_CODE_HASH_KEY,
            value: hashValue(code),
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_REQUESTED_AT_KEY,
            value: requestedAt,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_EXPIRES_AT_KEY,
            value: expiresAt,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_VERIFIED_AT_KEY,
            value: null,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: PENDING_KEY,
            value: null,
            encrypted: true,
            updatedBy: 'system:bootstrap'
        }),
        setPhase('code_requested')
    ]);

    console.warn('[bootstrap] Onboarding code requested.');
    console.warn(`[bootstrap] Setup code: ${code}`);
    console.warn(`[bootstrap] Expires at: ${expiresAt}`);
    console.warn('[bootstrap] Continue in /bootstrap and enter this code.');
}

export async function verifyBootstrapSetupCode(input: { code: string }): Promise<void> {
    const status = await getBootstrapStatus();
    if (!status.requiresBootstrap) {
        throw new Error('Bootstrap is already complete.');
    }

    const [hash, expiresAt] = await Promise.all([
        getConfigValue<string>(SETUP_CODE_HASH_KEY),
        getConfigValue<string>(SETUP_CODE_EXPIRES_AT_KEY)
    ]);

    if (!hash || !expiresAt || isExpired(expiresAt)) {
        throw new Error('Setup code is missing or expired. Request a new code from step 2.');
    }

    if (hashValue(input.code.trim().toUpperCase()) !== hash) {
        throw new Error('Invalid setup code.');
    }

    await Promise.all([
        setConfigValue({
            key: SETUP_CODE_VERIFIED_AT_KEY,
            value: nowIso(),
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setPhase('code_verified')
    ]);
}

export async function submitBootstrapAdminAndSmtp(input: {
    adminEmail: string;
    smtp: BootstrapSmtpInput;
}): Promise<void> {
    const status = await getBootstrapStatus();
    if (!status.requiresBootstrap) {
        throw new Error('Bootstrap is already complete.');
    }

    const phase = await getPhase();
    if (!(phase === 'code_verified' || phase === 'smtp_pending_verification')) {
        throw new Error('Setup code must be verified before submitting SMTP details.');
    }

    const setupCodeVerifiedAt = await getConfigValue<string>(SETUP_CODE_VERIFIED_AT_KEY);
    if (!setupCodeVerifiedAt) {
        throw new Error('Setup code must be verified before submitting SMTP details.');
    }

    const smtp = normalizeSmtpInput(input.smtp);
    if (!smtp.host || !smtp.user || !smtp.pass || !smtp.from || !normalizeEmail(input.adminEmail)) {
        throw new Error('Missing required admin email or SMTP fields.');
    }

    const otp = makeOtpCode();
    const otpHash = hashValue(otp);
    const otpExpiresAt = addMs(OTP_TTL_MS);
    const adminEmail = normalizeEmail(input.adminEmail);

    await sendOtpWithSmtp({
        smtp,
        to: adminEmail,
        otp
    });

    const pending: BootstrapPendingPayload = {
        adminEmail,
        smtp,
        otpHash,
        otpExpiresAt
    };

    await Promise.all([
        setConfigValue({
            key: PENDING_KEY,
            value: pending,
            encrypted: true,
            updatedBy: 'system:bootstrap'
        }),
        setPhase('smtp_pending_verification')
    ]);
}

export async function verifyBootstrapOtpAndFinalize(input: { otp: string }): Promise<void> {
    const status = await getBootstrapStatus();
    if (!status.requiresBootstrap) {
        throw new Error('Bootstrap is already complete.');
    }

    const phase = await getPhase();
    if (phase !== 'smtp_pending_verification') {
        throw new Error('SMTP verification step has not started yet.');
    }

    const pending = await getConfigValue<BootstrapPendingPayload>(PENDING_KEY);
    if (!pending) {
        throw new Error('No pending SMTP verification found. Submit SMTP details again.');
    }

    if (isExpired(pending.otpExpiresAt)) {
        throw new Error('Verification code has expired. Go back and request a new one.');
    }

    if (hashValue(input.otp.trim()) !== pending.otpHash) {
        throw new Error('Invalid verification code.');
    }

    const stamp = nowIso();

    await Promise.all([
        setConfigValue({
            key: FIRST_ADMIN_EMAIL_KEY,
            value: pending.adminEmail,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.host',
            value: pending.smtp.host,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.port',
            value: pending.smtp.port,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.secure',
            value: pending.smtp.secure,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.requireTLS',
            value: pending.smtp.requireTLS,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.ignoreTLS',
            value: pending.smtp.ignoreTLS,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.tlsRejectUnauthorized',
            value: pending.smtp.tlsRejectUnauthorized,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.tlsServername',
            value: pending.smtp.tlsServername,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.connectionTimeoutMs',
            value: pending.smtp.connectionTimeoutMs,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.user',
            value: pending.smtp.user,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.pass',
            value: pending.smtp.pass,
            encrypted: true,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: 'smtp.from',
            value: pending.smtp.from,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SMTP_VERIFIED_AT_KEY,
            value: stamp,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: COMPLETED_AT_KEY,
            value: stamp,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: PENDING_KEY,
            value: null,
            encrypted: true,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_HASH_KEY,
            value: null,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_EXPIRES_AT_KEY,
            value: null,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setConfigValue({
            key: SETUP_CODE_VERIFIED_AT_KEY,
            value: stamp,
            encrypted: false,
            updatedBy: 'system:bootstrap'
        }),
        setPhase('completed')
    ]);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function finalizeFirstAdminForUser(input: {
    userId?: string | null;
    email?: string | null;
}): Promise<{ promoted: boolean; reason?: string }> {
    const completedAt = await getConfigValue<string>(COMPLETED_AT_KEY);
    if (!completedAt) return { promoted: false, reason: 'bootstrap_not_completed' };

    const email = normalizeEmail(input.email ?? '');
    if (!email) return { promoted: false, reason: 'missing_email' };

    const adminCount = await getAdminCount();
    if (adminCount > 0) return { promoted: false, reason: 'admin_already_exists' };

    const claimedEmail = normalizeEmail(
        (await getConfigValue<string>(FIRST_ADMIN_EMAIL_KEY)) ?? ''
    );
    if (!claimedEmail) return { promoted: false, reason: 'email_not_claimed' };
    if (claimedEmail !== email) return { promoted: false, reason: 'email_not_claimed_for_user' };

    const users = collections.users;
    let target = null as null | { _id: unknown; email?: string };
    if (input.userId) {
        target = await users.findOne({ id: input.userId }, { projection: { _id: 1, email: 1 } });
    }

    if (!target) {
        target = await users.findOne(
            { email: { $regex: `^${escapeRegExp(email)}$`, $options: 'i' } },
            { projection: { _id: 1, email: 1 } }
        );
    }

    if (!target?._id) return { promoted: false, reason: 'user_not_found' };

    await users.updateOne(
        { _id: target._id },
        {
            $set: { role: 'admin', updatedAt: new Date() },
            $unset: { banned: '', banReason: '', banExpires: '' }
        }
    );

    console.warn(`[bootstrap] Promoted ${email} to admin.`);
    return { promoted: true };
}
