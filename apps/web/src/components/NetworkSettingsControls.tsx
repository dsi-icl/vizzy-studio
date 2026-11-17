import { PauseIcon, PlayIcon, ShuffleIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { useId } from 'react';

import type { NetworkSettings } from '~/lib/network/schema';

type SettingsProps = {
    settings: NetworkSettings;
    onChange: (patch: Partial<NetworkSettings>) => void;
};

function NetworkRange({
    label,
    value,
    min,
    max,
    step,
    onChange,
    display
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    display?: string;
}) {
    const id = useId();
    return (
        <div className="grid gap-2.5">
            <label htmlFor={id} className="flex items-center justify-between text-xs font-medium">
                {label}
                <span className="min-w-10 rounded-md bg-muted px-2 py-1 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {display ?? value}
                </span>
            </label>
            <input
                id={id}
                aria-label={label}
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="h-4 w-full cursor-pointer appearance-none rounded-full bg-transparent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-foreground [&::-moz-range-thumb]:bg-background [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-foreground [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow-sm"
            />
        </div>
    );
}

export function NetworkPlaybackControls({
    paused,
    onPause,
    onNudge
}: {
    paused: boolean;
    onPause: () => void;
    onNudge: () => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onPause}>
                {paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
                {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onNudge}>
                <ShuffleIcon />
                Nudge
            </Button>
        </div>
    );
}

export function NetworkMotionSettings({ settings, onChange }: SettingsProps) {
    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <NetworkRange
                    label="Random motion"
                    min={0}
                    max={2}
                    step={0.05}
                    value={settings.motionStrength}
                    display={`${Math.round(settings.motionStrength * 100)}%`}
                    onChange={(motionStrength) => onChange({ motionStrength })}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                    A gentle random push keeps existing nodes moving. Set to 0 to let the graph
                    settle.
                </p>
            </div>
            <div className="space-y-5 border-t pt-5">
                <p className="text-[11px] font-medium tracking-wide text-muted-foreground">
                    Layout
                </p>
                <NetworkRange
                    label="Link distance"
                    min={10}
                    max={300}
                    step={5}
                    value={settings.linkDistance}
                    onChange={(linkDistance) => onChange({ linkDistance })}
                />
                <NetworkRange
                    label="Repulsion"
                    min={-1000}
                    max={0}
                    step={10}
                    value={settings.charge}
                    onChange={(charge) => onChange({ charge })}
                />
            </div>
            <details className="group border-t pt-4">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                    More force settings
                </summary>
                <div className="mt-5 space-y-5">
                    <NetworkRange
                        label="Link strength"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.linkStrength}
                        onChange={(linkStrength) => onChange({ linkStrength })}
                    />
                    <NetworkRange
                        label="Collision spacing"
                        min={1}
                        max={80}
                        step={1}
                        value={settings.collisionRadius}
                        onChange={(collisionRadius) => onChange({ collisionRadius })}
                    />
                </div>
            </details>
        </div>
    );
}

function NetworkColour({
    label,
    value,
    onChange
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <label className="flex cursor-pointer items-center justify-between text-xs font-medium">
            {label}
            <span className="flex items-center gap-2 rounded-lg border px-2 py-1.5">
                <span
                    className="relative size-4 overflow-hidden rounded-full border"
                    style={{ background: value }}
                >
                    <input
                        aria-label={label}
                        type="color"
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                </span>
                <span className="font-mono text-[10px] font-normal text-muted-foreground">
                    {value.toUpperCase()}
                </span>
            </span>
        </label>
    );
}

export function NetworkStyleSettings({ settings, onChange }: SettingsProps) {
    return (
        <div className="space-y-5">
            <NetworkRange
                label="Node size"
                min={2}
                max={20}
                step={1}
                value={settings.nodeRadius}
                onChange={(nodeRadius) => onChange({ nodeRadius })}
            />
            <NetworkRange
                label="Line width"
                min={0.5}
                max={5}
                step={0.5}
                value={settings.edgeWidth}
                onChange={(edgeWidth) => onChange({ edgeWidth })}
            />
            <div className="space-y-3 border-t pt-5">
                <label className="flex items-center justify-between text-xs font-medium">
                    Colour nodes by group
                    <input
                        type="checkbox"
                        className="size-3.5 accent-foreground"
                        checked={settings.colorByGroup}
                        onChange={(event) => onChange({ colorByGroup: event.target.checked })}
                    />
                </label>
                {!settings.colorByGroup && (
                    <NetworkColour
                        label="Node colour"
                        value={settings.nodeColor}
                        onChange={(nodeColor) => onChange({ nodeColor })}
                    />
                )}
                <NetworkColour
                    label="Link colour"
                    value={settings.edgeColor}
                    onChange={(edgeColor) => onChange({ edgeColor })}
                />
            </div>
            <div className="space-y-3 border-t pt-5">
                <label className="flex items-center justify-between text-xs font-medium">
                    Show labels
                    <input
                        type="checkbox"
                        className="size-3.5 accent-foreground"
                        checked={settings.showLabels}
                        onChange={(event) => onChange({ showLabels: event.target.checked })}
                    />
                </label>
                {settings.showLabels && (
                    <NetworkColour
                        label="Label colour"
                        value={settings.labelColor}
                        onChange={(labelColor) => onChange({ labelColor })}
                    />
                )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
                Only nodes, links and optional labels are drawn. The layer has no background.
            </p>
        </div>
    );
}
