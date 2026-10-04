/* eslint-disable turbo/no-undeclared-env-vars -- Local development tooling, outside Turbo. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export const martinVersion = '1.16.1';
export const webRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url));
export const bundledMartin = join(webRoot, '.data', 'bin', 'martin');
export const martinConfig = fileURLToPath(new URL('./local.yaml', import.meta.url));

export function localMartinSettings() {
    try {
        // Match `bun dev`'s web working directory, including relative APP_DATA_DIR.
        // Explicit environment variables take precedence over the local .env file.
        loadEnvFile(join(webRoot, '.env'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const url = new URL(process.env.IMAGE_MARTIN_URL || 'http://127.0.0.1:3300');
    if (
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('Local Martin requires IMAGE_MARTIN_URL=http://127.0.0.1:<port>.');
    return {
        binary: process.env.MARTIN_BIN ? resolve(process.env.MARTIN_BIN) : bundledMartin,
        port: Number(url.port || 80),
        tileDir: resolve(webRoot, process.env.APP_DATA_DIR || '.data', 'image-tiles')
    };
}

// Pinned, checksum-verified installation shared by local development and its test.
export async function installMartin() {
    const target =
        process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)
            ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
            : process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)
              ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
              : null;
    if (!target) throw new Error(`Install Martin ${martinVersion} manually and set MARTIN_BIN.`);

    try {
        if (
            execFileSync(bundledMartin, ['--version'], { encoding: 'utf8' }).trim() ===
            `martin ${martinVersion}`
        ) {
            console.log(`[Martin] ${martinVersion} is already installed. Run bun run martin:dev.`);
            return;
        }
    } catch {
        /* Download if not installed. */
    }
    const releaseResponse = await fetch(
        `https://api.github.com/repos/maplibre/martin/releases/tags/martin-v${martinVersion}`,
        { signal: AbortSignal.timeout(30_000) }
    );
    if (!releaseResponse.ok)
        throw new Error(`Martin release lookup failed: ${releaseResponse.status}`);
    const release = await releaseResponse.json();
    const asset = release.assets.find((entry) => entry.name === `martin-${target}.tar.gz`);
    if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest ?? ''))
        throw new Error('Martin release archive or checksum is missing.');
    console.log(`[Martin] Downloading ${martinVersion} for ${target}…`);
    const response = await fetch(asset.browser_download_url, {
        signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`Martin download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest)
        throw new Error('Martin checksum mismatch.');
    const directory = dirname(bundledMartin);
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(join(directory, 'install-'));
    try {
        const archive = join(staging, 'martin.tar.gz');
        await writeFile(archive, bytes);
        execFileSync('tar', ['-xzf', archive, '-C', staging, 'martin']);
        const binary = join(staging, 'martin');
        if (
            execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !==
            `martin ${martinVersion}`
        )
            throw new Error('Unexpected Martin binary version.');
        await rename(binary, bundledMartin);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    console.log('[Martin] Installed. Run bun run martin:dev.');
}

export async function startMartin() {
    const { binary, port, tileDir } = localMartinSettings();
    let version;
    try {
        version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    } catch {
        throw new Error('Martin is unavailable. Run `bun run martin:install` first.');
    }
    if (version !== `martin ${martinVersion}`)
        throw new Error(`Expected Martin ${martinVersion}; found ${version}.`);
    await mkdir(tileDir, { recursive: true });
    await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', () =>
            reject(
                new Error(
                    `Port ${port} is already in use. Stop the previous local Martin before starting this one.`
                )
            )
        );
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    console.log(`[Martin] http://127.0.0.1:${port} — tiles: ${tileDir}`);
    const child = spawn(binary, ['--config', martinConfig], {
        stdio: 'inherit',
        env: {
            ...process.env,
            VIZZY_IMAGE_MARTIN_LISTEN: `127.0.0.1:${port}`,
            VIZZY_IMAGE_TILE_DIR: tileDir
        }
    });
    let stopping = false;
    const stop = (signal) => {
        stopping = true;
        child.kill(signal);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    child.once('error', (error) => {
        console.error(`[Martin] ${error.message}`);
        process.exitCode = 1;
    });
    child.once('exit', (code) => {
        process.exitCode = stopping ? 0 : (code ?? 1);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const command = process.argv[2];
        if (command === 'install') await installMartin();
        else if (command === 'dev') await startMartin();
        else throw new Error('Usage: node tooling/martin/local.mjs <install|dev>');
    } catch (error) {
        console.error(`[Martin] ${error.message}`);
        process.exitCode = 1;
    }
}
