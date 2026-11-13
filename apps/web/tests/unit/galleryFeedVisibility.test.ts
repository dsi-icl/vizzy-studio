import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ProjectFixture = {
    id: string;
    name: string;
    visibility: 'public' | 'private';
    createdBy: string;
    collaborators: Array<{ email: string; role: string }>;
    stages: Array<{ id: string; publishedCommitId: string | null; archivedAt?: Date }>;
    heroImages: string[];
};

function project(overrides: Partial<ProjectFixture> = {}): ProjectFixture {
    return {
        id: 'project-1',
        name: 'Fixture',
        visibility: 'private',
        createdBy: 'owner@ic.ac.uk',
        collaborators: [{ email: 'owner@ic.ac.uk', role: 'owner' }],
        stages: [{ id: 'main', publishedCommitId: 'commit-1' }],
        heroImages: [],
        ...overrides
    };
}

/** Specifiers replaced in the bundled copy, with the named exports each one owes. */
const STUBBED_MODULES: Record<string, string[]> = {
    '@tanstack/react-start/server-only': [],
    '~/server/collections': ['dbCol', 'collections'],
    '@repo/db/config': ['getConfigValue'],
    '~/server/audit': ['logAuditSuccess'],
    '~/lib/busState': [
        'runCommitPersistenceTask',
        'scopedState',
        'updateProjectCustomRenderSettings',
        'updateRuntimeStageLayout'
    ],
    '~/lib/uploadTokens': ['revokeUploadToken', 'validateUploadToken'],
    '~/lib/scopePersistence': ['KeyedSerialQueue']
};

describe('listPublishedProjects', () => {
    let directory: string;
    let listPublishedProjects: (viewerEmail?: string | null) => Promise<ProjectFixture[]>;
    const find = mock(async (): Promise<ProjectFixture[]> => []);

    const store = {
        dbCol: {
            projects: { find },
            assets: { findBlurhashMetaByUrls: mock(async () => []) }
        },
        collections: {},
        getConfigValue: mock(async () => null),
        logAuditSuccess: mock(async () => undefined),
        runCommitPersistenceTask: mock(() => undefined),
        scopedState: new Map(),
        updateProjectCustomRenderSettings: mock(() => undefined),
        updateRuntimeStageLayout: mock(() => undefined),
        revokeUploadToken: mock(() => undefined),
        validateUploadToken: mock(() => null),
        KeyedSerialQueue: class {
            run<T>(_key: unknown, task: () => T) {
                return task();
            }
        }
    };

    async function visibleNames(viewerEmail: string | null): Promise<string[]> {
        const result = await listPublishedProjects(viewerEmail);
        return result.map((entry) => entry.name);
    }

    beforeAll(async () => {
        // Bundle an isolated copy whose database and runtime boundaries are fakes, so the
        // real visibility rule runs without a server, a socket or Mongo.
        directory = await mkdtemp(join(tmpdir(), 'vizzy-gallery-feed-'));
        const key = Symbol.for(directory);
        const specifiers = Object.keys(STUBBED_MODULES)
            .map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
            .join('|');

        const build = await Bun.build({
            entrypoints: [resolve(import.meta.dir, '../../src/server/projects.ts')],
            outdir: directory,
            naming: 'projects.mjs',
            target: 'bun',
            format: 'esm',
            tsconfig: resolve(import.meta.dir, '../../tsconfig.json'),
            plugins: [
                {
                    name: 'gallery-feed-test-store',
                    setup(builder) {
                        builder.onResolve(
                            { filter: new RegExp(`^(?:${specifiers})$`) },
                            (args) => ({
                                path: args.path,
                                namespace: 'gallery-feed-test'
                            })
                        );
                        builder.onLoad({ filter: /.*/, namespace: 'gallery-feed-test' }, (args) => {
                            const exported = STUBBED_MODULES[args.path] ?? [];
                            const contents = exported.length
                                ? `export const { ${exported.join(', ')} } = globalThis[Symbol.for(${JSON.stringify(directory)})];`
                                : 'export {};';
                            return { contents, loader: 'js' };
                        });
                    }
                }
            ]
        });
        if (!build.success) throw new AggregateError(build.logs, 'Gallery feed bundle failed');

        Reflect.set(globalThis, key, store);
        const bundled = (await import(join(directory, 'projects.mjs'))) as {
            listPublishedProjects: typeof listPublishedProjects;
        };
        listPublishedProjects = bundled.listPublishedProjects;
    });

    afterAll(async () => {
        Reflect.deleteProperty(globalThis, Symbol.for(directory));
        await rm(directory, { recursive: true, force: true });
    });

    test('public published projects reach anonymous viewers', async () => {
        find.mockResolvedValueOnce([
            project({ name: 'Public', visibility: 'public', createdBy: 'someone@ic.ac.uk' })
        ]);
        expect(await visibleNames(null)).toEqual(['Public']);
    });

    test('private published projects are withheld from anonymous viewers', async () => {
        find.mockResolvedValueOnce([project({ name: 'Private' })]);
        expect(await visibleNames(null)).toEqual([]);
    });

    test('a private published project reaches its creator and its collaborators', async () => {
        const fixture = project({
            name: 'Private',
            createdBy: 'owner@ic.ac.uk',
            collaborators: [
                { email: 'owner@ic.ac.uk', role: 'owner' },
                { email: 'editor@ic.ac.uk', role: 'editor' }
            ]
        });
        find.mockResolvedValueOnce([fixture]);
        expect(await visibleNames('owner@ic.ac.uk')).toEqual(['Private']);
        find.mockResolvedValueOnce([fixture]);
        expect(await visibleNames('editor@ic.ac.uk')).toEqual(['Private']);
    });

    test('a private published project is withheld from everyone else', async () => {
        find.mockResolvedValueOnce([project({ name: 'Private' })]);
        expect(await visibleNames('stranger@ic.ac.uk')).toEqual([]);
    });

    test('removing a collaborator removes the project from their feed', async () => {
        const withCollaborator = project({
            name: 'Private',
            createdBy: 'owner@ic.ac.uk',
            collaborators: [
                { email: 'owner@ic.ac.uk', role: 'owner' },
                { email: 'editor@ic.ac.uk', role: 'editor' }
            ]
        });
        find.mockResolvedValueOnce([withCollaborator]);
        expect(await visibleNames('editor@ic.ac.uk')).toEqual(['Private']);

        const withoutCollaborator = {
            ...withCollaborator,
            collaborators: [{ email: 'owner@ic.ac.uk', role: 'owner' }]
        };
        find.mockResolvedValueOnce([withoutCollaborator]);
        expect(await visibleNames('editor@ic.ac.uk')).toEqual([]);
        find.mockResolvedValueOnce([withoutCollaborator]);
        expect(await visibleNames('owner@ic.ac.uk')).toEqual(['Private']);
    });

    test('unpublished projects stay out of the feed for members and the public alike', async () => {
        const unpublished = project({
            name: 'Draft',
            stages: [{ id: 'main', publishedCommitId: null }]
        });
        find.mockResolvedValueOnce([unpublished]);
        expect(await visibleNames('owner@ic.ac.uk')).toEqual([]);
        find.mockResolvedValueOnce([{ ...unpublished, visibility: 'public' as const }]);
        expect(await visibleNames(null)).toEqual([]);
    });

    test('a published commit on an archived stage does not publish the project', async () => {
        find.mockResolvedValueOnce([
            project({
                name: 'Archived',
                visibility: 'public',
                stages: [{ id: 'main', publishedCommitId: 'commit-1', archivedAt: new Date() }]
            })
        ]);
        expect(await visibleNames(null)).toEqual([]);
    });

    test('a viewer sees public projects alongside their own private ones', async () => {
        find.mockResolvedValueOnce([
            project({ name: 'Public', visibility: 'public', createdBy: 'someone@ic.ac.uk' }),
            project({ name: 'Mine', collaborators: [{ email: 'me@ic.ac.uk', role: 'editor' }] }),
            project({ name: 'Theirs', collaborators: [{ email: 'them@ic.ac.uk', role: 'owner' }] })
        ]);
        expect(await visibleNames('me@ic.ac.uk')).toEqual(['Public', 'Mine']);
    });
});
