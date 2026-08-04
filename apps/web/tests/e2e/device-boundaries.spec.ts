import { expect, test, type Page } from 'playwright/test';

import {
    installDeviceIdentity,
    readHarnessManifest,
    waitForWallBusReady
} from '../support/harness';

type DeviceHandshakeOutcome =
    | 'accepted'
    | 'pending'
    | 'rejected'
    | 'server-assigned'
    | 'no-decision';

function observeDeviceHandshake(
    page: Page,
    safeAssignedWallId?: string
): Promise<DeviceHandshakeOutcome> {
    return new Promise((resolve) => {
        let settled = false;
        let ceiling: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: DeviceHandshakeOutcome) => {
            if (settled) return;
            settled = true;
            if (ceiling) clearTimeout(ceiling);
            resolve(outcome);
        };

        page.on('websocket', (socket) => {
            if (!new URL(socket.url()).pathname.endsWith('/bus')) return;
            socket.on('framereceived', ({ payload }) => {
                if (typeof payload !== 'string') return;
                try {
                    const message = JSON.parse(payload) as { type?: string; wallId?: string };
                    if (message.type === 'auth_denied') finish('rejected');
                    if (message.type === 'device_enrollment') finish('pending');
                    if (
                        message.type === 'wall_binding_status' &&
                        safeAssignedWallId &&
                        message.wallId === safeAssignedWallId
                    ) {
                        finish('server-assigned');
                    } else if (
                        message.type === 'wall_binding_status' ||
                        message.type === 'hydrate'
                    ) {
                        finish('accepted');
                    }
                } catch {
                    // Binary or non-protocol frames are irrelevant to the handshake decision.
                }
            });
            socket.on('close', () => finish('rejected'));
        });

        ceiling = setTimeout(() => finish('no-decision'), 10_000);
    });
}

test('a pending wall remains in the enrollment posture', async ({ context, page }) => {
    const manifest = readHarnessManifest();
    await installDeviceIdentity(context, {
        kind: 'wall',
        device: manifest.devices.dev_wall_pending,
        wallId: manifest.fixtures.wallId
    });

    await page.goto(`/wall?w=${manifest.fixtures.wallId}&c=0&r=0`);
    await waitForWallBusReady(page);

    await expect(page.getByText("This screen hasn't been registered yet")).toBeVisible();
    await expect(page.getByText('Visual harness', { exact: false })).toBeHidden();
});

test('a revoked wall device is rejected before runtime registration', async ({ context, page }) => {
    const manifest = readHarnessManifest();
    await installDeviceIdentity(context, {
        kind: 'wall',
        device: manifest.devices.dev_wall_revoked,
        wallId: manifest.fixtures.wallId
    });
    const outcome = observeDeviceHandshake(page);

    await page.goto(`/wall?w=${manifest.fixtures.wallId}&c=0&r=0`);

    const actual = await outcome;
    test.fail(
        actual !== 'rejected',
        'Known defect: completeHelloRegistration accepts existing devices whose status is revoked.'
    );
    expect(actual).toBe('rejected');
});

test('an enrolled controller cannot select a wall outside its server assignment', async ({
    context,
    page
}) => {
    const manifest = readHarnessManifest();
    await installDeviceIdentity(context, {
        kind: 'controller',
        device: manifest.devices.dev_controller_active,
        wallId: manifest.fixtures.controllerWallId
    });
    const outcome = observeDeviceHandshake(page, manifest.fixtures.galleryWallId);

    await page.goto(`/controller?w=${manifest.fixtures.controllerWallId}&c=0&r=0`);

    const actual = await outcome;
    const safelyScoped = actual === 'rejected' || actual === 'server-assigned';
    test.fail(
        !safelyScoped,
        'Known defect: controller registration trusts the requested wall instead of assignedWallId.'
    );
    expect(safelyScoped).toBe(true);
});
