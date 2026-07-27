import { CaretDownIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import SideButtonNumberField from '@repo/ui/components/number-field';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@repo/ui/components/select';
import { throttle } from '@tanstack/pacer';
import { useCallback, useRef } from 'react';

import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import {
    DEFAULT_MAP_STYLE_ID,
    MAP_STYLE_OPTIONS,
    type LayerWithEditorState,
    type MapStyleId
} from '~/lib/types';

type MapViewField = keyof Extract<LayerWithEditorState, { type: 'map' }>['view'];

interface ParametersPanelProps {
    titleBarSize?: number;
    collapsed?: boolean;
    onCollapse?: () => void;
    onExpand?: () => void;
}

export function ParametersPanel({
    collapsed,
    onCollapse,
    onExpand,
    titleBarSize = 48
}: ParametersPanelProps) {
    const layers = useEditorStore((s) => s.layers);
    const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
    const markDirty = useEditorStore((s) => s.markDirty);

    const selectedLayer =
        selectedLayerIds.length === 1 ? (layers.get(parseInt(selectedLayerIds[0])) ?? null) : null;

    const toggleCollapse = () => {
        if (collapsed) onExpand?.();
        else onCollapse?.();
    };

    const throttledWebUrlUpdate = useRef(
        throttle(
            (layer: LayerWithEditorState) => {
                const engine = EditorEngine.getInstance();
                engine.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:parameters_web_url',
                    layer
                });
                markDirty();
            },
            { wait: 500 }
        )
    );
    const throttledConfigUpdate = useRef(
        throttle(
            (layer: LayerWithEditorState) => {
                const engine = EditorEngine.getInstance();
                engine.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:parameters',
                    layer
                });
                markDirty();
            },
            { wait: 100 }
        )
    );

    const updateWebProperty = useCallback(
        (field: 'url' | 'scale', value: string | number) => {
            if (!selectedLayer || selectedLayer.type !== 'web') return;
            const updatedLayer = { ...selectedLayer, [field]: value };

            useEditorStore.setState((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(selectedLayer.numericId, updatedLayer);
                return { layers: newLayers };
            });

            throttledWebUrlUpdate.current(updatedLayer);
        },
        [selectedLayer]
    );

    const updateConfig = useCallback(
        (field: keyof LayerWithEditorState['config'], value: number) => {
            if (!selectedLayer) return;
            const newConfig = { ...selectedLayer.config, [field]: value };
            const updatedLayer = { ...selectedLayer, config: newConfig };

            useEditorStore.setState((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(selectedLayer.numericId, updatedLayer);
                return { layers: newLayers };
            });

            throttledConfigUpdate.current(updatedLayer);
        },
        [selectedLayer]
    );

    const updateMapView = useCallback(
        (field: MapViewField, value: number) => {
            if (!selectedLayer || selectedLayer.type !== 'map') return;
            const updatedLayer = {
                ...selectedLayer,
                view: { ...selectedLayer.view, [field]: value }
            };

            useEditorStore.setState((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(selectedLayer.numericId, updatedLayer);
                return { layers: newLayers };
            });

            throttledConfigUpdate.current(updatedLayer);
        },
        [selectedLayer]
    );

    const updateMapStyle = useCallback(
        (value: MapStyleId) => {
            if (!selectedLayer || selectedLayer.type !== 'map') return;
            const updatedLayer = { ...selectedLayer, style: value };

            useEditorStore.setState((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(selectedLayer.numericId, updatedLayer);
                return { layers: newLayers };
            });

            throttledConfigUpdate.current(updatedLayer);
        },
        [selectedLayer]
    );

    const selectedLeftX = selectedLayer
        ? selectedLayer.config.cx - selectedLayer.config.width / 2
        : null;
    const selectedTopY = selectedLayer
        ? selectedLayer.config.cy - selectedLayer.config.height / 2
        : null;

    return (
        <div className="flex h-full flex-col overflow-hidden bg-muted/30">
            <button
                onClick={toggleCollapse}
                className="flex shrink-0 cursor-pointer items-center justify-between border-b border-border bg-muted/50 px-4"
                style={{ height: titleBarSize }}
            >
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <SlidersHorizontalIcon size={18} weight="bold" /> Parameters
                </h2>
                <CaretDownIcon
                    size={14}
                    weight="bold"
                    className={`text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-180'}`}
                />
            </button>

            {!collapsed && (
                <div className="flex-1 overflow-y-auto p-3">
                    {selectedLayer ? (
                        <div className="space-y-3">
                            <fieldset className="space-y-1.5">
                                {/* <legend className="text-xs font-semibold">Position</legend> */}
                                <div className="grid grid-cols-2 gap-2">
                                    <SideButtonNumberField
                                        label="X"
                                        className={'text-xs'}
                                        allowWheelScrub={true}
                                        value={selectedLeftX ?? 0}
                                        onValueChange={(v) => {
                                            if (v === null || !selectedLayer) return;
                                            updateConfig('cx', v + selectedLayer.config.width / 2);
                                        }}
                                    />
                                    <SideButtonNumberField
                                        label="Y"
                                        allowWheelScrub={true}
                                        value={selectedTopY ?? 0}
                                        onValueChange={(v) => {
                                            if (v === null || !selectedLayer) return;
                                            updateConfig('cy', v + selectedLayer.config.height / 2);
                                        }}
                                    />
                                </div>
                            </fieldset>

                            <fieldset className="space-y-1.5">
                                {/* <legend className="text-xs font-semibold">Size</legend> */}
                                <div className="grid grid-cols-2 gap-2">
                                    <SideButtonNumberField
                                        label="Width"
                                        allowWheelScrub={true}
                                        value={selectedLayer.config.width}
                                        onValueChange={(v) => {
                                            if (v !== null) updateConfig('width', v);
                                        }}
                                    />
                                    <SideButtonNumberField
                                        label="Height"
                                        allowWheelScrub={true}
                                        value={selectedLayer.config.height}
                                        onValueChange={(v) => {
                                            if (v !== null) updateConfig('height', v);
                                        }}
                                    />
                                </div>
                            </fieldset>

                            <fieldset className="space-y-1.5">
                                {/* <legend className="text-xs font-semibold">Transform</legend> */}
                                <div className="grid grid-cols-2 gap-2">
                                    <SideButtonNumberField
                                        label="Rotation"
                                        allowWheelScrub={true}
                                        value={selectedLayer.config.rotation}
                                        onValueChange={(v) => {
                                            if (v !== null) updateConfig('rotation', v);
                                        }}
                                    />
                                </div>
                            </fieldset>

                            {selectedLayer.type === 'web' && (
                                <>
                                    <fieldset className="space-y-1.5">
                                        <Label className="text-xs font-semibold">URL</Label>
                                        <Input
                                            type="url"
                                            placeholder="https://example.com"
                                            value={selectedLayer.url}
                                            onChange={(e) =>
                                                updateWebProperty('url', e.target.value)
                                            }
                                            className="text-xs"
                                        />
                                    </fieldset>
                                    <fieldset className="space-y-1.5">
                                        <div className="grid grid-cols-2 gap-2">
                                            <SideButtonNumberField
                                                label="Zoom"
                                                allowWheelScrub={true}
                                                step={0.1}
                                                smallStep={0.01}
                                                min={0.1}
                                                value={selectedLayer.scale}
                                                onValueChange={(v) => {
                                                    if (v !== null && v > 0)
                                                        updateWebProperty('scale', v);
                                                }}
                                            />
                                        </div>
                                    </fieldset>
                                </>
                            )}

                            {selectedLayer.type === 'map' && (
                                <fieldset className="space-y-1.5">
                                    <Label className="text-xs font-semibold">Map View</Label>
                                    <div className="grid grid-cols-2 gap-2">
                                        <SideButtonNumberField
                                            label="Longitude"
                                            allowWheelScrub={true}
                                            step={0.1}
                                            smallStep={0.01}
                                            min={-180}
                                            max={180}
                                            value={selectedLayer.view.longitude}
                                            onValueChange={(v) => {
                                                if (v !== null) updateMapView('longitude', v);
                                            }}
                                        />
                                        <SideButtonNumberField
                                            label="Latitude"
                                            allowWheelScrub={true}
                                            step={0.1}
                                            smallStep={0.01}
                                            min={-85.0511}
                                            max={85.0511}
                                            value={selectedLayer.view.latitude}
                                            onValueChange={(v) => {
                                                if (v !== null) updateMapView('latitude', v);
                                            }}
                                        />
                                        <SideButtonNumberField
                                            label="Zoom"
                                            allowWheelScrub={true}
                                            step={0.25}
                                            smallStep={0.1}
                                            min={0}
                                            max={20}
                                            value={selectedLayer.view.zoom}
                                            onValueChange={(v) => {
                                                if (v !== null) updateMapView('zoom', v);
                                            }}
                                        />
                                        <SideButtonNumberField
                                            label="Pitch"
                                            allowWheelScrub={true}
                                            step={1}
                                            smallStep={0.25}
                                            min={0}
                                            max={90}
                                            value={selectedLayer.view.pitch}
                                            onValueChange={(v) => {
                                                if (v !== null) updateMapView('pitch', v);
                                            }}
                                        />
                                        <SideButtonNumberField
                                            label="Bearing"
                                            allowWheelScrub={true}
                                            step={1}
                                            smallStep={0.25}
                                            min={0}
                                            max={360}
                                            value={selectedLayer.view.bearing}
                                            onValueChange={(v) => {
                                                if (v !== null) updateMapView('bearing', v);
                                            }}
                                        />
                                        <div className="flex flex-col items-start gap-1">
                                            <Label className="text-sm font-medium">Style</Label>
                                            <Select
                                                value={selectedLayer.style ?? DEFAULT_MAP_STYLE_ID}
                                                onValueChange={(value) =>
                                                    updateMapStyle(value as MapStyleId)
                                                }
                                            >
                                                <SelectTrigger className="w-44 border-border bg-transparent text-sm data-[size=default]:h-10 dark:bg-transparent">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent align="start">
                                                    {MAP_STYLE_OPTIONS.map((option) => (
                                                        <SelectItem
                                                            key={option.value}
                                                            value={option.value}
                                                        >
                                                            {option.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                </fieldset>
                            )}
                        </div>
                    ) : (
                        <p className="text-center text-xs text-muted-foreground">
                            Select a layer to edit its parameters
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
