import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, loadEnv } from 'vite';
import mkcert from 'vite-plugin-mkcert';

import { thirdPartyNoticesPlugin } from './plugins/thirdPartyNotices';
import { ttfPlugin } from './plugins/ttf';
import { resolveBuildMetadata } from './tools/buildMetadata';

const shouldEnableSourceMaps = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.BUILD_SOURCEMAPS ?? '').toLowerCase()
);

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const isHttps = env.VITE_HTTPS === 'true';
    const buildMetadata = resolveBuildMetadata(env);

    return {
        define: {
            __APP_COMMIT_SHA__: JSON.stringify(buildMetadata.commitSha),
            __APP_BUILD_TIMESTAMP__: JSON.stringify(buildMetadata.timestamp)
        },
        build: {
            sourcemap: shouldEnableSourceMaps,
            rollupOptions: {
                // Keep Playwright out of bundled server chunks. It is a runtime-only dependency
                // for the screenshot endpoint and may reference deep optional modules.
                external: ['playwright', 'playwright-core', 'chromium-bidi']
            }
        },
        resolve: {
            tsconfigPaths: true
        },
        server: {
            host: '0.0.0.0',
            port: 3670,
            allowedHosts: ['localhost', '127.0.0.1']
            // https: isHttps ? {} : undefined
        },
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                cssModules: true
            }
        },
        plugins: [
            isHttps
                ? mkcert({
                      keyFileName: 'vizzy-studio-dev-key.pem',
                      certFileName: 'vizzy-studio-dev-cert.pem'
                  })
                : undefined,
            ttfPlugin(),
            thirdPartyNoticesPlugin(),
            devtools({
                // Avoid runtime console serialization loops in complex React/Nitro error paths.
                // Keeps devtools available while disabling the console-pipe injection.
                consolePiping: { enabled: false }
            }),
            tanstackStart(),
            // https://tanstack.com/start/latest/docs/framework/react/guide/hosting
            nitro({
                serverDir: './src/addons',
                features: { websocket: true }
            }),
            viteReact(),
            // https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md#react-compiler
            babel({
                presets: [
                    reactCompilerPreset({
                        target: '19'
                    })
                ]
            }),
            tailwindcss()
        ]
    };
});
