'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { isFontAsset, stripFileExtension } from '~/lib/mediaUtils';
import {
    getTextFontRevision,
    preloadTextFontSources,
    registerTextFontSources,
    subscribeTextFonts
} from '~/lib/textFontFaces';

const fontLoads = new Map<string, Promise<void>>();

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

function loadDocumentFont(font: FontAsset, dataUri: string): Promise<void> {
    const key = JSON.stringify([font.family, font.url]);
    const pending = fontLoads.get(key);
    if (pending) return pending;

    const load = Promise.resolve()
        .then(() => new FontFace(font.family, `url(${dataUri}) format('woff2')`).load())
        .then((face) => {
            document.fonts.add(face);
        })
        .catch((error) => {
            console.warn(`Failed to load font ${font.family}:`, error);
            fontLoads.delete(key);
        });
    fontLoads.set(key, load);
    return load;
}

export async function prepareFonts(fonts: readonly FontAsset[]): Promise<void> {
    registerTextFontSources(fonts);
    const dataUris = await preloadTextFontSources(fonts);
    await Promise.all(
        fonts.map((font, index) => {
            const dataUri = dataUris[index];
            return dataUri ? loadDocumentFont(font, dataUri) : Promise.resolve();
        })
    );
}

export function useRegisterFonts(fonts: readonly FontAsset[]): boolean {
    const signature = JSON.stringify(fonts);
    const [readySignature, setReadySignature] = useState<string | null>(null);

    useEffect(() => {
        if (fonts.length === 0) return;
        let active = true;
        void prepareFonts(fonts)
            .catch((error) => {
                console.warn('Failed to prepare project fonts:', error);
            })
            .then(() => {
                if (active) setReadySignature(signature);
            });
        return () => {
            active = false;
        };
    }, [fonts, signature]);

    return fonts.length === 0 || readySignature === signature;
}

export function useTextFontRevision(): number {
    return useSyncExternalStore(subscribeTextFonts, getTextFontRevision, () => 0);
}
