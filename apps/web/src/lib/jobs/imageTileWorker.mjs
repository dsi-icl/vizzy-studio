// Standalone Node entry point used by the persistent image tile queue.
// Adapted from do-image-playground's Sharp -> MBTiles worker.
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

if (process.versions.bun) throw new Error('The image tile worker requires Node.js.');
if (process.channel) {
    process.on('disconnect', () => process.exit(1));
    process.channel.unref();
}

const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { source, dataDir, sourceId, maxPixels, concurrency = 1 } = request;
if (typeof sourceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sourceId)) {
    throw new Error('Invalid tile source ID.');
}
if (![source, dataDir].every((value) => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('Source and data directory must be absolute paths.');
}
if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new Error('A positive pixel ceiling is required.');
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('Invalid worker concurrency.');
}

sharp.cache({ memory: 64, files: 32, items: 64 });
sharp.concurrency(concurrency);
const tileSize = 512;
const workRoot = join(dataDir, 'image-tile-work');
const tileDir = join(dataDir, 'image-tiles');
const previewDir = join(dataDir, 'previews');
for (const dir of [workRoot, tileDir, previewDir]) await mkdir(dir, { recursive: true });
const workDir = request.workDir ?? (await mkdtemp(join(workRoot, `${sourceId}-`)));
if (
    !isAbsolute(workDir) ||
    dirname(resolve(workDir)) !== resolve(workRoot) ||
    !basename(workDir).startsWith(`${sourceId}-`)
) {
    throw new Error('Invalid worker scratch directory.');
}
const report = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const output = join(tileDir, `${sourceId}.mbtiles`);
const previewOutput = join(previewDir, `${sourceId}.webp`);

async function publishedManifest() {
    await stat(previewOutput);
    const db = new DatabaseSync(output, { readOnly: true });
    try {
        const metadata = Object.fromEntries(
            db
                .prepare('SELECT name, value FROM metadata')
                .all()
                .map(({ name, value }) => [name, value])
        );
        const width = Number(metadata['image:width']);
        const height = Number(metadata['image:height']);
        const maxZoom = Number(metadata.maxzoom);
        if (
            metadata.name !== sourceId ||
            metadata.format !== 'webp' ||
            metadata['image:tile_size'] !== '512' ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width * height > maxPixels ||
            maxZoom !== Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / tileSize)))
        ) {
            throw new Error('Invalid previously published image archive.');
        }
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM tiles').get();
        return {
            stage: 'published',
            sourceId,
            width,
            height,
            tileSize,
            maxZoom,
            tileCount: Number(count),
            output,
            preview: previewOutput,
            node: process.version,
            sharp: sharp.versions.sharp,
            reused: true
        };
    } finally {
        db.close();
    }
}

async function processImage() {
    if (
        request.reusePublished &&
        (await stat(output)
            .then(() => true)
            .catch((error) => {
                if (error.code === 'ENOENT') return false;
                throw error;
            }))
    ) {
        const manifest = await publishedManifest();
        report({
            stage: 'preview',
            width: manifest.width,
            height: manifest.height,
            preview: previewOutput
        });
        report(manifest);
        return;
    }
    const info = await sharp(source, { limitInputPixels: false }).metadata();
    if (!info.width || !info.height) throw new Error('Missing image dimensions.');
    if ((info.pages ?? 1) > 1) throw new Error('Only single-frame images are supported.');
    let width = info.width;
    let height = info.height;
    if (info.orientation >= 5) [width, height] = [height, width];
    if (width * height > maxPixels) throw new Error('Image exceeds the pixel ceiling.');

    const preview = join(workDir, 'preview.webp');
    await sharp(source, { limitInputPixels: maxPixels, sequentialRead: true })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(preview);
    await link(preview, previewOutput).catch((error) => {
        if (!request.reusePublished || error.code !== 'EEXIST') throw error;
    });
    report({ stage: 'preview', width, height, preview: previewOutput });

    const pyramid = join(workDir, 'pyramid');
    await sharp(source, { limitInputPixels: maxPixels, sequentialRead: true })
        .rotate()
        .webp({ quality: 90 })
        .tile({
            layout: 'google',
            size: tileSize,
            overlap: 0,
            depth: 'onetile',
            skipBlanks: -1,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .toFile(pyramid);
    report({ stage: 'packing' });

    const packed = join(workDir, 'image.mbtiles');
    const levels = (await readdir(pyramid)).filter((name) => /^\d+$/.test(name));
    if (!levels.length) throw new Error('No tile levels were produced.');
    const maxZoom = Math.max(...levels.map(Number));
    const db = new DatabaseSync(packed);
    let tileCount = 0;
    try {
        db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
                PRIMARY KEY (zoom_level, tile_column, tile_row)); BEGIN;`);
        const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?)');
        for (const [name, value] of Object.entries({
            name: sourceId,
            format: 'webp',
            type: 'overlay',
            version: '1.3',
            minzoom: '0',
            maxzoom: String(maxZoom),
            description: 'Non-geographic image',
            'image:width': String(width),
            'image:height': String(height),
            'image:tile_size': String(tileSize)
        }))
            metadata.run(name, value);
        const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
        // Sharp google layout is z/y/x.webp. MBTiles rows are bottom-up TMS.
        for (const level of levels) {
            const z = Number(level);
            for (const row of await readdir(join(pyramid, level))) {
                if (!/^\d+$/.test(row)) continue;
                for (const file of await readdir(join(pyramid, level, row))) {
                    if (!/^\d+\.webp$/.test(file)) continue;
                    insert.run(
                        z,
                        Number(file.slice(0, -5)),
                        2 ** z - 1 - Number(row),
                        await readFile(join(pyramid, level, row, file))
                    );
                    tileCount++;
                }
            }
        }
        db.exec('COMMIT;');
    } finally {
        db.close();
    }

    // Publish only closed archives. A hard link is atomic, requires the same
    // filesystem, and refuses to overwrite an existing immutable source ID.
    try {
        await link(packed, output);
    } catch (error) {
        if (request.reusePublished && error.code === 'EEXIST') {
            report(await publishedManifest());
            return;
        }
        // Keep the immutable preview for a retry. Never remove a preview that
        // another attempt may already reference from a completed archive.
        throw error;
    }
    report({
        stage: 'published',
        sourceId,
        width,
        height,
        tileSize,
        maxZoom,
        tileCount,
        output,
        preview: previewOutput,
        node: process.version,
        sharp: sharp.versions.sharp,
        reused: false
    });
}

try {
    await processImage();
} finally {
    await rm(workDir, { recursive: true, force: true });
}
