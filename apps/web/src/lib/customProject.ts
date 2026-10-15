interface CustomProjectFields {
    isCustom?: boolean | null;
    /** @deprecated Read only as a fallback for documents predating `isCustom`. */
    customRenderUrl?: string | null;
}

/** Falls back to the legacy `customRenderUrl` for projects not yet migrated to v3. */
export function isCustomProject(project: CustomProjectFields): boolean {
    if (typeof project.isCustom === 'boolean') return project.isCustom;
    return typeof project.customRenderUrl === 'string' && project.customRenderUrl.trim().length > 0;
}
