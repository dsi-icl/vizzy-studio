import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { adminMiddleware } from '@repo/auth/tanstack/middleware';
import { createServerFn } from '@tanstack/react-start';

import { CONTROLLER_DIR } from '~/lib/serverVariables';
import { z } from '~/lib/zod';
import { logAuditDenied } from '~/server/audit';
import { getProject } from '~/server/projects';

export const $getCustomControllerHtml = createServerFn({ method: 'GET' })
    .validator(
        z.object({
            projectId: z.string()
        })
    )
    .middleware([adminMiddleware])
    .handler(async ({ data }) => {
        const project = await getProject(data.projectId);
        if (!project) {
            await logAuditDenied({
                action: 'CUSTOM_CONTROLLER_HTML_DENIED',
                resourceType: 'project',
                resourceId: data.projectId,
                reasonCode: 'PROJECT_NOT_FOUND',
                executionContext: {
                    surface: 'serverfn',
                    operation: '$getCustomControllerHtml'
                }
            });
            throw new Error('Project not found');
        }

        try {
            const html = await readFile(
                join(CONTROLLER_DIR, project.id, 'controller.html'),
                'utf8'
            );
            return html;
        } catch {
            return '';
        }
    });

export const $upsertCustomControllerHtml = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            projectId: z.string(),
            html: z.string()
        })
    )
    .handler(async ({ data }) => {
        const project = await getProject(data.projectId);
        if (!project) {
            await logAuditDenied({
                action: 'CUSTOM_CONTROLLER_HTML_DENIED',
                resourceType: 'project',
                resourceId: data.projectId,
                reasonCode: 'PROJECT_NOT_FOUND',
                executionContext: {
                    surface: 'serverfn',
                    operation: '$upsertCustomControllerHtml'
                }
            });
            throw new Error('Project not found');
        }

        const dir = join(CONTROLLER_DIR, project.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'controller.html'), data.html, 'utf8');
        return { ok: true };
    });
