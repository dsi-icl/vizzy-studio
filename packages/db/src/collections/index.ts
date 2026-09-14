import '@tanstack/react-start/server-only';
import type { Db } from 'mongodb';

import { AssetsCollection } from './assets.collection';
import { AuditsCollection } from './audits.collection';
import { CommitsCollection } from './commits.collection';
import { DevicesCollection } from './devices.collection';
import { ProjectsCollection } from './projects.collection';
import { SignageSlideshowsCollection } from './signageSlideshows.collection';
import { WallsCollection } from './walls.collection';
import { YDocsCollection } from './ydocs.collection';

export { BaseCollection, toEpoch } from './_base';
export { buildMigrationWriteback } from './_migration';
export type { BaseDoc, MigrationFn, MigrationMap, PublicDoc } from './_base';
export { AuditsCollection } from './audits.collection';
export { AssetsCollection } from './assets.collection';
export { CommitsCollection } from './commits.collection';
export { DevicesCollection } from './devices.collection';
export { ProjectsCollection } from './projects.collection';
export { SignageSlideshowsCollection } from './signageSlideshows.collection';
export { WallsCollection } from './walls.collection';
export { YDocsCollection } from './ydocs.collection';

/** Create all collection instances bound to a single Db connection. */
export function createCollections(db: Db) {
    return {
        projects: new ProjectsCollection(db),
        signageSlideshows: new SignageSlideshowsCollection(db),
        commits: new CommitsCollection(db),
        assets: new AssetsCollection(db),
        walls: new WallsCollection(db),
        devices: new DevicesCollection(db),
        audits: new AuditsCollection(db),
        ydocs: new YDocsCollection(db)
    } as const;
}

export type AppCollections = ReturnType<typeof createCollections>;
