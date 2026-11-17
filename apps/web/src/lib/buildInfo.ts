export const buildInfo = {
    commitSha: typeof __APP_COMMIT_SHA__ === 'undefined' ? 'unknown' : __APP_COMMIT_SHA__,
    builtAt: typeof __APP_BUILD_TIMESTAMP__ === 'undefined' ? 'unknown' : __APP_BUILD_TIMESTAMP__
} as const;
