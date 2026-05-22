export function deriveVideoStillImageFilename(url: string): string | null {
    if (!url.startsWith('/api/assets/')) return null;
    const filename = url.split('/').pop() ?? '';
    const base = filename.replace(/\.[^.]+$/, '');
    return base ? `${base}.jpg` : null;
}

export function isFontAsset(asset: { name: string; mimeType?: string | null }): boolean {
    return asset.mimeType === 'font/woff2' || /\.woff2$/i.test(asset.name);
}

export function sortAssetsFontsLast<T extends { name: string; mimeType?: string | null }>(
    items: T[]
): T[] {
    const media: T[] = [];
    const fonts: T[] = [];
    for (const item of items) {
        if (isFontAsset(item)) fonts.push(item);
        else media.push(item);
    }
    return [...media, ...fonts];
}

export function stripFileExtension(name: string): string {
    const trimmed = name.trim();
    const dot = trimmed.lastIndexOf('.');
    if (dot <= 0) return trimmed;
    return trimmed.slice(0, dot);
}
