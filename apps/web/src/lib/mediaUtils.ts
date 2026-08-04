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

function stripFileExtension(name: string): string {
    const trimmed = name.trim();
    const dot = trimmed.lastIndexOf('.');
    if (dot <= 0) return trimmed;
    return trimmed.slice(0, dot);
}

export function makeUniqueMediaLayerName(
    filename: string,
    existingLayers: Iterable<{ type: string; name?: string }>
): string {
    const baseName = stripFileExtension(filename) || 'Untitled';
    const existingMediaNames = Array.from(existingLayers).flatMap((layer) => {
        if (layer.type === 'image') return [layer.name?.trim() || 'Image'];
        if (layer.type === 'video') return [layer.name?.trim() || 'Video'];
        return [];
    });
    const usedNames = new Set(existingMediaNames.map((name) => name.toLowerCase()));

    if (!usedNames.has(baseName.toLowerCase())) return baseName;

    let suffix = 1;
    while (usedNames.has(`${baseName} ${suffix}`.toLowerCase())) {
        suffix += 1;
    }

    return `${baseName} ${suffix}`;
}
