import { join } from 'node:path';

import { z } from 'zod';

const RawEnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    PORT: z.coerce.number().int().positive().optional(),
    VITE_BASE_URL: z.string().optional(),
    BOOT_NETWORK_CHECK_ENABLED: z.string().optional(),
    BOOT_NETWORK_CHECK_HOST: z.string().optional(),
    BOOT_NETWORK_CHECK_PORT: z.coerce.number().int().positive().optional(),
    BOOT_NETWORK_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    SERVER_DATABASE_URL: z.string().min(1).optional(),
    SERVER_AUTH_SECRET: z.string().min(1).optional(),
    SERVER_CONFIG_ENCRYPTION_KEY: z.string().min(1).optional(),
    MARTIN_BASE_URL: z.string().optional(),
    MARTIN_TILE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    ALLOWED_HOSTS: z.string().optional(),
    TRUSTED_ORIGINS: z.string().optional(),

    APP_DATA_DIR: z.string().optional(),
    UPLOAD_DIR: z.string().optional(),
    TMP_DIR: z.string().optional(),
    ASSET_DIR: z.string().optional(),
    CONTROLLER_DIR: z.string().optional(),

    PLAYWRIGHT_BROWSERS_PATH: z.string().optional(),
    FFMPEG_PATH: z.string().optional(),
    FFMPEG_STATIC_URL: z.string().optional(),
    FFMPEG_STATIC_SHA256: z.string().optional()
});

const parsedRaw = RawEnvSchema.safeParse(process.env);
const raw = parsedRaw.success ? parsedRaw.data : {};

const criticalChecks = [
    {
        key: 'SERVER_DATABASE_URL',
        ok: !!raw.SERVER_DATABASE_URL,
        message: 'Missing SERVER_DATABASE_URL (MongoDB connection string).'
    },
    {
        key: 'SERVER_AUTH_SECRET',
        ok: !!raw.SERVER_AUTH_SECRET,
        message: 'Missing SERVER_AUTH_SECRET (session/auth signing secret).'
    },
    {
        key: 'SERVER_CONFIG_ENCRYPTION_KEY',
        ok: !!raw.SERVER_CONFIG_ENCRYPTION_KEY,
        message: 'Missing SERVER_CONFIG_ENCRYPTION_KEY (encryption key for config secrets).'
    }
] as const;

const issues = criticalChecks.filter((c) => !c.ok).map((c) => c.message);

export const bootHealth = {
    ok: issues.length === 0,
    issues
} as const;

export const env = {
    NODE_ENV: raw.NODE_ENV ?? 'development',
    PORT: raw.PORT ?? 3000,
    VITE_BASE_URL: raw.VITE_BASE_URL ?? 'http://localhost:3000',
    BOOT_NETWORK_CHECK_ENABLED: raw.BOOT_NETWORK_CHECK_ENABLED ?? 'true',
    BOOT_NETWORK_CHECK_HOST: raw.BOOT_NETWORK_CHECK_HOST ?? 'example.com',
    BOOT_NETWORK_CHECK_PORT: raw.BOOT_NETWORK_CHECK_PORT ?? 443,
    BOOT_NETWORK_CHECK_TIMEOUT_MS: raw.BOOT_NETWORK_CHECK_TIMEOUT_MS ?? 5000,

    SERVER_DATABASE_URL: raw.SERVER_DATABASE_URL ?? '',
    SERVER_AUTH_SECRET: raw.SERVER_AUTH_SECRET ?? '',
    SERVER_CONFIG_ENCRYPTION_KEY: raw.SERVER_CONFIG_ENCRYPTION_KEY ?? '',
    MARTIN_BASE_URL: raw.MARTIN_BASE_URL ?? '',
    MARTIN_TILE_TIMEOUT_MS: raw.MARTIN_TILE_TIMEOUT_MS ?? 8000,

    ALLOWED_HOSTS: raw.ALLOWED_HOSTS ?? raw.VITE_BASE_URL ?? 'http://localhost:3000',
    TRUSTED_ORIGINS: raw.TRUSTED_ORIGINS ?? raw.VITE_BASE_URL ?? 'http://localhost:3000',

    APP_DATA_DIR: raw.APP_DATA_DIR ?? join(process.cwd(), '.data'),
    UPLOAD_DIR: raw.UPLOAD_DIR ?? '',
    TMP_DIR: raw.TMP_DIR ?? '',
    ASSET_DIR: raw.ASSET_DIR ?? '',
    CONTROLLER_DIR: raw.CONTROLLER_DIR ?? '',

    PLAYWRIGHT_BROWSERS_PATH: raw.PLAYWRIGHT_BROWSERS_PATH ?? '',
    FFMPEG_PATH: raw.FFMPEG_PATH ?? '',
    FFMPEG_STATIC_URL:
        raw.FFMPEG_STATIC_URL ??
        'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    FFMPEG_STATIC_SHA256: raw.FFMPEG_STATIC_SHA256 ?? ''
} as const;

export function splitCsv(value: string): string[] {
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
