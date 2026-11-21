import '@tanstack/react-start/server-only';
import { db } from '@repo/db';
import { createCollections } from '@repo/db/collections';
import type { SessionDocument, UserDocument } from '@repo/db/documents';

import { JobDocument } from '~/lib/jobs/types';

// ── Typed collection layer ────────────────────────────────────────────────────

export const dbCol = createCollections(db);

// ── Raw MongoDB collections ───────────────────────────────────────────────────
// Better Auth owns users/sessions write path — kept raw permanently.
// Jobs use Date timestamps and remain a raw infrastructure collection.

export const collections = {
    users: db.collection<UserDocument>('user'),
    sessions: db.collection<SessionDocument>('session'),
    jobs: db.collection<JobDocument>('jobs')
} as const;
