interface CustomProjectFields {
    isCustom?: boolean | null;
    /** @deprecated Read only as a fallback for documents predating `isCustom`. */
    customRenderUrl?: string | null;
}

interface LegacyCustomUrlFields {
    customRenderUrl?: string | null;
    customControlUrl?: string | null;
    customRenderProxy?: boolean;
}

/** Falls back to the legacy `customRenderUrl` for projects not yet migrated to v3. */
export function isCustomProject(project: CustomProjectFields): boolean {
    if (typeof project.isCustom === 'boolean') return project.isCustom;
    return typeof project.customRenderUrl === 'string' && project.customRenderUrl.trim().length > 0;
}

export function withoutLegacyCustomUrls<T extends object>(
    project: T
): Omit<T, 'customRenderUrl' | 'customControlUrl' | 'customRenderProxy'> & { isCustom: boolean } {
    const {
        customRenderUrl: _renderUrl,
        customControlUrl: _controlUrl,
        customRenderProxy: _proxy,
        ...rest
    } = project as T & LegacyCustomUrlFields;
    return { ...rest, isCustom: isCustomProject(project as CustomProjectFields) };
}
