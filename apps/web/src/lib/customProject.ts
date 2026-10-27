interface CustomProjectFields {
    customPort?: number | null;
}

interface LegacyCustomUrlFields {
    customRenderUrl?: string | null;
    customControlUrl?: string | null;
    customRenderProxy?: boolean;
}

export function isCustomProject(project: CustomProjectFields): boolean {
    return typeof project.customPort === 'number';
}

export function withoutLegacyCustomUrls<T extends object>(
    project: T
): Omit<T, 'customRenderUrl' | 'customControlUrl' | 'customRenderProxy'> {
    const {
        customRenderUrl: _renderUrl,
        customControlUrl: _controlUrl,
        customRenderProxy: _proxy,
        ...rest
    } = project as T & LegacyCustomUrlFields;
    return rest;
}
