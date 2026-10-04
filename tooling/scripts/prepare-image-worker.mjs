import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { traceNodeModules } from 'nf3';

const entry = resolve('apps/web/src/lib/jobs/imageTileWorker.mjs');
const outDir = resolve('apps/web/.output/image-worker');
await mkdir(outDir, { recursive: true });
await copyFile(entry, resolve(outDir, 'worker.mjs'));
const result = await Bun.build({
    entrypoints: [resolve('apps/web/src/workers/imageTiles.ts')],
    outdir: outDir,
    naming: 'queue.mjs',
    target: 'node',
    format: 'esm',
    tsconfig: resolve('apps/web/tsconfig.json'),
    external: ['sharp', 'mongodb'],
    define: { 'process.env.NODE_ENV': '"production"' }
});
if (!result.success) throw new AggregateError(result.logs, 'Image worker build failed.');
// Use lockfile-installed dependencies for the build platform. The worker has
// its own dependency tree; it does not rely on Nitro's inlined Sharp module.
await traceNodeModules(
    [entry, createRequire(entry).resolve('sharp'), createRequire(entry).resolve('mongodb')],
    {
        rootDir: process.cwd(),
        outDir,
        writePackageJson: false
    }
);
