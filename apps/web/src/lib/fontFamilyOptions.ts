export const DEFAULT_FONT_OPTION_ID = 'system-sans';

export const SYSTEM_FONT_OPTIONS = [
    { id: 'system-sans', label: 'System Sans', css: 'system-ui, sans-serif' },
    { id: 'system-serif', label: 'System Serif', css: 'ui-serif, serif' },
    { id: 'system-mono', label: 'System Mono', css: 'ui-monospace, monospace' }
] as const;

export function getFontFamilyCss(optionId: string): string {
    const system = SYSTEM_FONT_OPTIONS.find((option) => option.id === optionId);
    if (system) return system.css;
    if (optionId.startsWith('project:')) {
        const family = optionId
            .slice('project:'.length)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/[\r\n]/g, '');
        return `"${family}", system-ui, sans-serif`;
    }
    return SYSTEM_FONT_OPTIONS[0].css;
}
