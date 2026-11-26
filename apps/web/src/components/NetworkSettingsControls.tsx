import { PauseIcon, PlayIcon, QuestionIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@repo/ui/components/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
import { useId, useState } from 'react';

import type { FontAsset } from '~/hooks/useFonts';
import {
    DEFAULT_FONT_OPTION_ID,
    getFontFamilyCss,
    SYSTEM_FONT_OPTIONS
} from '~/lib/fontFamilyOptions';
import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from '~/lib/network/schema';

type SettingsProps = {
    settings: NetworkSettings;
    onChange: (patch: Partial<NetworkSettings>) => void;
};

function NetworkRangeHelp({ label, help }: { label: string; help: string }) {
    const triggerId = useId();
    const [open, setOpen] = useState(false);
    return (
        <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
            <TooltipTrigger
                id={triggerId}
                delay={0}
                closeOnClick={false}
                onClick={() => setOpen(true)}
                render={
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Help: ${label}`}
                        className="size-5 rounded-full text-muted-foreground hover:text-foreground"
                    />
                }
            >
                <QuestionIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent role="tooltip" side="left" className="max-w-56 leading-relaxed">
                {help}
            </TooltipContent>
        </Tooltip>
    );
}

function NetworkRange({
    label,
    value,
    min,
    max,
    step,
    onChange,
    display,
    help
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    display?: string;
    help?: string;
}) {
    const id = useId();
    return (
        <div className="grid gap-2.5">
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
                <div className="flex min-w-0 items-center gap-1">
                    <label htmlFor={id}>{label}</label>
                    {help && <NetworkRangeHelp label={label} help={help} />}
                </div>
                <span className="min-w-10 rounded-md bg-muted px-2 py-1 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {display ?? value}
                </span>
            </div>
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
    onPause
}: {
    paused: boolean;
    onPause: () => void;
}) {
    return (
        <Button variant="outline" size="sm" onClick={onPause}>
            {paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
            {paused ? 'Resume' : 'Pause'}
        </Button>
    );
}

export function NetworkMotionSettings({ settings, onChange }: SettingsProps) {
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
                help="Sets the base width. Matrix links become thicker as their strength rises from 0 to 5; positive and negative strengths use the same width."
                min={0.5}
                max={5}
                step={0.5}
                value={settings.edgeWidth}
                onChange={(edgeWidth) => onChange({ edgeWidth })}
            />
            <NetworkRange
                label="Random motion"
                help="Adds a gentle random push to keep nodes moving. Set to 0 to let the network settle."
                min={0}
                max={2}
                step={0.05}
                value={settings.motionStrength}
                display={`${Math.round(settings.motionStrength * 100)}%`}
                onChange={(motionStrength) => onChange({ motionStrength })}
            />
            <NetworkRange
                label="Link distance"
                help="Sets the preferred distance between linked nodes. The visible length can differ as other forces act on them."
                min={10}
                max={300}
                step={5}
                value={settings.linkDistance}
                onChange={(linkDistance) => onChange({ linkDistance })}
            />
            <NetworkRange
                label="Repulsion"
                help="Controls how strongly nodes push apart. More negative values spread the network wider."
                min={-1000}
                max={0}
                step={10}
                value={settings.charge}
                onChange={(charge) => onChange({ charge })}
            />
            <NetworkRange
                label="Link strength"
                help="Controls how firmly links push or pull nodes toward the Link distance target. Changing this can alter their visible length without changing that target."
                min={0}
                max={1}
                step={0.05}
                value={settings.linkStrength}
                onChange={(linkStrength) => onChange({ linkStrength })}
            />
            <NetworkRange
                label="Collision spacing"
                help="Sets the space around each node so nearby nodes overlap less."
                min={1}
                max={80}
                step={1}
                value={settings.collisionRadius}
                onChange={(collisionRadius) => onChange({ collisionRadius })}
            />
            <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                    onChange({
                        motionStrength: DEFAULT_NETWORK_SETTINGS.motionStrength,
                        linkDistance: DEFAULT_NETWORK_SETTINGS.linkDistance,
                        charge: DEFAULT_NETWORK_SETTINGS.charge,
                        linkStrength: DEFAULT_NETWORK_SETTINGS.linkStrength,
                        collisionRadius: DEFAULT_NETWORK_SETTINGS.collisionRadius,
                        nodeRadius: DEFAULT_NETWORK_SETTINGS.nodeRadius,
                        edgeWidth: DEFAULT_NETWORK_SETTINGS.edgeWidth
                    })
                }
            >
                Reset to default
            </Button>
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

export function NetworkStyleSettings({
    settings,
    onChange,
    groups,
    projectFonts,
    hasRelationshipLinks,
    hasOtherLinks
}: SettingsProps & {
    groups: string[];
    projectFonts: FontAsset[];
    hasRelationshipLinks: boolean;
    hasOtherLinks: boolean;
}) {
    const labelMode = !settings.showLabels
        ? 'none'
        : settings.labelGroup === undefined
          ? 'all'
          : `group:${settings.labelGroup}`;
    const fontOptions = [
        ...projectFonts.map((font) => ({ id: `project:${font.family}`, label: font.family })),
        ...SYSTEM_FONT_OPTIONS
    ];
    return (
        <div className="space-y-5">
            <div className="space-y-3">
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
                {hasRelationshipLinks ? (
                    <div className="space-y-3 border-t pt-4">
                        <p className="text-xs font-medium">Link colours by relationship</p>
                        <NetworkColour
                            label="Positive links"
                            value={settings.relationshipColors.positive}
                            onChange={(positive) =>
                                onChange({
                                    relationshipColors: { ...settings.relationshipColors, positive }
                                })
                            }
                        />
                        <NetworkColour
                            label="Negative links"
                            value={settings.relationshipColors.negative}
                            onChange={(negative) =>
                                onChange({
                                    relationshipColors: { ...settings.relationshipColors, negative }
                                })
                            }
                        />
                        <NetworkColour
                            label="Neutral links (0)"
                            value={settings.relationshipColors.neutral}
                            onChange={(neutral) =>
                                onChange({
                                    relationshipColors: { ...settings.relationshipColors, neutral }
                                })
                            }
                        />
                        {hasOtherLinks && (
                            <NetworkColour
                                label="Other links"
                                value={settings.edgeColor}
                                onChange={(edgeColor) => onChange({ edgeColor })}
                            />
                        )}
                    </div>
                ) : (
                    <NetworkColour
                        label="Link colour"
                        value={settings.edgeColor}
                        onChange={(edgeColor) => onChange({ edgeColor })}
                    />
                )}
            </div>
            <div className="space-y-3 border-t pt-5">
                <div className="grid gap-1.5 text-xs font-medium">
                    <span>Show labels</span>
                    <Select
                        value={labelMode}
                        onValueChange={(value) => {
                            if (!value) return;
                            onChange(
                                value === 'none'
                                    ? { showLabels: false }
                                    : value === 'all'
                                      ? { showLabels: true, labelGroup: undefined }
                                      : {
                                            showLabels: true,
                                            labelGroup: value.slice('group:'.length)
                                        }
                            );
                        }}
                    >
                        <SelectTrigger
                            aria-label="Show labels"
                            className="h-9 w-full bg-background"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start" className="max-h-60">
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="all">All nodes</SelectItem>
                            {groups.map((group) => (
                                <SelectItem key={group} value={`group:${group}`}>
                                    {group || 'Ungrouped'}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {settings.showLabels && (
                    <>
                        <NetworkColour
                            label="Label colour"
                            value={settings.labelColor}
                            onChange={(labelColor) => onChange({ labelColor })}
                        />
                        <div className="grid gap-1.5 text-xs font-medium">
                            <span>Label font</span>
                            <Select
                                value={settings.labelFontFamily ?? DEFAULT_FONT_OPTION_ID}
                                onValueChange={(value) => {
                                    if (value) onChange({ labelFontFamily: value });
                                }}
                            >
                                <SelectTrigger
                                    aria-label="Label font"
                                    className="h-9 w-full bg-background"
                                    style={{
                                        fontFamily: getFontFamilyCss(
                                            settings.labelFontFamily ?? DEFAULT_FONT_OPTION_ID
                                        )
                                    }}
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent align="start" className="max-h-60">
                                    {fontOptions.map((option) => (
                                        <SelectItem
                                            key={option.id}
                                            value={option.id}
                                            style={{ fontFamily: getFontFamilyCss(option.id) }}
                                        >
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <NetworkRange
                            label="Label size"
                            min={8}
                            max={48}
                            step={1}
                            value={settings.labelFontSize ?? 14}
                            onChange={(labelFontSize) => onChange({ labelFontSize })}
                        />
                    </>
                )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
                Set a node type in Custom to filter labels here.
            </p>
        </div>
    );
}
