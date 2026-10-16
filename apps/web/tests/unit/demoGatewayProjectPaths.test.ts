import { describe, expect, test } from 'bun:test';

import { parseDemoPathPolicy } from '../../src/lib/demoGatewayPaths';
import {
    buildProjectDemoLaunchUrl,
    parseDemoProjects as parseProjects,
    parseProjectDemoLaunchPath,
    parseProjectDemoPath,
    parseRoutedProjectDemoPath,
    projectDemoSessionBase,
    publicDemoPath as publicPath,
    resolveProjectDemoSource as resolveSource,
    upstreamDemoPath as upstreamPath
} from '../../src/lib/demoGatewayProjectPaths';

const id = '69fb297952b72213cf9f59b8';
const publicOrigin = 'https://vizzy.dsi.ic.ac.uk';
const sourceOrigin = 'https://vizzy-studio-demos.dsi.ic.ac.uk';
const policy = parseDemoPathPolicy(
    JSON.stringify({
        bitcoin: ['api', 'ws', 'bus', 'btc-globe'],
        sustainability: [],
        flyconnectome: [],
        nightingale: ['nightingale-wall', 'nightingale-screen', 'nightingale-control'],
        'london-map': [],
        ideafast: ['observatory'],
        'do-image': [],
        'do-stroke-map-germany': []
    })
)!;
const parseDemoProjects = (raw: string) => parseProjects(raw, policy);
const upstreamDemoPath = (path: string, slug: string) => upstreamPath(path, slug, policy);
const publicDemoPath = (id: string, path: string, slug: string, routeId?: string) =>
    publicPath(id, path, slug, policy, routeId);
const resolveProjectDemoSource = (
    url: string,
    projectId: string,
    publicOrigin: string,
    sourceOrigin: string,
    projects: Map<string, string>
) => resolveSource(url, projectId, publicOrigin, sourceOrigin, projects, policy);
const projects = parseDemoProjects(JSON.stringify({ [id]: { slug: 'bitcoin' } }))!;

describe('project path demo gateway', () => {
    test('keeps ticket, document and assets under the same project path', () => {
        const launch = buildProjectDemoLaunchUrl(publicOrigin, id, 'screen', 'ticket');
        expect(launch).toBe(`${publicOrigin}/demos/${id}/_launch/screen?ticket=ticket`);
        expect(parseProjectDemoLaunchPath(new URL(launch).pathname)).toEqual({
            projectId: id,
            kind: 'screen'
        });
        expect(parseProjectDemoPath(`/demos/${id}/assets/main.js`)).toEqual({
            projectId: id,
            resourcePath: '/assets/main.js'
        });
        expect(upstreamDemoPath('/screen', 'bitcoin')).toBe('/bitcoin/screen');
        expect(upstreamDemoPath('/assets/main.js', 'bitcoin')).toBe('/bitcoin/assets/main.js');
        expect(publicDemoPath(id, '/bitcoin/assets/main.js', 'bitcoin')).toBe(
            `/demos/${id}/assets/main.js`
        );
        const routeId = 'abcdefghijklmnopqrstuv';
        const base = projectDemoSessionBase(id, routeId);
        expect(parseRoutedProjectDemoPath(`${base}/assets/main.js`)).toEqual({
            projectId: id,
            routeId,
            resourcePath: '/assets/main.js'
        });
        expect(publicDemoPath(id, '/bitcoin/assets/main.js', 'bitcoin', routeId)).toBe(
            `${base}/assets/main.js`
        );
        expect(parseRoutedProjectDemoPath(`/demos/${id}/assets/main.js`)).toBeNull();
    });

    test('maps shared API and WebSocket paths without colliding with Vizzy API', () => {
        expect(upstreamDemoPath('/api/data', 'bitcoin')).toBe('/api/data');
        expect(upstreamDemoPath('/bus', 'bitcoin')).toBe('/bus');
        expect(upstreamDemoPath('/ws', 'bitcoin')).toBe('/ws');
        expect(publicDemoPath(id, '/api/data', 'bitcoin')).toBe(`/demos/${id}/api/data`);
        expect(upstreamDemoPath('/_launch/screen', 'bitcoin')).toBeNull();
    });

    test('resolves new stored project URL using an operator-owned slug map', () => {
        expect(
            resolveProjectDemoSource(
                `${publicOrigin}/demos/${id}/screen`,
                id,
                publicOrigin,
                sourceOrigin,
                projects
            )
        ).toEqual({ slug: 'bitcoin', entryPath: '/bitcoin/screen' });
        expect(
            resolveProjectDemoSource(
                `${sourceOrigin}/bitcoin/control?operator=A`,
                id,
                publicOrigin,
                sourceOrigin,
                projects
            )
        ).toEqual({ slug: 'bitcoin', entryPath: '/bitcoin/control?operator=A' });
        expect(
            resolveProjectDemoSource(
                `${publicOrigin}/demos/111111111111111111111111/screen`,
                id,
                publicOrigin,
                sourceOrigin,
                projects
            )
        ).toBeNull();
        expect(
            resolveProjectDemoSource(
                `${publicOrigin}/demos/${id}/s/abcdefghijklmnopqrstuv/screen`,
                id,
                publicOrigin,
                sourceOrigin,
                projects
            )
        ).toBeNull();
        expect(
            resolveProjectDemoSource(
                'https://evil.example/bitcoin/screen',
                id,
                publicOrigin,
                sourceOrigin,
                projects
            )
        ).toBeNull();
    });

    test('does not let one project request another demo alias', () => {
        expect(upstreamDemoPath('/nightingale-wall/logo.svg', 'bitcoin')).toBeNull();
        expect(publicDemoPath(id, '/nightingale-wall/logo.svg', 'bitcoin')).toBeNull();
        expect(parseDemoProjects(JSON.stringify({ [id]: { slug: 'api' } }))).toBeNull();
        expect(parseDemoProjects(JSON.stringify({ bad: { slug: 'bitcoin' } }))).toBeNull();
    });

    test('routes demo-specific root resources only to their owning demo', () => {
        expect(upstreamDemoPath('/observatory/src/main.js', 'ideafast')).toBe(
            '/observatory/src/main.js'
        );
        expect(upstreamDemoPath('/nightingale-screen', 'nightingale')).toBe('/nightingale-screen');
        expect(upstreamDemoPath('/nightingale-control', 'nightingale')).toBe(
            '/nightingale-control'
        );
        expect(upstreamDemoPath('/observatory/src/main.js', 'bitcoin')).toBeNull();
        expect(upstreamDemoPath('/nightingale-screen', 'bitcoin')).toBeNull();
    });

    test('accepts the currently running demo slugs as project mappings', () => {
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
            expect(parseDemoProjects(JSON.stringify({ [id]: { slug } }))?.get(id)).toBe(slug);
        }
    });
});
