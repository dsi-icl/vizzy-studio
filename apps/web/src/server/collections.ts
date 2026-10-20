import '@tanstack/react-start/server-only';
import { db } from '@repo/db';
import { createCollections } from '@repo/db/collections';
import type { SessionDocument, UserDocument } from '@repo/db/documents';

import { JobDocument } from '~/lib/jobs/types';

// ── Typed collection layer ────────────────────────────────────────────────────

export const dbCol = createCollections(db);

// ── Raw MongoDB collections ───────────────────────────────────────────────────
// Better Auth owns users/sessions write path — kept raw permanently.
// jobs and one-use demo launch tickets use Date timestamps and are infrastructure concerns.

export const collections = {
    users: db.collection<UserDocument>('user'),
    sessions: db.collection<SessionDocument>('session'),
    jobs: db.collection<JobDocument>('jobs'),
    serveLaunches: db.collection<{ _id: string; expiresAt: Date }>('serveLaunches')
} as const;
