'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { isFontAsset, stripFileExtension } from '~/lib/mediaUtils';
import {
    getTextFontRevision,
    registerTextFontSources,
    subscribeTextFonts
} from '~/lib/textFontFaces';

const loadedFonts = new Set<string>();

export interface FontAsset {
    family: string;
    url: string;
}

export function fontAssetsFromRecords(
    records: readonly { name: string; url: string; mimeType?: string | null }[]
): FontAsset[] {
    return records.filter(isFontAsset).map((a) => ({
        family: stripFileExtension(a.name),
        url: `/api/assets/${a.url}`
    }));
}

export function useRegisterFonts(fonts: readonly FontAsset[]): void {
    useEffect(() => {
        if (fonts.length === 0) return;

        registerTextFontSources(fonts);

        for (const font of fonts) {
            const key = `${font.family}|${font.url}`;
            if (loadedFonts.has(key)) continue;
            loadedFonts.add(key);

            const face = new FontFace(font.family, `url(${font.url}) format('woff2')`);
            face.load()
                .then((loaded) => {
                    document.fonts.add(loaded);
                })
                .catch((err) => {
                    console.warn(`Failed to load font ${font.family}:`, err);
                    loadedFonts.delete(key);
                });
        }
    }, [fonts]);
}

export function useTextFontRevision(): number {
    return useSyncExternalStore(subscribeTextFonts, getTextFontRevision, () => 0);
}
