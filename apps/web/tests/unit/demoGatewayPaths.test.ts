import { describe, expect, test } from 'bun:test';

import {
    buildDemoLaunchUrl,
    directDemoPath,
    isAllowedDemoPath as checkDemoPath,
    parseDemoLaunchPath,
    parseDemoSource as parseSource,
    parseDemoPathPolicy,
    parseDirectDemoUpstreams as parseUpstreams,
    safeDemoRedirect as rewriteRedirect,
    type DirectDemoUpstream
} from '../../src/lib/demoGatewayPaths';

const PROJECT_ID = '69fb297952b72213cf9f59b8';
const PUBLIC_ORIGIN = 'https://vizzy-studio-demos.dsi.ic.ac.uk';
const UPSTREAM_ORIGIN = new URL('http://146.169.9.215:5780');
const POLICY = parseDemoPathPolicy(
    JSON.stringify({
        bitcoin: ['api', 'ws', 'bus', 'btc-globe'],
        sustainability: ['api', 'bus', 'network', 'pages'],
        flyconnectome: [],
        nightingale: ['nightingale-wall', 'nightingale-screen', 'nightingale-control'],
        'london-map': [],
        ideafast: ['observatory'],
        'do-image': [],
        'do-stroke-map-germany': []
    })
)!;
const parseDemoSource = (url: string, origin: string) => parseSource(url, origin, POLICY);
const parseDirectDemoUpstreams = (raw: string) => parseUpstreams(raw, POLICY);
const isAllowedDemoPath = (path: string, slug: string) => checkDemoPath(path, slug, POLICY);
const safeDemoRedirect = (
    location: string,
    upstreamRequest: URL,
    upstreamOrigin: URL,
    publicOrigin: URL,
    slug: string,
    route?: DirectDemoUpstream
) => rewriteRedirect(location, upstreamRequest, upstreamOrigin, publicOrigin, slug, POLICY, route);

describe('host based demo gateway paths', () => {
    test('rejects invalid or ambiguous operator path rules', () => {
        expect(parseDemoPathPolicy('')).toBeNull();
        expect(parseDemoPathPolicy('{}')?.size).toBe(0);
        expect(parseDemoPathPolicy('{"bitcoin":["api","api"]}')).toBeNull();
        expect(parseDemoPathPolicy('{"bitcoin":["nightingale"],"nightingale":[]}')).toBeNull();
        expect(parseDemoPathPolicy('{"bitcoin":["screen"]}')).toBeNull();
        expect(parseDemoPathPolicy('{"bitcoin":["api"]}')?.get('bitcoin')?.has('api')).toBe(true);
    });

    test('accepts a new demo and its root path through configuration alone', () => {
        const configured = parseDemoPathPolicy('{"new-demo":["new-resource"],"other-demo":[]}')!;
        expect(
            parseSource(`${PUBLIC_ORIGIN}/new-demo/control`, PUBLIC_ORIGIN, configured)?.slug
        ).toBe('new-demo');
        expect(checkDemoPath('/new-resource/file.json', 'new-demo', configured)).toBe(true);
        expect(checkDemoPath('/new-resource/file.json', 'other-demo', configured)).toBe(false);
        expect(
            parseSource(`${PUBLIC_ORIGIN}/plain-demo/control`, PUBLIC_ORIGIN, configured)?.slug
        ).toBe('plain-demo');
    });
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
        expect(parseDemoSource(`${PUBLIC_ORIGIN}/do-image/control`, PUBLIC_ORIGIN)?.slug).toBe(
            'do-image'
        );
        expect(
            parseDemoSource('https://other.example/sustainability/control', PUBLIC_ORIGIN)
        ).toBeNull();
        expect(parseDemoSource(`${PUBLIC_ORIGIN}/api/private`, PUBLIC_ORIGIN)).toBeNull();
    });

    test('recognizes every currently running public demo slug', () => {
        for (const slug of [
            'bitcoin',
            'sustainability',
            'flyconnectome',
            'nightingale',
            'london-map',
            'ideafast',
            'do-image',
            'do-stroke-map-germany'
        ]) {
            expect(parseDemoSource(`${PUBLIC_ORIGIN}/${slug}/control`, PUBLIC_ORIGIN)?.slug).toBe(
                slug
            );
        }
    });

    test('keeps compiled asset and shared Nginx paths unchanged', () => {
        expect(isAllowedDemoPath('/sustainability/assets/index.js', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/network/network.html', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/pages/map.png', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/bus', 'sustainability')).toBe(true);
        expect(isAllowedDemoPath('/bitcoin/assets/index.js', 'sustainability')).toBe(false);
        expect(isAllowedDemoPath('/do-image/control', 'bitcoin')).toBe(false);
        expect(isAllowedDemoPath('/do-image/control', 'do-image')).toBe(true);
    });

    test('allows Nightingale companion paths only for the Nightingale demo', () => {
        expect(isAllowedDemoPath('/nightingale-wall/assets/logo.svg', 'nightingale')).toBe(true);
        expect(isAllowedDemoPath('/nightingale-screen', 'nightingale')).toBe(true);
        expect(isAllowedDemoPath('/nightingale-control/', 'nightingale')).toBe(true);
        expect(isAllowedDemoPath('/nightingale-wall/assets/logo.svg', 'bitcoin')).toBe(false);
        expect(isAllowedDemoPath('/nightingale-wallpaper', 'nightingale')).toBe(false);
    });

    test('allows IDEA-FAST observatory resources only for IDEA-FAST', () => {
        expect(isAllowedDemoPath('/observatory/src/main.js', 'ideafast')).toBe(true);
        expect(isAllowedDemoPath('/observatory/src/main.js', 'bitcoin')).toBe(false);
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
                '{"do-image":{"origin":"http://127.0.0.1:3011","assetsFromRoot":false}}'
            )?.has('do-image')
        ).toBe(true);
        expect(
            parseDirectDemoUpstreams(
                '{"sustainability":{"origin":"https://evil.example/path","assetsFromRoot":true}}'
            )
        ).toBeNull();
    });
});
