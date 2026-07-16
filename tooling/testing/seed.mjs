import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ObjectId } from 'mongodb';

const DEFAULT_WEB_PORT = process.env.WEB_HOST_PORT ?? '3870';
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_WEB_PORT}`;
const DEFAULT_DB_URL =
    process.env.SERVER_DATABASE_URL ??
    'mongodb://localhost:37017/vizzy?replicaSet=rs0&directConnection=true';

function ensureEnvDefaults() {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    process.env.VITE_BASE_URL = process.env.VITE_BASE_URL || DEFAULT_BASE_URL;
    process.env.SERVER_DATABASE_URL = process.env.SERVER_DATABASE_URL || DEFAULT_DB_URL;
    process.env.SERVER_AUTH_SECRET =
        process.env.SERVER_AUTH_SECRET || '00000000000000000000000000000000';
    process.env.SERVER_CONFIG_ENCRYPTION_KEY =
        process.env.SERVER_CONFIG_ENCRYPTION_KEY || 'local-dev-encryption-key';
    process.env.ALLOWED_HOSTS = process.env.ALLOWED_HOSTS || process.env.VITE_BASE_URL;
    process.env.TRUSTED_ORIGINS = process.env.TRUSTED_ORIGINS || process.env.VITE_BASE_URL;
}

function toBase64Url(bytes) {
    return Buffer.from(bytes)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function toCookieHeader(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function toPlaywrightStorageState(baseUrl, cookies) {
    const host = new URL(baseUrl).hostname;
    return {
        cookies: cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || host,
            path: cookie.path || '/',
            expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
            httpOnly: Boolean(cookie.httpOnly),
            secure: Boolean(cookie.secure),
            sameSite: cookie.sameSite || 'Lax'
        })),
        origins: []
    };
}

async function createDeviceCryptoMaterial(deviceId) {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify'
    ]);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const signatureRaw = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        new TextEncoder().encode(deviceId)
    );

    return {
        publicKey: JSON.stringify(publicKeyJwk),
        privateKey: JSON.stringify(privateKeyJwk),
        signature: toBase64Url(new Uint8Array(signatureRaw))
    };
}

async function resetDatabase(db) {
    await db.dropDatabase();
}

async function createActor(testHelpers, input) {
    const user = await testHelpers.saveUser(
        testHelpers.createUser({
            id: input.id,
            email: input.email,
            name: input.name,
            role: input.role,
            emailVerified: true
        })
    );
    const login = await testHelpers.login({ userId: user.id });
    return {
        id: user.id,
        email: user.email,
        role: user.role ?? input.role,
        cookieHeader: toCookieHeader(login.cookies),
        cookies: login.cookies
    };
}

async function seed() {
    ensureEnvDefaults();

    // collections only exports Better Auth / jobs handles; app-owned collections use db directly.
    const [, { db }, { auth }] = await Promise.all([
        import('../../apps/web/src/server/collections.ts'),
        import('@repo/db'),
        import('@repo/auth/auth')
    ]);
    const authContext = await auth.$context;
    const testHelpers = authContext?.test;
    if (!testHelpers) {
        throw new Error(
            'Better Auth test helpers are unavailable. Ensure NODE_ENV=test and testUtils plugin is enabled.'
        );
    }

    await resetDatabase(db);

    const actors = {
        user_admin: await createActor(testHelpers, {
            id: 'usr_admin',
            email: 'admin@test.local',
            name: 'Admin Test',
            role: 'admin'
        }),
        user_editor: await createActor(testHelpers, {
            id: 'usr_editor',
            email: 'editor@test.local',
            name: 'Editor Test',
            role: 'user'
        }),
        user_viewer: await createActor(testHelpers, {
            id: 'usr_viewer',
            email: 'viewer@test.local',
            name: 'Viewer Test',
            role: 'user'
        })
    };

    const now = Date.now();
    const privateProjectId = new ObjectId('000000000000000000000101');
    const publicProjectId = new ObjectId('000000000000000000000102');
    const privateCommitId = new ObjectId('000000000000000000000201');
    const publicCommitId = new ObjectId('000000000000000000000202');

    await db.collection('projects').insertMany([
        {
            _id: privateProjectId,
            name: 'Harness Private Project',
            authorOrganisation: 'Harness Org',
            description: 'Seeded private project for security tests',
            tags: [],
            visibility: 'private',
            heroImages: [],
            collaborators: [
                { email: actors.user_editor.email, role: 'owner' },
                { email: actors.user_viewer.email, role: 'viewer' }
            ],
            headCommitId: privateCommitId,
            publishedCommitId: null,
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 1
        },
        {
            _id: publicProjectId,
            name: 'Harness Public Project',
            authorOrganisation: 'Harness Org',
            description: 'Seeded public project for access checks',
            tags: ['public'],
            visibility: 'public',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            headCommitId: publicCommitId,
            publishedCommitId: publicCommitId,
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 1
        }
    ]);

    await db.collection('commits').insertMany([
        {
            _id: privateCommitId,
            projectId: privateProjectId,
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness private head',
            content: { slides: [{ id: 'slide-private-1', order: 0, name: 'Slide 1', layers: [] }] },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 1
        },
        {
            _id: publicCommitId,
            projectId: publicProjectId,
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness public head',
            content: { slides: [{ id: 'slide-public-1', order: 0, name: 'Slide 1', layers: [] }] },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 1
        }
    ]);

    await db.collection('walls').insertOne({
        _id: new ObjectId('000000000000000000000301'),
        wallId: 'test-wall-1',
        name: 'Test Wall 1',
        connectedNodes: 0,
        lastSeen: now,
        boundProjectId: publicProjectId.toHexString(),
        boundCommitId: publicCommitId.toHexString(),
        boundSlideId: 'slide-public-1',
        boundSource: 'gallery',
        site: null,
        notes: null,
        createdAt: now,
        updatedAt: now,
        _version: 1
    });

    const deviceEntries = [
        {
            deviceId: 'dev_wall_active',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-1'
        },
        { deviceId: 'dev_wall_pending', kind: 'wall', status: 'pending', assignedWallId: null },
        {
            deviceId: 'dev_controller_active',
            kind: 'controller',
            status: 'active',
            assignedWallId: 'test-wall-1'
        },
        {
            deviceId: 'dev_gallery_active',
            kind: 'gallery',
            status: 'active',
            assignedWallId: 'test-wall-1'
        }
    ];

    const deviceManifest = {};
    for (const entry of deviceEntries) {
        const cryptoMaterial = await createDeviceCryptoMaterial(entry.deviceId);
        await db.collection('devices').insertOne({
            deviceId: entry.deviceId,
            publicKey: cryptoMaterial.publicKey,
            kind: entry.kind,
            status: entry.status,
            assignedWallId: entry.assignedWallId,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            _version: 1
        });
        deviceManifest[entry.deviceId] = {
            ...entry,
            signature: cryptoMaterial.signature,
            privateKey: cryptoMaterial.privateKey,
            publicKey: cryptoMaterial.publicKey
        };
    }

    const baseUrl = process.env.TEST_BASE_URL || process.env.VITE_BASE_URL || DEFAULT_BASE_URL;
    const manifest = {
        generatedAt: new Date().toISOString(),
        baseUrl,
        actors,
        fixtures: {
            wallId: 'test-wall-1',
            privateProjectId: privateProjectId.toHexString(),
            privateCommitId: privateCommitId.toHexString(),
            privateSlideId: 'slide-private-1',
            publicProjectId: publicProjectId.toHexString(),
            publicCommitId: publicCommitId.toHexString(),
            publicSlideId: 'slide-public-1'
        },
        devices: deviceManifest
    };

    const fixturePath = resolve('apps/web/tests/.fixtures/seed-manifest.json');
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const authDir = resolve('apps/web/tests/.auth');
    await mkdir(authDir, { recursive: true });
    await writeFile(
        resolve(authDir, 'user_admin.json'),
        `${JSON.stringify(toPlaywrightStorageState(baseUrl, actors.user_admin.cookies), null, 2)}\n`,
        'utf8'
    );
    await writeFile(
        resolve(authDir, 'user_editor.json'),
        `${JSON.stringify(toPlaywrightStorageState(baseUrl, actors.user_editor.cookies), null, 2)}\n`,
        'utf8'
    );
    await writeFile(
        resolve(authDir, 'user_viewer.json'),
        `${JSON.stringify(toPlaywrightStorageState(baseUrl, actors.user_viewer.cookies), null, 2)}\n`,
        'utf8'
    );

    console.log(`[test-harness] Seeded fixtures at ${fixturePath}`);
}

await seed();
process.exit(0);
