import { describe, expect, test } from 'bun:test';

import {
    consumeDemoLaunch,
    getDemoSession,
    issueDemoLaunch,
    issueDemoSession,
    revokeDemoSessionsForScope,
    revokeDemoSessionsForWall,
    type DemoGrant
} from '../../src/lib/demoGatewaySessions';

const grant: DemoGrant = {
    access: 'wall',
    wallId: 'wall-1',
    scopeId: 41,
    projectId: '69fb297952b72213cf9f59b8',
    kind: 'controller',
    slug: 'sustainability',
    entryPath: '/sustainability/control'
};

describe('demo gateway tickets and sessions', () => {
    test('consumes a launch ticket once and creates a separate session secret', () => {
        const launch = issueDemoLaunch(grant);
        expect(launch.expiresAt).toBeGreaterThan(Date.now());
        expect(consumeDemoLaunch(launch.ticket)).toEqual(grant);
        expect(consumeDemoLaunch(launch.ticket)).toBeNull();

        const session = issueDemoSession(grant);
        expect(session.token).not.toBe(launch.ticket);
        expect(getDemoSession(session.token)).toEqual(grant);
        expect(getDemoSession(launch.ticket)).toBeNull();
    });

    test('revokes both pending tickets and established sessions when a wall rebinds', () => {
        const launch = issueDemoLaunch(grant);
        const session = issueDemoSession(grant);
        revokeDemoSessionsForWall(grant.wallId);
        expect(consumeDemoLaunch(launch.ticket)).toBeNull();
        expect(getDemoSession(session.token)).toBeNull();
    });

    test('revokes credentials when their scope is cleaned up', () => {
        const launch = issueDemoLaunch(grant);
        const session = issueDemoSession(grant);
        revokeDemoSessionsForScope(grant.scopeId);
        expect(consumeDemoLaunch(launch.ticket)).toBeNull();
        expect(getDemoSession(session.token)).toBeNull();
    });

    test('admin preview stays valid without a wall and expires after fifteen minutes', () => {
        const preview: DemoGrant = {
            access: 'admin-preview',
            projectId: grant.projectId,
            kind: 'screen',
            slug: 'bitcoin',
            entryPath: '/bitcoin/'
        };
        const originalNow = Date.now;
        const startedAt = originalNow();
        try {
            Date.now = () => startedAt;
            const launch = issueDemoLaunch(preview);
            expect(consumeDemoLaunch(launch.ticket)).toEqual(preview);
            const session = issueDemoSession(preview);
            expect(session.expiresAt).toBe(startedAt + 15 * 60_000);

            revokeDemoSessionsForWall(grant.wallId);
            revokeDemoSessionsForScope(grant.scopeId);
            Date.now = () => startedAt + 14 * 60_000;
            expect(getDemoSession(session.token)).toEqual(preview);
            Date.now = () => startedAt + 15 * 60_000;
            expect(getDemoSession(session.token)).toBeNull();
        } finally {
            Date.now = originalNow;
        }
    });
});
