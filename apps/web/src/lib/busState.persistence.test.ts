import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { CommitsCollection } from '@repo/db/collections';
import { DEFAULT_STAGE_LAYOUT } from '@repo/db/schema';
import { BSON, ObjectId, type Db, type Document } from 'mongodb';

import { markScopeDirty } from './scopePersistence';
import type { Layer, ScopeState } from './types';

// Exercise the real commit collection against an in-memory MongoDB boundary.
// BSON round trips keep reads/writes independent, just as they are in the DB.
const documents = new Map<string, Document>();
const clone = (document: Document) => BSON.deserialize(BSON.serialize(document));
const raw = {
    async findOne(filter: { _id: ObjectId }) {
        const document = documents.get(filter._id.toHexString());
        return document ? clone(document) : null;
    },
    async insertOne(document: Document) {
        documents.set(document._id.toHexString(), clone(document));
        return { insertedId: document._id };
    },
    async updateOne(filter: { _id: ObjectId }, update: { $set: Document }) {
        const document = documents.get(filter._id.toHexString());
        if (!document) return { matchedCount: 0 };
        for (const [path, value] of Object.entries(clone(update.$set))) {
            const keys = path.split('.');
            let target = document;
            for (const key of keys.slice(0, -1)) target = target[key];
            target[keys[keys.length - 1]] = value;
        }
        return { matchedCount: 1 };
    },
    async findOneAndUpdate(filter: { _id: ObjectId }, update: { $set: Document }) {
        await this.updateOne(filter, update);
        return this.findOne(filter);
    }
};
const commits = new CommitsCollection({ collection: () => raw } as unknown as Db);
mock.module('~/server/collections', () => ({ dbCol: { commits } }));

const { saveScope, seedScopeFromDb } = await import('./busState.persistence');
const { scopedState } = await import('./busState.state');

const SCOPE_ID = 9001;
const PROJECT_ID = new ObjectId().toHexString();
const MAP: Extract<Layer, { type: 'map' }> = {
    numericId: 3,
    type: 'map',
    config: {
        cx: 640,
        cy: 360,
        width: 800,
        height: 450,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 3,
        visible: true
    },
    style: 'protomaps-light',
    view: { longitude: -0.017, latitude: 51.4904999, zoom: 14, pitch: 0, bearing: 0 }
};
const EDITED_MAP: typeof MAP = {
    ...MAP,
    config: { ...MAP.config, cx: 920, cy: 540 },
    style: 'protomaps-dark',
    view: { longitude: 2.3522, latitude: 48.8566, zoom: 16, pitch: 60, bearing: 45 }
};

let headId: string;
let scope: ScopeState;

beforeEach(async () => {
    documents.clear();
    const head = await commits.insert({
        projectId: PROJECT_ID,
        stageId: 'main',
        parentId: null,
        authorEmail: null,
        message: 'Working copy',
        isAutoSave: true,
        isMutableHead: true,
        content: {
            slides: [
                { id: 'map-slide', order: 0, name: 'Map', layers: [MAP] },
                { id: 'other-slide', order: 1, name: 'Other', layers: [] }
            ]
        }
    });
    headId = head.id;
    scope = {
        projectId: PROJECT_ID,
        commitId: headId,
        slideId: 'map-slide',
        layout: DEFAULT_STAGE_LAYOUT,
        layers: new Map([[MAP.numericId, structuredClone(EDITED_MAP)]]),
        dirty: true,
        mutationRevision: 1,
        hydrateCache: null
    };
    scopedState.set(SCOPE_ID, scope);
});

afterEach(() => {
    scopedState.delete(SCOPE_ID);
    mock.restore();
});

describe('map save and reload', () => {
    test('manual save persists the camera, position and style to the snapshot and working copy', async () => {
        const result = await saveScope(SCOPE_ID, 'Map view', false, 'editor@example.test');
        expect(result.success).toBe(true);
        expect(result.commitId).toBeDefined();
        const snapshot = await commits.findById(result.commitId!);
        const head = await commits.findById(headId);
        expect(snapshot?.content.slides[0].layers).toEqual([EDITED_MAP]);
        expect(head?.content.slides).toEqual(snapshot?.content.slides);
        expect(head?.parentId).toBe(snapshot?.id);
        expect(head?.isMutableHead).toBe(true);
        expect(snapshot?.isMutableHead).toBe(false);
        expect(snapshot?.authorEmail).toBe('editor@example.test');
        expect(head?.content.slides[1]).toEqual({
            id: 'other-slide',
            order: 1,
            name: 'Other',
            layers: []
        });
        expect(scope.dirty).toBe(false);

        // Drop live state so a refresh/reconnect must read the saved working copy.
        scope.layers.clear();
        expect(await seedScopeFromDb(SCOPE_ID)).toBe(true);
        expect(scope.layers.get(MAP.numericId)).toEqual(EDITED_MAP);
    });

    test('autosave also preserves the edited map after live state is discarded', async () => {
        expect((await saveScope(SCOPE_ID, 'Auto-save', true)).success).toBe(true);
        scope.layers.clear();
        await seedScopeFromDb(SCOPE_ID);
        expect(scope.layers.get(MAP.numericId)).toEqual(EDITED_MAP);
        expect(documents.size).toBe(1);
    });

    test('successive saves keep earlier snapshots immutable and reload the newest map', async () => {
        const first = await saveScope(SCOPE_ID, 'First map view', false);
        const nextMap = { ...EDITED_MAP, view: { ...EDITED_MAP.view, zoom: 18 } };
        scope.layers.set(MAP.numericId, nextMap);
        markScopeDirty(scope);
        const second = await saveScope(SCOPE_ID, 'Second map view', false);

        const firstSnapshot = await commits.findById(first.commitId!);
        const secondSnapshot = await commits.findById(second.commitId!);
        expect(firstSnapshot?.content.slides[0].layers).toEqual([EDITED_MAP]);
        expect(secondSnapshot?.parentId).toBe(firstSnapshot?.id);
        scope.layers.clear();
        await seedScopeFromDb(SCOPE_ID);
        expect(scope.layers.get(MAP.numericId)).toEqual(nextMap);
    });

    test('a failed working-copy write reports failure and leaves the map dirty', async () => {
        spyOn(raw, 'updateOne').mockRejectedValueOnce(new Error('Write failed'));
        spyOn(console, 'error').mockImplementation(() => {});

        const result = await saveScope(SCOPE_ID, 'Map view', false);

        expect(result.success).toBe(false);
        expect(scope.dirty).toBe(true);
        const head = await commits.findById(headId);
        expect(head?.parentId).toBeNull();
        expect(head?.content.slides[0].layers).toEqual([MAP]);
    });

    test('an edit arriving during save remains dirty for the next save', async () => {
        const insert = raw.insertOne.bind(raw);
        const newerMap = { ...EDITED_MAP, view: { ...EDITED_MAP.view, zoom: 19 } };
        spyOn(raw, 'insertOne').mockImplementationOnce(async (document) => {
            scope.layers.set(MAP.numericId, newerMap);
            markScopeDirty(scope);
            return insert(document);
        });

        expect((await saveScope(SCOPE_ID, 'Map view', false)).success).toBe(true);
        expect(scope.dirty).toBe(true);
        const head = await commits.findById(headId);
        expect(head?.content.slides[0].layers).toEqual([EDITED_MAP]);
        expect(scope.layers.get(MAP.numericId)).toEqual(newerMap);
    });
});
