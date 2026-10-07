'use client';

import { Input } from '@repo/ui/components/input';
import { Slider } from '@repo/ui/components/slider';
import { debounce } from '@tanstack/pacer';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { ColorPickerPopover } from '~/components/ColourPicker';
import { EditorEngine } from '~/lib/editorEngine';
import { makeLayerPatch } from '~/lib/editorLayerChange';
import { useEditorStore } from '~/lib/editorStore';
import type { LayerWithEditorState } from '~/lib/types';

type BackgroundLayer = Extract<LayerWithEditorState, { type: 'background' }>;

interface BackgroundLayerPanelProps {
    activeLayer: BackgroundLayer;
}

export function BackgroundLayerPanel({ activeLayer }: BackgroundLayerPanelProps) {
    const draftLayerRef = useRef<BackgroundLayer>(activeLayer);
    const backgroundType = activeLayer.backgroundType ?? 'i-pattern';
    const isSolidBackground = backgroundType === 'solid';

    useEffect(() => {
        draftLayerRef.current = activeLayer;
    }, [activeLayer]);

    const applyBackgroundUpdate = useMemo(
        () =>
            debounce(
                (nextLayer: BackgroundLayer) => {
                    useEditorStore.getState().recordLayerChange({
                        patches: [
                            makeLayerPatch(
                                nextLayer.numericId,
                                useEditorStore.getState().layers.get(nextLayer.numericId) ?? null,
                                nextLayer
                            )
                        ],
                        mergeKey: `background:${nextLayer.numericId}`
                    });
                    useEditorStore.setState((s) => {
                        const newLayers = new Map(s.layers);
                        newLayers.set(nextLayer.numericId, nextLayer);
                        return { layers: newLayers };
                    });
                    EditorEngine.getInstance().sendJSON({
                        type: 'upsert_layer',
                        origin: 'editor:background_panel',
                        layer: nextLayer
                    });
                    useEditorStore.getState().markDirty();
                },
                { wait: 220 }
            ),
        []
    );

    const updateField = useCallback(
        <K extends keyof BackgroundLayer>(key: K, value: BackgroundLayer[K]) => {
            const updated = { ...draftLayerRef.current, [key]: value } as BackgroundLayer;
            draftLayerRef.current = updated;
            applyBackgroundUpdate(updated);
        },
        [applyBackgroundUpdate]
    );

    return (
        <>
            <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Background style</label>
                <select
                    value={backgroundType}
                    onChange={(e) =>
                        updateField(
                            'backgroundType',
                            e.target.value as BackgroundLayer['backgroundType']
                        )
                    }
                    className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                    <option value="solid">Solid</option>
                    <option value="i-pattern">I pattern</option>
                    <option value="waves">Waves</option>
                    <option value="particle">Particle</option>
                </select>
            </div>
            <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Background color</label>
                <ColorPickerPopover
                    tip="Background colour"
                    value={activeLayer.backgroundColor}
                    onChange={(v) => updateField('backgroundColor', v)}
                />
            </div>
            {!isSolidBackground ? (
                <>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Atmosphere color</label>
                        <ColorPickerPopover
                            tip="Atmosphere colour"
                            value={activeLayer.atmosphereColor}
                            onChange={(v) => updateField('atmosphereColor', v)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Motif color 1</label>
                        <ColorPickerPopover
                            tip="Motif colour 1"
                            value={activeLayer.motifColor1}
                            onChange={(v) => updateField('motifColor1', v)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Motif color 2</label>
                        <ColorPickerPopover
                            tip="Motif colour 2"
                            value={activeLayer.motifColor2}
                            onChange={(v) => updateField('motifColor2', v)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Seed</label>
                        <Input
                            type="number"
                            min={0}
                            max={9999}
                            value={activeLayer.noiseSeed}
                            onChange={(e) =>
                                updateField('noiseSeed', parseInt(e.target.value) || 0)
                            }
                            className="h-7 w-20 text-xs"
                            placeholder="Seed"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                            Speed ({activeLayer.speedFactor.toFixed(1)}×)
                        </label>
                        <Slider
                            value={[activeLayer.speedFactor]}
                            min={0}
                            max={20}
                            step={0.1}
                            onValueChange={(v) => {
                                const next = Array.isArray(v) ? (v[0] ?? 1) : v;
                                updateField('speedFactor', next);
                            }}
                        />
                    </div>
                </>
            ) : null}
        </>
    );
}
