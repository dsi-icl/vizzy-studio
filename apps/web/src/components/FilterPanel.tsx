import { DropHalfIcon, DropSlashIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Slider } from '@repo/ui/components/slider';
import { TipButton } from '@repo/ui/components/tip-button';
import { throttle } from '@tanstack/pacer';
import { useCallback, useMemo, useRef } from 'react';

import { EditorEngine } from '~/lib/editorEngine';
import { makeLayerPatch } from '~/lib/editorLayerChange';
import { useEditorStore } from '~/lib/editorStore';
import { FILTER_PRESETS, normalizeLayerFilters, toCssFilterString } from '~/lib/layerFilters';
import type { LayerFilterState, LayerWithEditorState } from '~/lib/types';

interface FilterPanelProps {
    activeLayer: LayerWithEditorState;
}

export function FilterPanel({ activeLayer }: FilterPanelProps) {
    const activeFilters = normalizeLayerFilters(activeLayer.config.filters);

    const activeLayerPreviewUrl = useMemo(() => {
        if (activeLayer.type === 'image') return activeLayer.url;
        if (activeLayer.type === 'video') {
            if (activeLayer.stillImage) return `/api/assets/${activeLayer.stillImage}`;
            const filename = activeLayer.url.split('/').pop() ?? '';
            const base = filename.replace(/\.[^.]+$/, '');
            return base ? `/api/assets/${base}.jpg` : null;
        }
        if (activeLayer.type === 'web' && activeLayer.stillImage) {
            return `/api/assets/${activeLayer.stillImage}`;
        }
        return null;
    }, [activeLayer]);

    const throttledFilterBroadcast = useRef(
        throttle(
            (layer: LayerWithEditorState) => {
                const engine = EditorEngine.getInstance();
                engine.sendJSON({ type: 'upsert_layer', origin: 'editor:toolbar_filters', layer });
                useEditorStore.getState().markDirty();
            },
            { wait: 120 }
        )
    );

    const updateActiveLayerFilters = useCallback(
        (updater: (current: LayerFilterState) => LayerFilterState) => {
            const current = normalizeLayerFilters(activeLayer.config.filters);
            const next = updater(current);
            const updatedLayer = {
                ...activeLayer,
                config: { ...activeLayer.config, filters: next }
            };
            useEditorStore.getState().recordLayerChange({
                patches: [makeLayerPatch(activeLayer.numericId, activeLayer, updatedLayer)],
                mergeKey: `filters:${activeLayer.numericId}`
            });
            useEditorStore.getState().upsertLayer(updatedLayer);
            throttledFilterBroadcast.current(updatedLayer);
        },
        [activeLayer]
    );

    return (
        <Popover>
            <PopoverTrigger nativeButton={false} render={<div />}>
                <TipButton
                    tip="Layer filters"
                    variant={activeFilters.enabled ? 'outline' : 'ghost'}
                >
                    {activeFilters.enabled ? <DropHalfIcon /> : <DropSlashIcon />}
                </TipButton>
            </PopoverTrigger>
            <PopoverContent className="w-88 p-3" side="bottom" align="start">
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Filters</span>
                        <Button
                            size="sm"
                            variant={activeFilters.enabled ? 'outline' : 'ghost'}
                            onClick={() =>
                                updateActiveLayerFilters((f) => ({ ...f, enabled: !f.enabled }))
                            }
                        >
                            {activeFilters.enabled ? 'On' : 'Off'}
                        </Button>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                        {FILTER_PRESETS.map((preset) => (
                            <button
                                key={preset.id}
                                type="button"
                                className="cursor-pointer rounded-md border border-border bg-card p-1.5 text-left text-[10px] transition-colors hover:border-primary"
                                onClick={() =>
                                    updateActiveLayerFilters(() => ({
                                        ...preset.filters,
                                        enabled: preset.id !== 'none'
                                    }))
                                }
                            >
                                <div
                                    className="mb-1 h-7 w-full rounded bg-cover bg-center"
                                    style={{
                                        backgroundImage: activeLayerPreviewUrl
                                            ? `url(${activeLayerPreviewUrl})`
                                            : 'linear-gradient(135deg,#334155,#64748b)',
                                        filter: toCssFilterString(preset.filters)
                                    }}
                                />
                                <span className="block text-center text-muted-foreground">
                                    {preset.label}
                                </span>
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant={activeFilters.grayscale ? 'outline' : 'ghost'}
                            onClick={() =>
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    grayscale: !f.grayscale
                                }))
                            }
                        >
                            Grayscale
                        </Button>
                        <Button
                            size="sm"
                            variant={activeFilters.invert ? 'outline' : 'ghost'}
                            onClick={() =>
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    invert: !f.invert
                                }))
                            }
                        >
                            Invert
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">
                            Brightness ({Math.round(activeFilters.brightness)}%)
                        </label>
                        <Slider
                            value={[activeFilters.brightness]}
                            min={0}
                            max={200}
                            step={1}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 100) : v;
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    brightness: next
                                }));
                            }}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">
                            Contrast ({Math.round(activeFilters.contrast)}%)
                        </label>
                        <Slider
                            value={[activeFilters.contrast]}
                            min={0}
                            max={200}
                            step={1}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 100) : v;
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    contrast: next
                                }));
                            }}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">
                            Hue ({Math.round(activeFilters.hueRotate)}deg)
                        </label>
                        <Slider
                            value={[activeFilters.hueRotate]}
                            min={-180}
                            max={180}
                            step={1}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 0) : v;
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    hueRotate: next
                                }));
                            }}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">
                            Saturation ({Math.round(activeFilters.saturation)}%)
                        </label>
                        <Slider
                            value={[activeFilters.saturation]}
                            min={0}
                            max={200}
                            step={1}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 100) : v;
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    saturation: next
                                }));
                            }}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">
                            Blur ({activeFilters.blur.toFixed(1)}px)
                        </label>
                        <Slider
                            value={[activeFilters.blur]}
                            min={0}
                            max={20}
                            step={0.5}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 0) : v;
                                updateActiveLayerFilters((f) => ({
                                    ...f,
                                    enabled: true,
                                    blur: next
                                }));
                            }}
                        />
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
