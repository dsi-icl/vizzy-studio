import { spawnSync } from 'node:child_process';

function run(command, args, opts = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts
    });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || '').trim() || `${command} failed`);
    }
    return (result.stdout || '').trim();
}

function tryRun(command, args) {
    try {
        return run(command, args);
    } catch {
        return '';
    }
}

const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const fullRevision = tryRun('git', ['rev-parse', 'HEAD']) || 'unknown';
const shortRevision = fullRevision !== 'unknown' ? fullRevision.slice(0, 12) : 'unknown';
const isDirty = tryRun('git', ['status', '--porcelain']).length > 0;
const version = shortRevision === 'unknown' ? 'dev' : `${shortRevision}${isDirty ? '-dirty' : ''}`;
const source =
    tryRun('git', ['remote', 'get-url', 'origin']).replace(
        /^git@github\.com:/,
        'https://github.com/'
    ) || 'https://github.com/dsi-icl/vizzy-studio';

const image = process.env.IMAGE_NAME || 'vizzy-studio:local';
const buildSourceMaps = process.env.BUILD_SOURCEMAPS || 'false';
const keepSourceMaps = process.env.KEEP_SOURCE_MAPS || buildSourceMaps;
const extraArgs = process.argv.slice(2);

const dockerArgs = [
    'build',
    '-t',
    image,
    '--build-arg',
    `OCI_CREATED=${created}`,
    '--build-arg',
    `OCI_VERSION=${version}`,
    '--build-arg',
    `OCI_REVISION=${fullRevision}`,
    '--build-arg',
    `OCI_SOURCE=${source}`,
    '--build-arg',
    `BUILD_SOURCEMAPS=${buildSourceMaps}`,
    '--build-arg',
    `KEEP_SOURCE_MAPS=${keepSourceMaps}`,
    ...extraArgs,
    '.'
];

console.log(`[docker:build] image=${image}`);
console.log(`[docker:build] OCI_CREATED=${created}`);
console.log(`[docker:build] OCI_VERSION=${version}`);
console.log(`[docker:build] OCI_REVISION=${fullRevision}`);
console.log(`[docker:build] OCI_SOURCE=${source}`);
console.log(`[docker:build] BUILD_SOURCEMAPS=${buildSourceMaps}`);
console.log(`[docker:build] KEEP_SOURCE_MAPS=${keepSourceMaps}`);

const docker = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
if (docker.status !== 0) {
    process.exit(docker.status ?? 1);
}
