import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Slider } from '@repo/ui/components/slider';
import { TipButton } from '@repo/ui/components/tip-button';
import { Throttler } from '@tanstack/pacer';
import { useEffect, useMemo, useState } from 'react';
import { Layer, Stage } from 'react-konva';
import { useShallow } from 'zustand/react/shallow';

import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import { getShapeEffectSettings } from '~/lib/shapeEffects';
import type { ShapeEffect, ShapeEffectSettings } from '~/lib/types';

import { EffectLine, EffectRect } from './AnimatedKonvaShape';
import { ColorPickerPopover } from './ColourPicker';
import { RectangleCornerRadiusTool } from './RectangleCornerRadiusTool';
import { StrokeTool } from './StrokeTool';

const EFFECT_OPTIONS = [
    { value: 'none', label: 'None' },
    { value: 'pulse', label: 'Pulse' },
    { value: 'focus', label: 'Focus' },
    { value: 'ping', label: 'Ping' },
    { value: 'travel', label: 'Travel' },
    { value: 'reveal', label: 'Reveal' }
] as const satisfies ReadonlyArray<{ value: ShapeEffect; label: string }>;
const getEditorTime = () => EditorEngine.getInstance().getServerTime();

export function AppearanceToolbar({
    showShapeFill,
    showShapeEffect,
    effectTarget = 'shape',
    showRectangleCornerRadius,
    shapeEffect,
    shapeEffectSettings
}: {
    showShapeFill: boolean;
    showShapeEffect: boolean;
    effectTarget?: 'shape' | 'line';
    showRectangleCornerRadius: boolean;
    shapeEffect?: ShapeEffect;
    shapeEffectSettings?: ShapeEffectSettings;
}) {
    const {
        shapeFill,
        setShapeFill,
        strokeColor,
        setStrokeColor,
        strokeWidth,
        setStrokeWidth,
        strokeDash,
        setStrokeDash,
        rectangleCornerRadius,
        setRectangleCornerRadius,
        selectedLayerId,
        setShapeEffect,
        setShapeEffectSettings
    } = useEditorStore(
        useShallow((s) => ({
            shapeFill: s.shapeFill,
            setShapeFill: s.setShapeFill,
            strokeColor: s.strokeColor,
            setStrokeColor: s.setStrokeColor,
            strokeWidth: s.strokeWidth,
            setStrokeWidth: s.setStrokeWidth,
            strokeDash: s.strokeDash,
            setStrokeDash: s.setStrokeDash,
            rectangleCornerRadius: s.rectangleCornerRadius,
            setRectangleCornerRadius: s.setRectangleCornerRadius,
            selectedLayerId: s.selectedLayerIds[0],
            setShapeEffect: s.setShapeEffect,
            setShapeEffectSettings: s.setShapeEffectSettings
        }))
    );
    const activeEffect = shapeEffect ?? 'none';
    const [hoverEffect, setHoverEffect] = useState<ShapeEffect | null>(null);
    const [draftSettings, setDraftSettings] = useState<Partial<ShapeEffectSettings> | null>(null);
    const availableEffects =
        effectTarget === 'line'
            ? EFFECT_OPTIONS.filter(
                  (option) => option.value === 'none' || option.value === 'travel'
              )
            : EFFECT_OPTIONS;
    const settingsThrottler = useMemo(
        () =>
            new Throttler(
                (layerId: string | undefined, update: Partial<ShapeEffectSettings>) => {
                    if (useEditorStore.getState().selectedLayerIds[0] === layerId) {
                        useEditorStore.getState().setShapeEffectSettings(update);
                    }
                },
                { wait: 50 }
            ),
        []
    );
    useEffect(() => () => settingsThrottler.cancel(), [settingsThrottler]);
    const previewEffect = hoverEffect ?? activeEffect;
    const settings = {
        ...getShapeEffectSettings(shapeEffectSettings),
        ...draftSettings
    };
    const changeSlider = (update: Partial<ShapeEffectSettings>) => {
        setDraftSettings((current) => ({ ...current, ...update }));
        settingsThrottler.maybeExecute(selectedLayerId, update);
    };
    const commitSettings = (update: Partial<ShapeEffectSettings>) => {
        settingsThrottler.flush();
        setShapeEffectSettings(update);
        setDraftSettings(null);
    };
    const sliderValue = (value: number | readonly number[]) =>
        Array.isArray(value) ? (value[0] ?? 0) : value;
    const commitNumber = (
        input: HTMLInputElement,
        current: number,
        min: number,
        max: number,
        update: (value: number) => void
    ) => {
        const parsed = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(parsed)) {
            input.value = String(current);
            return;
        }
        update(Math.min(max, Math.max(min, parsed)));
    };

    return (
        <div className="flex items-center gap-2">
            {showShapeFill ? (
                <ColorPickerPopover value={shapeFill} onChange={setShapeFill} tip="Fill" />
            ) : null}
            <StrokeTool
                strokeColor={strokeColor}
                setStrokeColor={setStrokeColor}
                strokeWidth={strokeWidth}
                setStrokeWidth={setStrokeWidth}
                strokeDash={strokeDash}
                setStrokeDash={setStrokeDash}
            />
            {showShapeEffect ? (
                <Popover
                    onOpenChange={(open) => {
                        setHoverEffect(null);
                        if (!open) {
                            settingsThrottler.flush();
                            setDraftSettings(null);
                        }
                    }}
                >
                    <PopoverTrigger nativeButton={false} render={<div />}>
                        <TipButton
                            tip="Layer effect"
                            aria-label="Layer effect"
                            variant="outline"
                            size="sm"
                        >
                            Effect:{' '}
                            {availableEffects.find((option) => option.value === activeEffect)
                                ?.label ?? 'None'}
                        </TipButton>
                    </PopoverTrigger>
                    <PopoverContent
                        className="max-h-[75vh] w-80 space-y-3 overflow-y-auto p-3"
                        side="bottom"
                        align="start"
                    >
                        <div className="rounded-md border border-border bg-slate-950 p-2 text-center">
                            <span className="mb-1 block text-[10px] text-slate-300">
                                Preview ·{' '}
                                {
                                    availableEffects.find(
                                        (option) => option.value === previewEffect
                                    )?.label
                                }
                            </span>
                            <Stage width={260} height={92} className="mx-auto">
                                <Layer>
                                    {effectTarget === 'line' ? (
                                        <EffectLine
                                            key={previewEffect}
                                            effect={previewEffect}
                                            effectSettings={{ ...settings, playMode: 'loop' }}
                                            getTimeMs={getEditorTime}
                                            points={[32, 62, 92, 28, 158, 62, 228, 30]}
                                            stroke={strokeColor}
                                            strokeWidth={Math.max(2, Math.min(6, strokeWidth))}
                                            dash={strokeDash}
                                            listening={false}
                                        />
                                    ) : (
                                        <EffectRect
                                            key={previewEffect}
                                            effect={previewEffect}
                                            effectSettings={{ ...settings, playMode: 'loop' }}
                                            getTimeMs={getEditorTime}
                                            x={130}
                                            y={46}
                                            width={96}
                                            height={48}
                                            offsetX={48}
                                            offsetY={24}
                                            cornerRadius={12}
                                            fill={shapeFill}
                                            stroke={strokeColor}
                                            strokeWidth={Math.max(2, Math.min(6, strokeWidth))}
                                            dash={strokeDash}
                                            listening={false}
                                        />
                                    )}
                                </Layer>
                            </Stage>
                        </div>
                        <div onMouseLeave={() => setHoverEffect(null)}>
                            <fieldset className="grid grid-cols-3 gap-1" aria-label="Layer effect">
                                {availableEffects.map((option) => (
                                    <Button
                                        key={option.value}
                                        size="sm"
                                        variant={
                                            activeEffect === option.value ? 'secondary' : 'ghost'
                                        }
                                        aria-pressed={activeEffect === option.value}
                                        onPointerEnter={() => setHoverEffect(option.value)}
                                        onClick={() => {
                                            settingsThrottler.flush();
                                            setDraftSettings(null);
                                            setShapeEffect(option.value);
                                        }}
                                    >
                                        {option.label}
                                    </Button>
                                ))}
                            </fieldset>
                        </div>
                        {activeEffect !== 'none' ? (
                            <div className="space-y-3 border-t border-border pt-3">
                                <div className="space-y-2 text-xs text-muted-foreground">
                                    <div className="flex items-center justify-between gap-3">
                                        <span>Speed</span>
                                        <div className="flex items-center gap-1">
                                            <Input
                                                key={`speed-${settings.speed}`}
                                                aria-label="Effect speed"
                                                type="number"
                                                min={0.25}
                                                max={3}
                                                step={0.05}
                                                defaultValue={settings.speed}
                                                className="h-7 w-18 text-right text-xs"
                                                onBlur={(event) =>
                                                    commitNumber(
                                                        event.currentTarget,
                                                        settings.speed,
                                                        0.25,
                                                        3,
                                                        (speed) => commitSettings({ speed })
                                                    )
                                                }
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter')
                                                        event.currentTarget.blur();
                                                }}
                                            />
                                            <span>×</span>
                                        </div>
                                    </div>
                                    <Slider
                                        aria-label="Effect speed slider"
                                        value={[settings.speed]}
                                        min={0.25}
                                        max={3}
                                        step={0.05}
                                        onValueChange={(value) =>
                                            changeSlider({ speed: sliderValue(value) })
                                        }
                                        onValueCommitted={(value) =>
                                            commitSettings({ speed: sliderValue(value) })
                                        }
                                    />
                                </div>
                                {activeEffect === 'pulse' ||
                                activeEffect === 'focus' ||
                                activeEffect === 'ping' ||
                                activeEffect === 'travel' ? (
                                    <div className="space-y-2 text-xs text-muted-foreground">
                                        <div className="flex items-center justify-between gap-3">
                                            <span>
                                                {activeEffect === 'pulse'
                                                    ? 'Size'
                                                    : activeEffect === 'ping'
                                                      ? 'Reach'
                                                      : activeEffect === 'travel'
                                                        ? 'Brightness'
                                                        : 'Emphasis'}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <Input
                                                    key={`intensity-${settings.intensity}`}
                                                    aria-label="Effect intensity"
                                                    type="number"
                                                    min={0}
                                                    max={200}
                                                    step={5}
                                                    defaultValue={settings.intensity}
                                                    className="h-7 w-18 text-right text-xs"
                                                    onBlur={(event) =>
                                                        commitNumber(
                                                            event.currentTarget,
                                                            settings.intensity,
                                                            0,
                                                            200,
                                                            (intensity) =>
                                                                commitSettings({ intensity })
                                                        )
                                                    }
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter')
                                                            event.currentTarget.blur();
                                                    }}
                                                />
                                                <span>%</span>
                                            </div>
                                        </div>
                                        <Slider
                                            aria-label="Effect intensity slider"
                                            value={[settings.intensity]}
                                            min={0}
                                            max={200}
                                            step={5}
                                            onValueChange={(value) =>
                                                changeSlider({
                                                    intensity: sliderValue(value)
                                                })
                                            }
                                            onValueCommitted={(value) =>
                                                commitSettings({ intensity: sliderValue(value) })
                                            }
                                        />
                                    </div>
                                ) : null}
                                {activeEffect === 'ping' ? (
                                    <div className="space-y-2 text-xs text-muted-foreground">
                                        <div className="flex justify-between">
                                            <span>Rings</span>
                                            <span>{settings.ringCount}</span>
                                        </div>
                                        <Slider
                                            aria-label="Ping rings"
                                            value={[settings.ringCount]}
                                            min={1}
                                            max={3}
                                            step={1}
                                            onValueChange={(value) =>
                                                changeSlider({ ringCount: sliderValue(value) })
                                            }
                                            onValueCommitted={(value) =>
                                                commitSettings({ ringCount: sliderValue(value) })
                                            }
                                        />
                                    </div>
                                ) : null}
                                {activeEffect === 'travel' ? (
                                    <div className="space-y-2 text-xs text-muted-foreground">
                                        <div className="flex justify-between">
                                            <span>Segment length</span>
                                            <span>{settings.segmentLength}%</span>
                                        </div>
                                        <Slider
                                            aria-label="Travel segment length"
                                            value={[settings.segmentLength]}
                                            min={5}
                                            max={45}
                                            step={1}
                                            onValueChange={(value) =>
                                                changeSlider({ segmentLength: sliderValue(value) })
                                            }
                                            onValueCommitted={(value) =>
                                                commitSettings({
                                                    segmentLength: sliderValue(value)
                                                })
                                            }
                                        />
                                    </div>
                                ) : null}
                                {activeEffect === 'travel' || activeEffect === 'reveal' ? (
                                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>Direction</span>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                commitSettings({
                                                    direction:
                                                        settings.direction === 'forward'
                                                            ? 'reverse'
                                                            : 'forward'
                                                })
                                            }
                                        >
                                            {settings.direction === 'forward'
                                                ? 'Forward'
                                                : 'Reverse'}
                                        </Button>
                                    </div>
                                ) : null}
                                {activeEffect !== 'pulse' ? (
                                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>Accent colour</span>
                                        <ColorPickerPopover
                                            value={settings.accentColor}
                                            onChange={(accentColor) =>
                                                commitSettings({ accentColor })
                                            }
                                            tip="Effect colour"
                                        />
                                    </div>
                                ) : null}
                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                    <span>Playback</span>
                                    <div className="flex gap-1">
                                        <Button
                                            size="sm"
                                            variant={
                                                settings.playMode === 'loop' ? 'secondary' : 'ghost'
                                            }
                                            onClick={() => commitSettings({ playMode: 'loop' })}
                                        >
                                            Loop
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant={
                                                settings.playMode === 'once' ? 'secondary' : 'ghost'
                                            }
                                            onClick={() =>
                                                commitSettings({
                                                    playMode: 'once',
                                                    startAtMs: getEditorTime()
                                                })
                                            }
                                        >
                                            Once
                                        </Button>
                                        {settings.playMode === 'once' ? (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    commitSettings({ startAtMs: getEditorTime() })
                                                }
                                            >
                                                Replay
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                                {settings.playMode === 'loop' ? (
                                    <div className="space-y-2 text-xs text-muted-foreground">
                                        <div className="flex justify-between">
                                            <span>Stagger</span>
                                            <span>
                                                {(settings.phaseOffsetMs / 1000).toFixed(1)}s
                                            </span>
                                        </div>
                                        <Slider
                                            aria-label="Effect stagger"
                                            value={[settings.phaseOffsetMs]}
                                            min={0}
                                            max={5000}
                                            step={100}
                                            onValueChange={(value) =>
                                                changeSlider({ phaseOffsetMs: sliderValue(value) })
                                            }
                                            onValueCommitted={(value) =>
                                                commitSettings({
                                                    phaseOffsetMs: sliderValue(value)
                                                })
                                            }
                                        />
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </PopoverContent>
                </Popover>
            ) : null}
            {showRectangleCornerRadius ? (
                <RectangleCornerRadiusTool
                    cornerRadius={rectangleCornerRadius}
                    setCornerRadius={setRectangleCornerRadius}
                />
            ) : null}
        </div>
    );
}
