'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { signedFetch } from '~/lib/signedFetch';
import { z } from '~/lib/zod';

import { fontAssetsFromRecords, useRegisterFonts, type FontAsset } from './fontRegistration';

const NO_FONTS: FontAsset[] = [];

const FontManifestSchema = z.object({
    fonts: z
        .array(
            z.object({
                name: z.string(),
                url: z.string(),
                mimeType: z.string().nullish()
            })
        )
        .default([])
});

export function useWallFonts(
    projectId: string | null | undefined,
    wallId: string | null | undefined
): FontAsset[] {
    const { data, error } = useQuery({
        queryKey: ['wall', wallId, 'fonts', projectId],
        enabled: Boolean(projectId && wallId),
        staleTime: 5 * 60_000,
        queryFn: async () => {
            if (!projectId || !wallId) return NO_FONTS;

            const res = await signedFetch(
                `/api/wall/fonts?projectId=${encodeURIComponent(projectId)}`,
                undefined,
                { deviceKind: 'wall', wallId }
            );
            if (!res.ok) throw new Error(`Font manifest failed: ${res.status}`);

            const manifest = FontManifestSchema.parse(await res.json());
            return fontAssetsFromRecords(manifest.fonts);
        }
    });

    useEffect(() => {
        if (error) console.warn('[Wall] Failed to load project fonts', error);
    }, [error]);

    const fonts = data ?? NO_FONTS;
    useRegisterFonts(fonts);

    return fonts;
}
