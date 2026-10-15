interface CustomProjectFields {
    customPort?: number | null;
    /** @deprecated Read only so a project configured before `/serve` still reads as custom. */
    customRenderUrl?: string | null;
}

interface LegacyCustomUrlFields {
    customRenderUrl?: string | null;
    customControlUrl?: string | null;
    customRenderProxy?: boolean;
}

export function isCustomProject(project: CustomProjectFields): boolean {
    if (typeof project.customPort === 'number') return true;
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
