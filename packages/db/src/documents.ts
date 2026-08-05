import '@tanstack/react-start/server-only';
import type { Binary, ObjectId } from 'mongodb';

import type { CollaboratorRole, ProjectStage, ProjectVisibility, StageLayout } from './schema';

export type { ProjectStage, StageLayout };

// JSON-compatible value type — safe for TanStack Start server function return values.
export type JsonPrimitive = string | number | boolean | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ── Better Auth managed ───────────────────────────────────────────────────────
// Minimal interfaces covering only the fields accessed by application code.
// Better Auth owns the write path for these two collections.
// Timestamps remain as Date — Better Auth controls the format.

export interface UserDocument {
    _id: ObjectId;
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    role?: string | null;
    trustedPublisher?: boolean | null;
    canManageSignage?: boolean | null;
    lastSeen?: Date | null;
    banned?: boolean | null;
    emailVerified?: boolean | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SessionDocument {
    _id: ObjectId;
    userId: string;
    token: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

// ── Application collections ───────────────────────────────────────────────────
// All timestamps are epoch milliseconds (number).
// The collection layer normalises legacy string / Date values on read via fromDB().

export interface ProjectDocument {
    _id: ObjectId;
    id: string;
    name: string;
    authorOrganisation: string;
    description: string;
    tags: string[];
    visibility: ProjectVisibility;
    heroImages: string[];
    customControlUrl?: string | null;
    customRenderUrl?: string | null;
    customRenderCompat: boolean;
    customRenderProxy: boolean;
    collaborators: Array<{ email: string; role: CollaboratorRole }>;
    defaultStageId: string;
    stages: ProjectStage[];
    deletedAt?: number | null;
    deletedBy?: string | null;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}

export interface CommitDocument {
    _id: ObjectId;
    id: string;
    projectId: string;
    stageId: string;
    parentId: string | null;
    authorEmail: string | null;
    message: string;
    content: {
        slides: Array<{
            id: string;
            order: number;
            name: string;
            layers: Array<{ [key: string]: JsonValue }>;
        }>;
    };
    isAutoSave: boolean;
    isMutableHead: boolean;
    createdAt: number;
    updatedAt?: number;
}

export interface AssetDocument {
    _id: ObjectId;
    id: string;
    projectId: string;
    name: string;
    url: string;
    size: number;
    mimeType?: string | null;
    blurhash?: string | null;
    previewUrl?: string | null;
    sizes?: number[] | null;
    public?: boolean | null;
    /** Set on auto-generated assets (e.g. web screenshots) to exclude from library listings */
    hidden?: boolean;
    deletedAt?: number | null;
    deletedBy?: string | null;
    createdAt: number;
    createdBy: string;
    updatedAt?: number;
}

export interface WallDocument {
    _id: ObjectId;
    id: string;
    wallId: string;
    name: string;
    connectedNodes?: number;
    lastSeen: number;
    boundProjectId?: string | null;
    boundCommitId?: string | null;
    boundSlideId?: string | null;
    boundSource?: 'live' | 'gallery' | 'signage' | null;
    layoutTemplate?: (StageLayout & { configuredAt: number; configuredBy: string }) | null;
    site?: string | null;
    notes?: string | null;
    createdAt: number;
    updatedAt?: number;
}

export interface SignageSlideEntry {
    id: string;
    projectId: string;
    slideId: string;
    displayDurationMs?: number;
    gapDurationMs?: number;
}

export interface SignageSlideshowDocument {
    _id: ObjectId;
    id: string;
    name: string;
    layout: StageLayout;
    defaultDisplayDurationMs: number;
    defaultGapDurationMs: number;
    gapMode: 'hold' | 'blank';
    entries: SignageSlideEntry[];
    targetWallIds: string[];
    enabled: boolean;
    createdBy: string;
    collaborators: Array<{ email: string; role: 'viewer' | 'editor' }>;
    deletedAt?: number | null;
    deletedBy?: string | null;
    createdAt: number;
    updatedAt: number;
}

export type DeviceKind = 'wall' | 'gallery' | 'controller';
export type DeviceStatus = 'pending' | 'active' | 'revoked';

export interface DeviceDocument {
    _id: ObjectId;
    id: string;
    publicKey: string;
    kind: DeviceKind;
    status: DeviceStatus;
    assignedWallId?: string | null;
    assignedAt?: number;
    assignedBy?: string;
    createdAt: number;
    updatedAt: number;
    lastSeenAt?: number | null;
    label?: string | null;
    notes?: string | null;
}

export interface YDocDocument {
    _id: ObjectId;
    id: string;
    scope: string;
    data: Binary;
    /** Monotonic compare-and-swap revision for the persisted Yjs snapshot. */
    revision?: number;
    /** Hash of the encoded Yjs snapshot stored in `data`. */
    stateHash?: string;
    /** Hash of the HTML projection generated from this exact snapshot. */
    htmlHash?: string;
    /** Hash of the source HTML used when the Yjs document was first bootstrapped. */
    sourceTextHash?: string;
    /** Semantic encoding version of the Lexical <-> Yjs binding. */
    bindingVersion?: string;
    createdAt: number;
    updatedAt: number;
}

export interface AuthContext {
    guest?: boolean;
    user?: {
        email: string;
        role: 'admin' | 'operator' | 'user';
        trustedPublisher?: boolean;
        canManageSignage?: boolean;
        impersonatedBy?: string;
    };
    device?: {
        id: string;
        kind: 'wall' | 'controller' | 'gallery';
        wallId?: string;
    };
    portal?: {
        wallId: string;
    };
}

export interface AuditExecutionContext {
    surface?: 'http' | 'serverfn' | 'ws' | 'yjs' | 'job' | 'system' | 'unknown' | null;
    operation?: string | null;
    method?: string | null;
    path?: string | null;
    requestId?: string | null;
    peerId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    details?: { [key: string]: JsonValue } | null;
}

export type AuditResourceType =
    | 'project'
    | 'commit'
    | 'asset'
    | 'wall'
    | 'device'
    | 'user'
    | 'upload_token'
    | 'start_route'
    | 'ws_message'
    | 'portal_token'
    | 'bootstrap'
    | 'config'
    | 'smtp'
    | 'scope'
    | 'signage_slideshow'
    | 'unknown';

export interface AuditLogDocument {
    _id: ObjectId;
    id: string;
    projectId: string | null;
    actorId: string | null;
    action: string;
    outcome: 'success' | 'denied' | 'failure' | 'error';
    resourceType?: AuditResourceType | null;
    resourceId?: string | null;
    reasonCode?: string | null;
    changes?: { [key: string]: JsonValue } | null;
    error?: string | null;
    authContext?: AuthContext | null;
    executionContext?: AuditExecutionContext | null;
    createdAt: number;
}
