import { describe, expect, test } from 'bun:test';

import {
    buildDemoLaunchUrl,
    directDemoPath,
    isAllowedDemoPath,
    parseDemoLaunchPath,
    parseDemoSource,
    parseDirectDemoUpstreams,
    safeDemoRedirect
} from '../../src/lib/demoGatewayPaths';

const PROJECT_ID = '69fb297952b72213cf9f59b8';
const PUBLIC_ORIGIN = 'https://vizzy-studio-demos.dsi.ic.ac.uk';
const UPSTREAM_ORIGIN = new URL('http://146.169.9.215:5780');

describe('host based demo gateway paths', () => {
    test('creates a launch URL on the existing demos host', () => {
        const launch = buildDemoLaunchUrl(PUBLIC_ORIGIN, PROJECT_ID, 'screen', 'one-use-ticket');
        expect(launch).toBe(
            `${PUBLIC_ORIGIN}/_vizzy/demo-launch/${PROJECT_ID}/screen?ticket=one-use-ticket`
        );
        expect(parseDemoLaunchPath(new URL(launch).pathname)).toEqual({
            projectId: PROJECT_ID,
            kind: 'screen'
        });
        expect(parseDemoLaunchPath('/_vizzy/demo-launch/bad-id/screen')).toBeNull();
    });

    test('only accepts stored demo URLs from the configured public host', () => {
        expect(
            parseDemoSource(`${PUBLIC_ORIGIN}/sustainability/control`, PUBLIC_ORIGIN)?.slug
        ).toBe('sustainability');
        expect(
            parseDemoSource('https://other.example/sustainability/control', PUBLIC_ORIGIN)
        ).toBeNull();
        expect(parseDemoSource(`${PUBLIC_ORIGIN}/api/private`, PUBLIC_ORIGIN)).toBeNull();
    });

    test('keeps compiled asset and shared Nginx paths unchanged', () => {
        expect(isAllowedDemoPath('/sustainability/assets/index.js', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/network/network.html', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/pages/map.png', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/bus', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/bitcoin/assets/index.js', 'sustainability')).toBe(false);
    });

    test('rewrites upstream redirects without exposing the demos VM address', () => {
        const upstreamRequest = new URL('/sustainability/control', UPSTREAM_ORIGIN);
        expect(
            safeDemoRedirect(
                '/sustainability/control?operator=A',
                upstreamRequest,
                UPSTREAM_ORIGIN,
                new URL(PUBLIC_ORIGIN),
                'sustainability'
            )
        ).toBe('/sustainability/control?operator=A');
        expect(
            safeDemoRedirect(
                'http://146.169.9.215:5780/sustainability/screen',
                upstreamRequest,
                UPSTREAM_ORIGIN,
                new URL(PUBLIC_ORIGIN),
                'sustainability'
            )
        ).toBe('/sustainability/screen');
        expect(
            safeDemoRedirect(
                'https://other.example/private',
                upstreamRequest,
                UPSTREAM_ORIGIN,
                new URL(PUBLIC_ORIGIN),
                'sustainability'
            )
        ).toBeNull();
    });

    test('maps one configured demo to its own port without changing public asset URLs', () => {
        const routes = parseDirectDemoUpstreams(
            '{"sustainability":{"origin":"http://146.169.9.215:3002","assetsFromRoot":true}}'
        );
        const route = routes?.get('sustainability');
        expect(route?.origin.origin).toBe('http://146.169.9.215:3002');
        expect(
            route && directDemoPath('/sustainability/assets/main.js', 'sustainability', route)
        ).toBe('/assets/main.js');
        expect(route && directDemoPath('/sustainability/control', 'sustainability', route)).toBe(
            '/sustainability/control'
        );
        expect(route && directDemoPath('/api/data', 'sustainability', route)).toBe('/api/data');
        expect(
            route &&
                safeDemoRedirect(
                    '/assets/main.js',
                    new URL('/sustainability/control', route.origin),
                    route.origin,
                    new URL(PUBLIC_ORIGIN),
                    'sustainability',
                    route
                )
        ).toBe('/sustainability/assets/main.js');
        expect(
            parseDirectDemoUpstreams(
                '{"api":{"origin":"http://127.0.0.1:1","assetsFromRoot":true}}'
            )
        ).toBeNull();
        expect(
            parseDirectDemoUpstreams(
                '{"sustainability":{"origin":"https://evil.example/path","assetsFromRoot":true}}'
            )
        ).toBeNull();
    });
});
