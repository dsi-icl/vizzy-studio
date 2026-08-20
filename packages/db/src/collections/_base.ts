import '@tanstack/react-start/server-only';
import type {
    ChangeStream,
    ChangeStreamOptions,
    Collection,
    Document,
    Filter,
    FindOptions,
    ObjectId,
    UpdateFilter
} from 'mongodb';
import { ObjectId as OID } from 'mongodb';

import { buildMigrationWriteback } from './_migration';

/** Converts any legacy timestamp format (Date, ISO string, epoch number) to epoch ms. */
export function toEpoch(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
        const n = Date.parse(value);
        return Number.isFinite(n) ? n : Date.now();
    }
    return Date.now();
}

/** A function that migrates a raw document from schema version N to version N+1. */
export type MigrationFn = (doc: Document) => Document;

/**
 * Map of migration functions keyed by the version they migrate FROM.
 * `migrations[0]` upgrades a v0 document to v1, `migrations[1]` upgrades v1 → v2, etc.
 */
export type MigrationMap = Record<number, MigrationFn>;

/** Minimum shape every app-owned document must satisfy. */
export interface BaseDoc {
    _id: ObjectId;
    /** String representation of `_id`. Synthesised by `fromDB` — never stored in MongoDB. */
    id: string;
    createdAt: number;
    /** Internal schema version. Managed by the collection layer — do not set manually. */
    _version?: number;
}

/**
 * The public-facing document type returned by all collection read/write methods.
 * `_id` and `_version` are stripped — both are internal implementation details.
 */
export type PublicDoc<TDoc extends BaseDoc> = Omit<TDoc, '_id' | '_version'>;

/**
 * Fields excluded from insert input — generated automatically by the collection layer.
 */
type InsertData<TDoc extends BaseDoc> = Omit<
    TDoc,
    '_id' | 'id' | 'createdAt' | 'updatedAt' | '_version'
>;

/**
 * Fields excluded from update $set — `_id`, `id`, `createdAt`, and `_version` are immutable
 * after insert (the layer always writes the current version on every update).
 */
type UpdateData<TDoc extends BaseDoc> = Partial<
    Omit<TDoc, '_id' | 'id' | 'createdAt' | '_version'>
>;

function sanitizeBsonLike(value: unknown): unknown {
    if (value instanceof OID) return value.toHexString();
    if (Array.isArray(value)) return value.map((entry) => sanitizeBsonLike(entry));
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date) return value;

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = sanitizeBsonLike(entry);
    }
    return out;
}

/**
 * Abstract base for all app-owned MongoDB collections.
 *
 * Responsibilities:
 *  - `fromDB`    applies the migration chain for stale documents, then writes back
 *                asynchronously using a version guard to prevent racing a concurrent write.
 *  - `expose`    strips `_id` from a document before returning it to callers.
 *  - `insert`    auto-generates `_id`, `createdAt`, `updatedAt`, `_version`.
 *  - `update`    always stamps `updatedAt` and `_version`.
 *  - `softDelete` stamps `deletedAt`, `deletedBy`, `updatedAt`, `_version`.
 *
 * All public read/write methods return `PublicDoc<TDoc>` — `_id` is never exposed
 * outside the collection layer. Use `id: string` everywhere in app code.
 *
 * Subclasses must declare:
 *  - `currentVersion` — the schema version stamped on every new write.
 *  - `migrations`     — a map of upgrade functions (version N → N+1).
 */
export abstract class BaseCollection<TDoc extends BaseDoc> {
    /** The MongoDB collection name — used only for diagnostics. */
    abstract readonly collectionName: string;

    /**
     * The current schema version. Every insert/update stamps this value as `_version`.
     * Documents read with a lower version are migrated transparently via `fromDB`.
     */
    abstract readonly currentVersion: number;

    /**
     * Migration functions keyed by the version they upgrade FROM.
     * Default is empty (no migrations needed yet). Override in subclasses.
     */
    protected readonly migrations: MigrationMap = {};

    protected constructor(protected readonly raw: Collection<Document>) {}

    /**
     * Convert app-layer insert data to the raw MongoDB document shape.
     * Override in subclasses to convert string foreign keys to ObjectId before storage.
     * Default: identity (no conversion needed).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected toRaw(data: InsertData<TDoc>): Record<string, any> {
        return data as Record<string, unknown>;
    }

    /**
     * Normalise a raw MongoDB document to `TDoc`:
     *  1. Apply each migration step from the stored version up to `currentVersion`.
     *  2. Fire-and-forget write-back if any migration was applied, guarded by a
     *     version filter so a concurrent update's write is never overwritten.
     */
    protected fromDB(doc: Document): TDoc {
        let current = { ...doc } as Document;
        let version = (current._version as number | undefined) ?? 0;
        const initialVersion = version;

        while (version < this.currentVersion) {
            const migrate = this.migrations[version];
            if (!migrate) break;
            current = migrate(current);
            version++;
        }

        // Write back if any migration ran. The filter ensures this is a no-op if
        // a concurrent update already advanced the version past our starting point.
        if (version > initialVersion) {
            this.raw
                .updateOne(
                    {
                        _id: current._id,
                        _version: { $not: { $gte: this.currentVersion } }
                    },
                    buildMigrationWriteback(doc, current, version)
                )
                .catch(() => {});
        }

        return {
            ...current,
            _version: version,
            id: (current._id as OID).toHexString()
        } as unknown as TDoc;
    }

    /** Strip `_id` and `_version` from a fully-migrated document before returning it to app code. */
    protected expose(doc: TDoc): PublicDoc<TDoc> {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, _version, ...rest } = doc as TDoc & { _id: unknown; _version: unknown };
        return sanitizeBsonLike(rest) as PublicDoc<TDoc>;
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    async findById(id: string | ObjectId): Promise<PublicDoc<TDoc> | null> {
        const record = await this.raw.findOne({ _id: new OID(id) });
        return record ? this.expose(this.fromDB(record)) : null;
    }

    async findOne(filter: Filter<Document>): Promise<PublicDoc<TDoc> | null> {
        const record = await this.raw.findOne(filter);
        return record ? this.expose(this.fromDB(record)) : null;
    }

    async find(filter: Filter<Document> = {}, options?: FindOptions): Promise<PublicDoc<TDoc>[]> {
        const records = await this.raw.find(filter, options).toArray();
        return records.map((r) => this.expose(this.fromDB(r)));
    }

    async count(filter: Filter<Document> = {}): Promise<number> {
        return this.raw.countDocuments(filter);
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /** Insert a new document. `_id`, `createdAt`, `updatedAt`, and `_version` are auto-generated. */
    async insert(data: InsertData<TDoc>): Promise<PublicDoc<TDoc>> {
        const now = Date.now();
        const doc: Document = {
            _id: new OID(),
            createdAt: now,
            updatedAt: now,
            _version: this.currentVersion,
            ...this.toRaw(data)
        };
        await this.raw.insertOne(doc);
        return this.expose(this.fromDB(doc));
    }

    /**
     * Update fields on a document by id. `updatedAt` and `_version` are always stamped.
     * Returns the updated document, or `null` if not found.
     */
    async update(id: string | ObjectId, $set: UpdateData<TDoc>): Promise<PublicDoc<TDoc> | null> {
        const result = await this.raw.findOneAndUpdate(
            { _id: new OID(id) },
            {
                $set: { ...$set, updatedAt: Date.now(), _version: this.currentVersion }
            } as UpdateFilter<Document>,
            { returnDocument: 'after' }
        );
        return result ? this.expose(this.fromDB(result)) : null;
    }

    /**
     * Apply an arbitrary MongoDB update expression by id.
     * Use when you need `$unset`, `$push`, etc. — `updatedAt` and `_version` are NOT
     * auto-stamped here; callers are responsible for including them if needed.
     */
    async updateRaw(
        id: string | ObjectId,
        update: UpdateFilter<Document>
    ): Promise<PublicDoc<TDoc> | null> {
        const result = await this.raw.findOneAndUpdate({ _id: new OID(id) }, update, {
            returnDocument: 'after'
        });
        return result ? this.expose(this.fromDB(result)) : null;
    }

    /** Soft-delete: stamps `deletedAt`, `deletedBy`, `updatedAt`, and `_version`. */
    async softDelete(id: string | ObjectId, by: string): Promise<void> {
        const now = Date.now();
        await this.raw.updateOne(
            { _id: new OID(id) },
            {
                $set: {
                    deletedAt: now,
                    deletedBy: by,
                    updatedAt: now,
                    _version: this.currentVersion
                }
            }
        );
    }

    /** Hard-delete — permanent removal. Use with care. */
    async delete(id: string | ObjectId): Promise<void> {
        await this.raw.deleteOne({ _id: new OID(id) });
    }

    /**
     * Open a MongoDB change stream on this collection.
     * Use for real-time notifications; the caller owns the lifecycle.
     */
    watch(pipeline: Document[] = [], options?: ChangeStreamOptions): ChangeStream<Document> {
        return this.raw.watch(pipeline, options);
    }

    /**
     * @deprecated Escape hatch to the raw MongoDB collection.
     * Add a typed method to the subclass instead of using this.
     * Remaining legitimate uses: index management, aggregation pipelines,
     * and dot-notation `$set` paths that TypeScript cannot express through
     * the typed `update()` helper.
     */
    get collection(): Collection<Document> {
        return this.raw;
    }
}
