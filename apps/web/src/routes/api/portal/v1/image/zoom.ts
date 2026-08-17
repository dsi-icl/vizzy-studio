import { createFileRoute } from '@tanstack/react-router';

import {
    broadcastToWallNodesRaw,
    scopedState,
    upsertControllerTransientLayer,
    wallBindings
} from '~/lib/busState';
import { getBearerToken, getCorsHeaders, json } from '~/lib/portalHttp';
import { pruneExpiredPortalTokens, validatePortalToken } from '~/lib/portalTokens';
import type { GSMessage } from '~/lib/types';
import { z } from '~/lib/zod';

const requestSchema = z.object({
    imageUrl: z.string().trim().min(1),
    scale: z.number().min(0.75).max(22),
    centerX: z.number(),
    centerY: z.number()
});

export const Route = createFileRoute('/api/portal/v1/image/zoom')({
    server: {
        handlers: {
            OPTIONS: async ({ request }) =>
                new Response(null, { status: 204, headers: getCorsHeaders(request) }),

            POST: async ({ request }) => {
                pruneExpiredPortalTokens();

                const token = getBearerToken(request);
                const session = token ? validatePortalToken(token) : null;
                if (!session) return json(request, 401, { error: 'Invalid controller token' });

                const parsed = requestSchema.safeParse(await request.json().catch(() => undefined));
                if (!parsed.success) return json(request, 400, { error: 'Invalid zoom request' });

                const scopeId = wallBindings.get(session.wallId);
                if (scopeId !== session.scopeId) {
                    return json(request, 409, { error: 'Controller scope changed' });
                }

                const scope = scopedState.get(scopeId);
                if (!scope) return json(request, 409, { error: 'Controller scope missing' });

                const source = [...scope.layers.values()].find((layer) => layer.type === 'image');
                if (!source) return json(request, 404, { error: 'Image not found' });

                const dx =
                    (0.5 - parsed.data.centerX) *
                    source.config.width *
                    source.config.scaleX *
                    parsed.data.scale;
                const dy =
                    (0.5 - parsed.data.centerY) *
                    source.config.height *
                    source.config.scaleY *
                    parsed.data.scale;
                const layer = {
                    ...source,
                    url: parsed.data.imageUrl,
                    config: {
                        ...source.config,
                        cx: source.config.cx + dx,
                        cy: source.config.cy + dy,
                        scaleX: source.config.scaleX * parsed.data.scale,
                        scaleY: source.config.scaleY * parsed.data.scale
                    }
                };

                upsertControllerTransientLayer(session.wallId, layer);

                broadcastToWallNodesRaw(
                    session.wallId,
                    JSON.stringify({
                        type: 'upsert_layer',
                        origin: 'controller:image_zoom',
                        layer
                    } satisfies GSMessage)
                );

                return json(request, 200, {
                    ok: true,
                    numericId: source.numericId,
                    scale: parsed.data.scale
                });
            }
        }
    }
});
