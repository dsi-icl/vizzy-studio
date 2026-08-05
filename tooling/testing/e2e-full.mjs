import { spawnSync } from 'node:child_process';

// Convenience runner for the end-to-end suite so `test:e2e` is not a footgun.
// Mirrors the CI `security-harness` job locally: start the Docker stack, wait for
// the web service and seed the auth fixtures, run Playwright, then always tear the
// stack back down. Pass `--keep-up` (or set E2E_KEEP_UP=1) to leave the containers
// running for debugging after a failure.

const keepUp =
    process.argv.includes('--keep-up') ||
    ['1', 'true', 'yes'].includes(String(process.env.E2E_KEEP_UP ?? '').toLowerCase());

function run(label, script) {
    console.log(`\n[e2e:full] ${label} → bun run ${script}`);
    const result = spawnSync(`bun run ${script}`, { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        const code = result.status ?? 1;
        throw Object.assign(new Error(`[e2e:full] "${script}" exited with code ${code}`), { code });
    }
}

let exitCode = 0;
try {
    run('Starting test stack', 'test:harness:up');
    run('Preparing fixtures (health check + seed)', 'test:harness:prepare');
    run('Running integration suite', 'test:integration');
    run('Running end-to-end suite', 'test:e2e');
    console.log('\n[e2e:full] ✅ integration and end-to-end suites passed');
} catch (error) {
    exitCode = error?.code ?? 1;
    console.error(`\n${error?.message ?? error}`);
} finally {
    if (keepUp) {
        console.log(
            '\n[e2e:full] --keep-up set; leaving stack running (tear down with: bun run test:harness:down)'
        );
    } else {
        console.log('\n[e2e:full] Tearing down test stack');
        spawnSync('bun run test:harness:down', { stdio: 'inherit', shell: true });
    }
}

process.exit(exitCode);
