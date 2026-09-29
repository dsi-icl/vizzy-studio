import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { traceNodeModules } from 'nf3';

const entry = resolve('apps/web/src/lib/jobs/imageTileWorker.mjs');
const outDir = resolve('apps/web/.output/image-worker');
await mkdir(outDir, { recursive: true });
await copyFile(entry, resolve(outDir, 'worker.mjs'));
// Use lockfile-installed dependencies for the build platform. The worker has
// its own dependency tree; it does not rely on Nitro's inlined Sharp module.
await traceNodeModules([entry, createRequire(entry).resolve('sharp')], {
    rootDir: process.cwd(),
    outDir,
    writePackageJson: false
});
