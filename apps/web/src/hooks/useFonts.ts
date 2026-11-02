import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { projectAssetsQueryOptions } from '~/server/projects.queries';

import { fontAssetsFromRecords, useRegisterFonts, type FontAsset } from './fontRegistration';

export type { FontAsset } from './fontRegistration';
export { useTextFontRevision } from './fontRegistration';

/**
 * Loads project + public WOFF2 fonts from asset records into `document.fonts`
 * and the text rasteriser. Returns a list of available font families for
 * toolbar usage.
 */
export function useFontsState(projectId: string | null | undefined): {
    fonts: FontAsset[];
    ready: boolean;
    failed: boolean;
    retry: () => void;
} {
    const {
        data: assets,
        isError,
        refetch
    } = useQuery({
        ...projectAssetsQueryOptions(projectId ?? ''),
        enabled: Boolean(projectId)
    });

    const fonts = useMemo<FontAsset[]>(() => {
        if (!projectId) return [];
        return fontAssetsFromRecords(assets ?? []);
    }, [assets, projectId]);

    const registered = useRegisterFonts(fonts);

    return {
        fonts,
        ready: (!projectId || assets !== undefined) && registered,
        failed: Boolean(projectId && assets === undefined && isError),
        retry: () => void refetch()
    };
}

export function useFonts(projectId: string | null | undefined): FontAsset[] {
    return useFontsState(projectId).fonts;
}
