import { signageMiddleware } from '@repo/auth/tanstack/middleware';
import { SignageCollaborator, SignageSlideEntry, StageLayout } from '@repo/db/schema';
import { createServerFn } from '@tanstack/react-start';

import { z } from '~/lib/zod';

import {
    createSignageSlideshow,
    deleteSignageSlideshow,
    getSignageSlideshow,
    listSignageSlideshows,
    listSignageSources,
    resolveSignageEntries,
    updateSignageSlideshow
} from './signage';
import { getSignageRuntimeStatus, startSignageRunner } from './signageRunner';

const SignageDefaults = {
    defaultDisplayDurationMs: z.int().min(100).max(86_400_000),
    defaultGapDurationMs: z.int().min(0).max(86_400_000),
    gapMode: z.enum(['hold', 'blank'])
};

const SlideshowUpdate = z.object({
    id: z.string(),
    name: z.string().trim().min(1).max(100),
    layout: StageLayout,
    ...SignageDefaults,
    entries: z.array(SignageSlideEntry).max(1_000),
    targetWallIds: z.array(z.string().min(1)).max(100),
    enabled: z.boolean(),
    collaborators: z.array(SignageCollaborator).max(100)
});

export const $listSignageSlideshows = createServerFn({ method: 'GET' })
    .middleware([signageMiddleware])
    .handler(({ context }) => listSignageSlideshows(context.authContext.user!));

export const $getSignageSlideshow = createServerFn({ method: 'GET' })
    .middleware([signageMiddleware])
    .validator(z.object({ id: z.string() }))
    .handler(({ data, context }) => getSignageSlideshow(context.authContext.user!, data.id));

export const $createSignageSlideshow = createServerFn({ method: 'POST' })
    .middleware([signageMiddleware])
    .validator(
        z.object({
            name: z.string().trim().min(1).max(100),
            layout: StageLayout,
            ...SignageDefaults
        })
    )
    .handler(({ data, context }) => createSignageSlideshow(context.authContext.user!, data));

export const $updateSignageSlideshow = createServerFn({ method: 'POST' })
    .middleware([signageMiddleware])
    .validator(SlideshowUpdate)
    .handler(({ data, context }) => {
        const { id, ...input } = data;
        return updateSignageSlideshow(context.authContext.user!, id, input);
    });

export const $deleteSignageSlideshow = createServerFn({ method: 'POST' })
    .middleware([signageMiddleware])
    .validator(z.object({ id: z.string() }))
    .handler(({ data, context }) => deleteSignageSlideshow(context.authContext.user!, data.id));

export const $resolveSignageEntries = createServerFn({ method: 'GET' })
    .middleware([signageMiddleware])
    .validator(z.object({ id: z.string() }))
    .handler(({ data, context }) => resolveSignageEntries(context.authContext.user!, data.id));

export const $getSignageRuntimeStatus = createServerFn({ method: 'GET' })
    .middleware([signageMiddleware])
    .validator(z.object({ id: z.string() }))
    .handler(async ({ data, context }) => {
        const slideshow = await getSignageSlideshow(context.authContext.user!, data.id);
        startSignageRunner();
        return getSignageRuntimeStatus(slideshow);
    });

export const $listSignageSources = createServerFn({ method: 'GET' })
    .middleware([signageMiddleware])
    .validator(z.object({ layout: StageLayout }))
    .handler(({ data, context }) => listSignageSources(context.authContext.user!, data.layout));
