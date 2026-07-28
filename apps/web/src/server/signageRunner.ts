import '@tanstack/react-start/server-only';
import type { PublicDoc } from '@repo/db/collections';
import type { SignageSlideEntry, SignageSlideshowDocument } from '@repo/db/documents';
import { stageLayoutsEqual } from '@repo/db/schema';

import {
    broadcastToControllersByWallRaw,
    editorsByScope,
    EMPTY_HYDRATE,
    hydrateWallNodes,
    notifyControllers,
    setSignageWallBlank,
    signageBlankWalls,
    unbindWall,
    wallBindingSources,
    wallBindings,
    wallsByWallId
} from '~/lib/busState';
import {
    broadcastWallBindingToEditors,
    broadcastWallBindingToGalleries,
    performLiveBind
} from '~/server/bus/bus.binding';
import { dbCol } from '~/server/collections';

type Slideshow = PublicDoc<SignageSlideshowDocument>;

type ResolvedEntry = {
    entry: SignageSlideEntry;
    projectId: string;
    commitId: string;
    slideId: string;
};

type Runtime = {
    slideshow: Slideshow;
    generation: number;
    index: number;
    phase: 'display' | 'gap';
    current: ResolvedEntry | null;
    timer: ReturnType<typeof setTimeout> | null;
};

const runtimes = new Map<string, Runtime>();
const targetOwnerByWall = new Map<string, string>();
const suppressedWalls = new Set<string>();
let reconcileGeneration = 0;
let started = false;

function isCurrentRuntime(runtime: Runtime): boolean {
    return runtimes.get(runtime.slideshow.id) === runtime;
}

async function resolveEntry(
    slideshow: Slideshow,
    entry: SignageSlideEntry
): Promise<ResolvedEntry | null> {
    const project = await dbCol.projects.findById(entry.projectId);
    if (!project || project.deletedAt) return null;
    const stages = project.stages.filter(
        (stage) => !stage.archivedAt && stageLayoutsEqual(stage.layout, slideshow.layout)
    );
    if (stages.length !== 1) return null;
    const stage = stages[0];
    if (!stage.publishedCommitId) return null;
    const commit = await dbCol.commits.findById(stage.publishedCommitId);
    if (!commit || commit.projectId !== project.id || commit.stageId !== stage.id) return null;
    if (!commit.content.slides.some(({ id }) => id === entry.slideId)) return null;
    return {
        entry,
        projectId: project.id,
        commitId: commit.id,
        slideId: entry.slideId
    };
}

async function findNextValid(runtime: Runtime, startIndex: number) {
    const count = runtime.slideshow.entries.length;
    for (let offset = 0; offset < count; offset++) {
        const index = (startIndex + offset) % count;
        const resolved = await resolveEntry(runtime.slideshow, runtime.slideshow.entries[index]);
        if (resolved) return { index, resolved };
    }
    return null;
}

function sendBlankFrame(wallId: string) {
    setSignageWallBlank(wallId, true);
    const payload = EMPTY_HYDRATE;
    for (const entry of wallsByWallId.get(wallId) ?? []) entry.peer.send(payload);
    broadcastToControllersByWallRaw(wallId, payload);
}

async function applyRuntimeToWall(runtime: Runtime, wallId: string) {
    if (!isCurrentRuntime(runtime) || targetOwnerByWall.get(wallId) !== runtime.slideshow.id) {
        return;
    }
    if (suppressedWalls.has(wallId)) return;
    if (runtime.phase === 'gap' && runtime.slideshow.gapMode === 'blank') {
        sendBlankFrame(wallId);
        return;
    }
    if (!runtime.current) {
        sendBlankFrame(wallId);
        return;
    }
    const { projectId, commitId, slideId } = runtime.current;
    await performLiveBind(wallId, projectId, commitId, slideId, 'signage');
    if (!isCurrentRuntime(runtime) && !targetOwnerByWall.has(wallId)) {
        await clearSignageBinding(wallId);
    }
}

async function applyRuntime(runtime: Runtime) {
    await Promise.all(
        runtime.slideshow.targetWallIds.map((wallId) => applyRuntimeToWall(runtime, wallId))
    );
}

function schedule(runtime: Runtime, delayMs: number, callback: () => Promise<void>) {
    if (!isCurrentRuntime(runtime)) return;
    const generation = runtime.generation;
    runtime.timer = setTimeout(
        () => {
            if (runtime.generation !== generation || !isCurrentRuntime(runtime)) return;
            void callback();
        },
        Math.max(1, delayMs)
    );
}

async function beginDisplay(runtime: Runtime, startIndex: number) {
    const next = await findNextValid(runtime, startIndex);
    if (!runtimes.has(runtime.slideshow.id) || runtimes.get(runtime.slideshow.id) !== runtime)
        return;
    if (!next) {
        runtime.current = null;
        runtime.phase = 'display';
        await applyRuntime(runtime);
        // Avoid a hot loop while waiting for publication/configuration changes.
        schedule(runtime, 30_000, () => beginDisplay(runtime, 0));
        return;
    }

    runtime.index = next.index;
    runtime.current = next.resolved;
    runtime.phase = 'display';
    await applyRuntime(runtime);
    const displayDuration =
        next.resolved.entry.displayDurationMs ?? runtime.slideshow.defaultDisplayDurationMs;
    schedule(runtime, displayDuration, () => beginGap(runtime));
}

async function beginGap(runtime: Runtime) {
    if (!isCurrentRuntime(runtime)) return;
    if (!runtime.current) return beginDisplay(runtime, runtime.index + 1);
    const gapDuration =
        runtime.current.entry.gapDurationMs ?? runtime.slideshow.defaultGapDurationMs;
    if (gapDuration <= 0) return beginDisplay(runtime, runtime.index + 1);
    runtime.phase = 'gap';
    await applyRuntime(runtime);
    schedule(runtime, gapDuration, () => beginDisplay(runtime, runtime.index + 1));
}

async function clearSignageBinding(wallId: string) {
    if (wallBindingSources.get(wallId) !== 'signage') return;
    unbindWall(wallId);
    hydrateWallNodes(wallId);
    broadcastToControllersByWallRaw(wallId, EMPTY_HYDRATE);
    notifyControllers(wallId, false);
    await dbCol.walls.updateByWallId(wallId, {
        boundProjectId: null,
        boundCommitId: null,
        boundSlideId: null,
        boundSource: null
    });
    broadcastWallBindingToEditors(wallId);
    broadcastWallBindingToGalleries(wallId);
}

export async function reconcileSignageRuntimes() {
    const generation = ++reconcileGeneration;
    await dbCol.signageSlideshows.ensureIndexes();
    const active = await dbCol.signageSlideshows.findActive();
    if (generation !== reconcileGeneration) return;

    const nextTargets = new Map<string, string>();
    for (const slideshow of active) {
        for (const wallId of slideshow.targetWallIds) nextTargets.set(wallId, slideshow.id);
    }
    const removedTargets = Array.from(targetOwnerByWall.keys()).filter(
        (wallId) => !nextTargets.has(wallId)
    );

    for (const runtime of runtimes.values()) {
        runtime.generation++;
        if (runtime.timer) clearTimeout(runtime.timer);
    }
    runtimes.clear();
    targetOwnerByWall.clear();
    for (const [wallId, slideshowId] of nextTargets) {
        targetOwnerByWall.set(wallId, slideshowId);
        const scopeId = wallBindings.get(wallId);
        if (
            scopeId !== undefined &&
            wallBindingSources.get(wallId) === 'live' &&
            (editorsByScope.get(scopeId)?.size ?? 0) > 0
        ) {
            suppressedWalls.add(wallId);
        }
    }
    for (const wallId of Array.from(suppressedWalls)) {
        if (!nextTargets.has(wallId)) suppressedWalls.delete(wallId);
    }
    await Promise.all(removedTargets.map((wallId) => clearSignageBinding(wallId)));

    for (const slideshow of active) {
        const runtime: Runtime = {
            slideshow,
            generation: 1,
            index: -1,
            phase: 'display',
            current: null,
            timer: null
        };
        runtimes.set(slideshow.id, runtime);
        void beginDisplay(runtime, 0);
    }
}

export function suppressSignageWall(wallId: string) {
    suppressedWalls.add(wallId);
    signageBlankWalls.delete(wallId);
}

export function resumeSignageWall(wallId: string) {
    suppressedWalls.delete(wallId);
    const slideshowId = targetOwnerByWall.get(wallId);
    const runtime = slideshowId ? runtimes.get(slideshowId) : null;
    if (runtime) void applyRuntimeToWall(runtime, wallId);
}

export function startSignageRunner() {
    if (started) return;
    started = true;
    process.__SIGNAGE_CONFIG_CHANGED__ = () => {
        void reconcileSignageRuntimes().catch((error) => {
            console.error('[Signage] Failed to reconcile runtimes', error);
        });
    };
    process.__SIGNAGE_IS_TARGET_WALL__ = (wallId) => targetOwnerByWall.has(wallId);
    process.__SIGNAGE_IS_WALL_SUPPRESSED__ = (wallId) => suppressedWalls.has(wallId);
    process.__SIGNAGE_SUPPRESS_WALL__ = suppressSignageWall;
    process.__SIGNAGE_RESUME_WALL__ = resumeSignageWall;
    process.__SIGNAGE_CONFIG_CHANGED__();
}
