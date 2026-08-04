import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ObjectId } from 'mongodb';

const DEFAULT_WEB_PORT = process.env.WEB_HOST_PORT ?? '3870';
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_WEB_PORT}`;
const EXTERNAL_CAPTURE_URL =
    process.env.TEST_EXTERNAL_CAPTURE_URL ?? 'http://external-site:8080/capture';
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

async function markBootstrapComplete(db, now) {
    const updatedAt = new Date(now).toISOString();
    await db.collection('config').insertMany([
        {
            key: 'bootstrap.phase',
            value: 'completed',
            encrypted: false,
            updatedAt,
            updatedBy: 'test-harness',
            version: 1
        },
        {
            key: 'bootstrap.completedAt',
            value: updatedAt,
            encrypted: false,
            updatedAt,
            updatedBy: 'test-harness',
            version: 1
        }
    ]);
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
    // The seed process runs in test mode so Better Auth exposes its helpers, while
    // the harness server intentionally runs in production mode. Mirror the
    // production cookie name/attributes without changing the signed token.
    const cookies = login.cookies.map((cookie) => ({
        ...cookie,
        name: cookie.name.startsWith('__Secure-') ? cookie.name : `__Secure-${cookie.name}`,
        secure: true
    }));
    return {
        id: user.id,
        email: user.email,
        role: user.role ?? input.role,
        cookieHeader: toCookieHeader(cookies),
        cookies
    };
}

const HARNESS_IMAGE_DATA_URL = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0ea5e9"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect width="600" height="300" rx="36" fill="url(#background)"/>
  <circle cx="92" cy="92" r="42" fill="#f8fafc" fill-opacity=".92"/>
  <path d="M72 92h40M92 72v40" stroke="#0369a1" stroke-width="12" stroke-linecap="round"/>
  <text x="54" y="205" fill="#f8fafc" font-family="Arial, sans-serif" font-size="42" font-weight="700">VIZZY</text>
  <text x="54" y="250" fill="#e0f2fe" font-family="Arial, sans-serif" font-size="25">deterministic render fixture</text>
</svg>
`)}`;

function layerConfig(cx, cy, width, height, zIndex, extra = {}) {
    return {
        cx,
        cy,
        width,
        height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex,
        visible: true,
        ...extra
    };
}

function createMainStage(headCommitId, publishedCommitId = null) {
    return {
        id: 'main',
        name: 'Main',
        order: 0,
        layout: {
            columns: 16,
            rows: 4,
            screenWidth: 1920,
            screenHeight: 1080
        },
        headCommitId,
        publishedCommitId
    };
}

function createToolbarTextLayers() {
    return [
        {
            numericId: 1,
            type: 'text',
            config: layerConfig(960, 540, 960, 240, 1),
            textHtml: '<p>Harness focus text</p>'
        }
    ];
}

function createRenderingLayers() {
    return [
        {
            numericId: 1,
            type: 'background',
            config: layerConfig(640, 360, 1280, 720, 0),
            backgroundType: 'solid',
            backgroundColor: '#081426',
            atmosphereColor: '#16213e',
            motifColor1: '#0ea5e9',
            motifColor2: '#7c3aed',
            noiseSeed: 42,
            speedFactor: 0
        },
        {
            numericId: 2,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(235, 180, 310, 190, 1, { rotation: -6 }),
            fill: '#0f766e',
            strokeColor: '#5eead4',
            strokeDash: [],
            strokeWidth: 8
        },
        {
            numericId: 3,
            type: 'shape',
            shape: 'circle',
            config: layerConfig(585, 178, 168, 168, 2),
            fill: '#f59e0b',
            strokeColor: '#fef3c7',
            strokeDash: [14, 8],
            strokeWidth: 7
        },
        {
            numericId: 4,
            type: 'line',
            config: layerConfig(640, 318, 980, 120, 3),
            line: [150, 335, 360, 285, 560, 345, 790, 275, 1110, 330],
            strokeColor: '#38bdf8',
            strokeDash: [22, 12],
            strokeWidth: 12
        },
        {
            numericId: 5,
            type: 'text',
            config: layerConfig(510, 500, 760, 180, 4, { rotation: 1 }),
            textHtml:
                '<p style="font-size:2.1em;line-height:1.05;color:#f8fafc;text-align:center"><strong>Visual harness</strong></p><p style="font-size:1em;color:#bae6fd;text-align:center">text · shape · image · line</p>',
            textRevision: 1
        },
        {
            numericId: 6,
            type: 'image',
            config: layerConfig(1040, 535, 330, 165, 5, {
                rotation: 5,
                filters: {
                    enabled: true,
                    grayscale: false,
                    invert: false,
                    brightness: 105,
                    contrast: 105,
                    hueRotate: 0,
                    saturation: 110,
                    blur: 0
                }
            }),
            url: HARNESS_IMAGE_DATA_URL
        },
        {
            numericId: 7,
            type: 'web',
            config: layerConfig(1060, 168, 300, 120, 6),
            url: '',
            proxy: false,
            scale: 1
        }
    ];
}

function createEditorWorkflowLayers() {
    return [
        {
            numericId: 1,
            type: 'background',
            config: layerConfig(640, 360, 1280, 720, 0),
            backgroundType: 'solid',
            backgroundColor: '#111827',
            atmosphereColor: '#111827',
            motifColor1: '#111827',
            motifColor2: '#111827',
            noiseSeed: 7,
            speedFactor: 0
        },
        {
            numericId: 2,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(360, 360, 300, 220, 1),
            fill: '#2563eb',
            strokeColor: '#bfdbfe',
            strokeDash: [],
            strokeWidth: 8
        },
        {
            numericId: 3,
            type: 'text',
            config: layerConfig(800, 360, 500, 180, 2),
            textHtml:
                '<p style="font-size:1.8em;color:#f8fafc;text-align:center"><strong>Editable harness layer</strong></p>',
            textRevision: 1
        }
    ];
}

function createWebCaptureLayers() {
    return [
        {
            numericId: 1,
            type: 'background',
            config: layerConfig(640, 360, 1280, 720, 0),
            backgroundType: 'solid',
            backgroundColor: '#111827',
            atmosphereColor: '#111827',
            motifColor1: '#111827',
            motifColor2: '#111827',
            noiseSeed: 31,
            speedFactor: 0
        },
        {
            numericId: 2,
            type: 'web',
            config: layerConfig(640, 360, 640, 360, 1),
            url: EXTERNAL_CAPTURE_URL,
            proxy: false,
            scale: 1
        }
    ];
}

function createGalleryAlternateLayers() {
    return [
        {
            numericId: 1,
            type: 'background',
            config: layerConfig(640, 360, 1280, 720, 0),
            backgroundType: 'solid',
            backgroundColor: '#172554',
            atmosphereColor: '#172554',
            motifColor1: '#172554',
            motifColor2: '#172554',
            noiseSeed: 11,
            speedFactor: 0
        },
        {
            numericId: 2,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(640, 360, 920, 360, 1, { rotation: -2 }),
            fill: '#1d4ed8',
            strokeColor: '#93c5fd',
            strokeDash: [],
            strokeWidth: 10
        },
        {
            numericId: 3,
            type: 'text',
            config: layerConfig(640, 360, 820, 180, 2),
            textHtml:
                '<p style="font-size:2.2em;color:#eff6ff;text-align:center"><strong>Gallery alternate</strong></p>',
            textRevision: 1
        }
    ];
}

function createMultiWallLayers() {
    return [
        {
            numericId: 1,
            type: 'background',
            config: layerConfig(1920, 1080, 3840, 2160, 0),
            backgroundType: 'solid',
            backgroundColor: '#020617',
            atmosphereColor: '#020617',
            motifColor1: '#020617',
            motifColor2: '#020617',
            noiseSeed: 23,
            speedFactor: 0
        },
        {
            numericId: 2,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(1920, 270, 560, 360, 1),
            fill: '#e11d48',
            strokeColor: '#fecdd3',
            strokeDash: [],
            strokeWidth: 8
        },
        {
            numericId: 3,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(960, 1080, 560, 400, 2),
            fill: '#16a34a',
            strokeColor: '#bbf7d0',
            strokeDash: [18, 10],
            strokeWidth: 8
        },
        {
            numericId: 4,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(1920, 1080, 720, 520, 3),
            fill: '#2563eb',
            strokeColor: '#bfdbfe',
            strokeDash: [],
            strokeWidth: 10
        },
        {
            numericId: 5,
            type: 'shape',
            shape: 'rectangle',
            config: layerConfig(1920, 1080, 360, 260, 4, { rotation: 8 }),
            fill: '#facc15',
            strokeColor: '#fef9c3',
            strokeDash: [],
            strokeWidth: 8
        },
        {
            numericId: 6,
            type: 'text',
            config: layerConfig(1920, 1755, 1120, 180, 5),
            textHtml:
                '<p style="font-size:1.6em;color:#f8fafc;text-align:center"><strong>VERTICAL SEAM</strong></p>',
            textRevision: 1
        },
        {
            numericId: 7,
            type: 'image',
            config: layerConfig(2880, 540, 600, 360, 6),
            url: HARNESS_IMAGE_DATA_URL
        },
        {
            numericId: 8,
            type: 'web',
            config: layerConfig(510, 1635, 520, 220, 7),
            url: '',
            proxy: false,
            scale: 1
        },
        {
            numericId: 9,
            type: 'line',
            config: layerConfig(1920, 1080, 3360, 1680, 8),
            line: [240, 240, 3600, 1920],
            strokeColor: '#38bdf8',
            strokeDash: [20, 12],
            strokeWidth: 14
        },
        {
            numericId: 10,
            type: 'text',
            config: layerConfig(450, 170, 760, 180, 9),
            textHtml: '<p style="font-size:0.8em;color:#f8fafc"><strong>GRID TOP LEFT</strong></p>',
            textRevision: 1
        },
        {
            numericId: 11,
            type: 'text',
            config: layerConfig(3390, 170, 760, 180, 9),
            textHtml:
                '<p style="font-size:0.8em;color:#f8fafc"><strong>GRID TOP RIGHT</strong></p>',
            textRevision: 1
        },
        {
            numericId: 12,
            type: 'text',
            config: layerConfig(450, 1990, 760, 180, 9),
            textHtml:
                '<p style="font-size:0.8em;color:#f8fafc"><strong>GRID BOTTOM LEFT</strong></p>',
            textRevision: 1
        },
        {
            numericId: 13,
            type: 'text',
            config: layerConfig(3390, 1990, 760, 180, 9),
            textHtml:
                '<p style="font-size:0.8em;color:#f8fafc"><strong>GRID BOTTOM RIGHT</strong></p>',
            textRevision: 1
        }
    ];
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
    await markBootstrapComplete(db, now);
    const privateProjectId = new ObjectId('000000000000000000000101');
    const publicProjectId = new ObjectId('000000000000000000000102');
    const renderingProjectId = new ObjectId('000000000000000000000103');
    const editorProjectId = new ObjectId('000000000000000000000104');
    const multiWallProjectId = new ObjectId('000000000000000000000105');
    const convergenceProjectId = new ObjectId('000000000000000000000106');
    const webCaptureProjectId = new ObjectId('000000000000000000000107');
    const mediaProjectId = new ObjectId('000000000000000000000108');
    const interactionProjectId = new ObjectId('000000000000000000000109');
    const customRenderProjectId = new ObjectId('000000000000000000000110');
    const galleryAlpha2ProjectId = new ObjectId('000000000000000000000111');
    const galleryAlpha10ProjectId = new ObjectId('000000000000000000000112');
    const privateCommitId = new ObjectId('000000000000000000000201');
    const publicCommitId = new ObjectId('000000000000000000000202');
    const renderingCommitId = new ObjectId('000000000000000000000203');
    const editorCommitId = new ObjectId('000000000000000000000204');
    const multiWallCommitId = new ObjectId('000000000000000000000205');
    const convergenceCommitId = new ObjectId('000000000000000000000206');
    const webCaptureCommitId = new ObjectId('000000000000000000000207');
    const mediaCommitId = new ObjectId('000000000000000000000208');
    const interactionCommitId = new ObjectId('000000000000000000000209');
    const customRenderCommitId = new ObjectId('000000000000000000000210');
    const galleryAlpha2CommitId = new ObjectId('000000000000000000000211');
    const galleryAlpha10CommitId = new ObjectId('000000000000000000000212');

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
            defaultStageId: 'main',
            stages: [
                {
                    id: 'main',
                    name: 'Main',
                    order: 0,
                    layout: {
                        columns: 3,
                        rows: 2,
                        screenWidth: 1280,
                        screenHeight: 1024
                    },
                    headCommitId: privateCommitId,
                    publishedCommitId: null
                }
            ],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: publicProjectId,
            name: 'Harness Public Project',
            authorOrganisation: 'Harness Org',
            description: 'Seeded public project for access checks',
            tags: ['public', 'order-regression'],
            visibility: 'public',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [
                {
                    id: 'main',
                    name: 'Main',
                    order: 0,
                    layout: {
                        columns: 16,
                        rows: 4,
                        screenWidth: 1920,
                        screenHeight: 1080
                    },
                    headCommitId: publicCommitId,
                    publishedCommitId: publicCommitId
                }
            ],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: renderingProjectId,
            name: 'Harness Rendering Project',
            authorOrganisation: 'Harness Org',
            description: 'Deterministic visual rendering fixture',
            tags: ['harness', 'rendering'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(renderingCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: editorProjectId,
            name: 'Harness Editor Project',
            authorOrganisation: 'Harness Org',
            description: 'Mutable fixture reserved for editor interaction tests',
            tags: ['harness', 'editor'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(editorCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: multiWallProjectId,
            name: 'Harness Multi-Wall Project',
            authorOrganisation: 'Harness Org',
            description: 'Deterministic 2x2 seam, overlap, and component fixture',
            tags: ['harness', 'multi-wall'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(multiWallCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: convergenceProjectId,
            name: 'Harness Convergence Project',
            authorOrganisation: 'Harness Org',
            description: 'Fixture reserved for two-editor convergence tests',
            tags: ['harness', 'convergence'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(convergenceCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: webCaptureProjectId,
            name: 'Harness Web Capture Project',
            authorOrganisation: 'Harness Org',
            description: 'Fixture reserved for deterministic external-page capture tests',
            tags: ['harness', 'web-capture'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(webCaptureCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: mediaProjectId,
            name: 'Harness Media Project',
            authorOrganisation: 'Harness Org',
            description: 'Mutable fixture reserved for deterministic media upload tests',
            tags: ['harness', 'media'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(mediaCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: interactionProjectId,
            name: 'Harness Interaction Project',
            authorOrganisation: 'Harness Org',
            description: 'Mutable fixture reserved for canvas and keyboard interaction tests',
            tags: ['harness', 'interaction'],
            visibility: 'private',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(interactionCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: customRenderProjectId,
            name: 'Harness Custom Render Project',
            authorOrganisation: 'Harness Org',
            description: 'Fixture for custom-render navigation and asset management',
            tags: ['harness', 'custom-render'],
            visibility: 'private',
            heroImages: [],
            customRenderUrl: 'https://render.example.test/display',
            customRenderCompat: false,
            customRenderProxy: false,
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(customRenderCommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: galleryAlpha2ProjectId,
            name: 'Gallery Alpha 2',
            authorOrganisation: 'Harness Org',
            description: 'Published fixture for numeric gallery ordering',
            tags: ['order-regression'],
            visibility: 'public',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(galleryAlpha2CommitId, galleryAlpha2CommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: galleryAlpha10ProjectId,
            name: 'gallery alpha 10',
            authorOrganisation: 'Harness Org',
            description: 'Published fixture for case-insensitive gallery ordering',
            tags: ['order-regression'],
            visibility: 'public',
            heroImages: [],
            collaborators: [{ email: actors.user_editor.email, role: 'owner' }],
            defaultStageId: 'main',
            stages: [createMainStage(galleryAlpha10CommitId, galleryAlpha10CommitId)],
            createdBy: actors.user_editor.email,
            createdAt: now,
            updatedAt: now,
            _version: 2
        }
    ]);

    await db.collection('commits').insertMany([
        {
            _id: privateCommitId,
            projectId: privateProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness private head',
            content: {
                slides: [
                    {
                        id: 'slide-private-1',
                        order: 0,
                        name: 'Slide 1',
                        layers: createToolbarTextLayers()
                    },
                    {
                        id: 'slide-toolbar-primary',
                        order: 1,
                        name: 'Toolbar inputs primary',
                        layers: createToolbarTextLayers()
                    },
                    {
                        id: 'slide-toolbar-retry',
                        order: 2,
                        name: 'Toolbar inputs retry',
                        layers: createToolbarTextLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: publicCommitId,
            projectId: publicProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness public head',
            content: {
                slides: [
                    {
                        id: 'slide-public-1',
                        order: 0,
                        name: 'Rendering baseline',
                        layers: createRenderingLayers()
                    },
                    {
                        id: 'slide-public-2',
                        order: 1,
                        name: 'Alternate',
                        layers: createGalleryAlternateLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: renderingCommitId,
            projectId: renderingProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness rendering head',
            content: {
                slides: [
                    {
                        id: 'slide-rendering-1',
                        order: 0,
                        name: 'Canonical rendering scene',
                        layers: createRenderingLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: editorCommitId,
            projectId: editorProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness editor head',
            content: {
                slides: [
                    {
                        id: 'slide-editor-1',
                        order: 0,
                        name: 'Editor workflow',
                        layers: createEditorWorkflowLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: multiWallCommitId,
            projectId: multiWallProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness multi-wall head',
            content: {
                slides: [
                    {
                        id: 'slide-multi-wall-1',
                        order: 0,
                        name: 'Multi-wall calibration',
                        layers: createMultiWallLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: convergenceCommitId,
            projectId: convergenceProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness convergence head',
            content: {
                slides: [
                    {
                        id: 'slide-convergence-1',
                        order: 0,
                        name: 'Convergence workflow',
                        layers: createEditorWorkflowLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: webCaptureCommitId,
            projectId: webCaptureProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness web capture head',
            content: {
                slides: [
                    {
                        id: 'slide-web-capture-1',
                        order: 0,
                        name: 'External capture workflow',
                        layers: createWebCaptureLayers()
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: mediaCommitId,
            projectId: mediaProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness media head',
            content: {
                slides: [
                    {
                        id: 'slide-media-1',
                        order: 0,
                        name: 'Media workflow',
                        layers: []
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: interactionCommitId,
            projectId: interactionProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness interaction head',
            content: {
                slides: [
                    {
                        id: 'slide-interaction-1',
                        order: 0,
                        name: 'Interaction workflow',
                        layers: [
                            {
                                numericId: 1,
                                type: 'background',
                                config: layerConfig(640, 360, 1280, 720, 0),
                                backgroundType: 'solid',
                                backgroundColor: '#111827',
                                atmosphereColor: '#111827',
                                motifColor1: '#111827',
                                motifColor2: '#111827',
                                noiseSeed: 17,
                                speedFactor: 0
                            },
                            {
                                numericId: 2,
                                type: 'shape',
                                shape: 'rectangle',
                                config: layerConfig(360, 360, 300, 220, 1),
                                fill: '#2563eb',
                                strokeColor: '#bfdbfe',
                                strokeDash: [],
                                strokeWidth: 8
                            },
                            {
                                numericId: 3,
                                type: 'text',
                                config: layerConfig(850, 360, 420, 180, 2),
                                textHtml:
                                    '<p style="font-size:1.8em;color:#f8fafc;text-align:center"><strong>Line one<br>Line two</strong></p>',
                                textRevision: 1
                            }
                        ]
                    }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: customRenderCommitId,
            projectId: customRenderProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Harness custom render head',
            content: {
                slides: [
                    { id: 'slide-custom-render-1', order: 0, name: 'Custom render', layers: [] }
                ]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: galleryAlpha2CommitId,
            projectId: galleryAlpha2ProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Gallery alpha 2 published head',
            content: {
                slides: [{ id: 'slide-gallery-alpha-2', order: 0, name: 'Published', layers: [] }]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        },
        {
            _id: galleryAlpha10CommitId,
            projectId: galleryAlpha10ProjectId,
            stageId: 'main',
            parentId: null,
            authorId: new ObjectId(),
            message: 'Gallery alpha 10 published head',
            content: {
                slides: [{ id: 'slide-gallery-alpha-10', order: 0, name: 'Published', layers: [] }]
            },
            isAutoSave: false,
            isMutableHead: true,
            createdAt: now,
            _version: 3
        }
    ]);

    const singlePanelLayout = {
        columns: 1,
        rows: 1,
        screenWidth: 1280,
        screenHeight: 720,
        configuredAt: now,
        configuredBy: actors.user_admin.email
    };
    const multiPanelLayout = {
        columns: 2,
        rows: 2,
        screenWidth: 640,
        screenHeight: 360,
        configuredAt: now,
        configuredBy: actors.user_admin.email
    };

    await db.collection('walls').insertMany([
        {
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
            _version: 2
        },
        {
            _id: new ObjectId('000000000000000000000302'),
            wallId: 'test-wall-grid',
            name: 'Test Grid Wall',
            connectedNodes: 0,
            lastSeen: now,
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null,
            layoutTemplate: multiPanelLayout,
            site: 'Harness Lab',
            notes: '2x2 wall reserved for deterministic seam tests',
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: new ObjectId('000000000000000000000303'),
            wallId: 'test-wall-gallery',
            name: 'Test Gallery Wall',
            connectedNodes: 0,
            lastSeen: now,
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null,
            layoutTemplate: singlePanelLayout,
            site: 'Harness Gallery',
            notes: 'Wall reserved for gallery and controller convergence tests',
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: new ObjectId('000000000000000000000305'),
            wallId: 'test-wall-controller',
            name: 'Test Controller Wall',
            connectedNodes: 0,
            lastSeen: now,
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null,
            layoutTemplate: singlePanelLayout,
            site: 'Harness Controller',
            notes: 'Wall reserved for deterministic controller rendering tests',
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: new ObjectId('000000000000000000000306'),
            wallId: 'test-wall-ownership',
            name: 'Test Ownership Wall',
            connectedNodes: 0,
            lastSeen: now,
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null,
            layoutTemplate: singlePanelLayout,
            site: 'Harness Ownership',
            notes: 'Wall reserved for editor ownership and handoff tests',
            createdAt: now,
            updatedAt: now,
            _version: 2
        },
        {
            _id: new ObjectId('000000000000000000000307'),
            wallId: 'test-wall-media',
            name: 'Test Media Wall',
            connectedNodes: 0,
            lastSeen: now,
            boundProjectId: null,
            boundCommitId: null,
            boundSlideId: null,
            boundSource: null,
            layoutTemplate: singlePanelLayout,
            site: 'Harness Media',
            notes: 'Wall reserved for deterministic media readiness tests',
            createdAt: now,
            updatedAt: now,
            _version: 2
        }
    ]);

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
            assignedWallId: 'test-wall-gallery'
        },
        {
            deviceId: 'dev_gallery_active',
            kind: 'gallery',
            status: 'active',
            assignedWallId: 'test-wall-gallery'
        },
        {
            deviceId: 'dev_wall_grid_00',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-grid'
        },
        {
            deviceId: 'dev_wall_grid_10',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-grid'
        },
        {
            deviceId: 'dev_wall_grid_01',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-grid'
        },
        {
            deviceId: 'dev_wall_grid_11',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-grid'
        },
        {
            deviceId: 'dev_wall_gallery',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-gallery'
        },
        {
            deviceId: 'dev_wall_controller',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-controller'
        },
        {
            deviceId: 'dev_controller_visual',
            kind: 'controller',
            status: 'active',
            assignedWallId: 'test-wall-controller'
        },
        {
            deviceId: 'dev_gallery_controller',
            kind: 'gallery',
            status: 'active',
            assignedWallId: 'test-wall-controller'
        },
        {
            deviceId: 'dev_wall_revoked',
            kind: 'wall',
            status: 'revoked',
            assignedWallId: 'test-wall-1'
        },
        {
            deviceId: 'dev_wall_ownership',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-ownership'
        },
        {
            deviceId: 'dev_controller_ownership',
            kind: 'controller',
            status: 'active',
            assignedWallId: 'test-wall-ownership'
        },
        {
            deviceId: 'dev_gallery_ownership',
            kind: 'gallery',
            status: 'active',
            assignedWallId: 'test-wall-ownership'
        },
        {
            deviceId: 'dev_wall_media',
            kind: 'wall',
            status: 'active',
            assignedWallId: 'test-wall-media'
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
            toolbarProjectId: privateProjectId.toHexString(),
            toolbarCommitId: privateCommitId.toHexString(),
            toolbarSlideIds: ['slide-toolbar-primary', 'slide-toolbar-retry'],
            publicProjectId: publicProjectId.toHexString(),
            publicCommitId: publicCommitId.toHexString(),
            publicSlideId: 'slide-public-1',
            renderingProjectId: renderingProjectId.toHexString(),
            renderingCommitId: renderingCommitId.toHexString(),
            renderingSlideId: 'slide-rendering-1',
            editorProjectId: editorProjectId.toHexString(),
            editorCommitId: editorCommitId.toHexString(),
            editorSlideId: 'slide-editor-1',
            convergenceProjectId: convergenceProjectId.toHexString(),
            convergenceCommitId: convergenceCommitId.toHexString(),
            convergenceSlideId: 'slide-convergence-1',
            webCaptureProjectId: webCaptureProjectId.toHexString(),
            webCaptureCommitId: webCaptureCommitId.toHexString(),
            webCaptureSlideId: 'slide-web-capture-1',
            externalCaptureUrl: EXTERNAL_CAPTURE_URL,
            mediaProjectId: mediaProjectId.toHexString(),
            mediaCommitId: mediaCommitId.toHexString(),
            mediaSlideId: 'slide-media-1',
            interactionProjectId: interactionProjectId.toHexString(),
            interactionCommitId: interactionCommitId.toHexString(),
            interactionSlideId: 'slide-interaction-1',
            customRenderProjectId: customRenderProjectId.toHexString(),
            multiWallId: 'test-wall-grid',
            multiWallProjectId: multiWallProjectId.toHexString(),
            multiWallCommitId: multiWallCommitId.toHexString(),
            multiWallSlideId: 'slide-multi-wall-1',
            galleryWallId: 'test-wall-gallery',
            galleryAlternateSlideId: 'slide-public-2',
            controllerWallId: 'test-wall-controller',
            ownershipWallId: 'test-wall-ownership',
            mediaWallId: 'test-wall-media'
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
