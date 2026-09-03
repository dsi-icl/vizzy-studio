import { stageLayoutKey, type StageLayout } from '@repo/db/schema';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { wallLayoutTemplatesQueryOptions } from '~/server/projects.queries';

export interface WallLayoutPreset {
    wallId: string;
    name: string;
    layout: StageLayout;
}

const CUSTOM_OPTION = '__custom__';

const SELECT_CLASS =
    'h-8 w-full rounded-md border border-input bg-input/30 px-2 text-sm disabled:opacity-50';

function describeLayout(layout: StageLayout): string {
    return `${layout.columns}×${layout.rows} · ${layout.screenWidth}×${layout.screenHeight}px`;
}

interface WallPresetPickerProps {
    value: StageLayout | null;
    onChange: (layout: StageLayout | null, preset: WallLayoutPreset | null) => void;
    takenLayoutKeys?: ReadonlySet<string>;
    label?: string;
    idPrefix?: string;
    className?: string;
    disabled?: boolean;
}

export function WallPresetPicker({
    value,
    onChange,
    takenLayoutKeys,
    label = 'Wall',
    idPrefix = 'wall-preset',
    className,
    disabled = false
}: WallPresetPickerProps) {
    const { data: presets = [], isLoading } = useQuery(wallLayoutTemplatesQueryOptions());
    const matchedPreset = value
        ? presets.find((preset) => stageLayoutKey(preset.layout) === stageLayoutKey(value))
        : undefined;
    const [customOverride, setCustomOverride] = useState<boolean | null>(null);
    const presetsReady = !isLoading && presets.length > 0;
    const custom = customOverride ?? (presetsReady && Boolean(value) && !matchedPreset);

    const selectValue = custom ? CUSTOM_OPTION : (matchedPreset?.wallId ?? '');

    const handleSelect = (next: string) => {
        if (next === CUSTOM_OPTION) {
            setCustomOverride(true);
            onChange(value ?? presets[0]?.layout ?? null, null);
            return;
        }
        setCustomOverride(false);
        const preset = presets.find(({ wallId }) => wallId === next);
        onChange(preset ? preset.layout : null, preset ?? null);
    };

    const updateDimension = (key: keyof StageLayout, raw: string) => {
        if (!value) return;
        onChange({ ...value, [key]: Math.max(1, Number.parseInt(raw, 10) || 1) }, null);
    };

    if (!isLoading && presets.length === 0) {
        return (
            <div className={className}>
                <Label>{label}</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                    No wall templates are configured yet.
                </p>
                {value && (
                    <LayoutFields
                        idPrefix={idPrefix}
                        value={value}
                        onChange={updateDimension}
                        disabled={disabled}
                    />
                )}
            </div>
        );
    }

    return (
        <div className={className}>
            <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-select`}>{label}</Label>
                <select
                    id={`${idPrefix}-select`}
                    className={SELECT_CLASS}
                    value={selectValue}
                    disabled={isLoading || disabled}
                    onChange={(event) => handleSelect(event.target.value)}
                >
                    {selectValue === '' && (
                        <option value="">{isLoading ? 'Loading walls…' : 'Select a wall…'}</option>
                    )}
                    {presets.map((preset) => {
                        const taken = takenLayoutKeys?.has(stageLayoutKey(preset.layout)) ?? false;
                        return (
                            <option key={preset.wallId} value={preset.wallId} disabled={taken}>
                                {preset.name} ({describeLayout(preset.layout)})
                                {taken ? ' — stage exists' : ''}
                            </option>
                        );
                    })}
                    <option value={CUSTOM_OPTION}>Custom size</option>
                </select>
            </div>
            {custom && value && (
                <>
                    <LayoutFields
                        idPrefix={idPrefix}
                        value={value}
                        onChange={updateDimension}
                        disabled={disabled}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                        A custom size will not match any wall, so this content cannot be shown on
                        one until a wall is configured with the same grid.
                    </p>
                </>
            )}
        </div>
    );
}

function LayoutFields({
    idPrefix,
    value,
    onChange,
    disabled = false
}: {
    idPrefix: string;
    value: StageLayout;
    onChange: (key: keyof StageLayout, raw: string) => void;
    disabled?: boolean;
}) {
    const fields = [
        ['columns', 'Columns'],
        ['rows', 'Rows'],
        ['screenWidth', 'Screen width'],
        ['screenHeight', 'Screen height']
    ] as const;
    return (
        <div className="mt-3 grid grid-cols-2 gap-3">
            {fields.map(([key, fieldLabel]) => (
                <div key={key} className="space-y-1">
                    <Label htmlFor={`${idPrefix}-${key}`}>{fieldLabel}</Label>
                    <Input
                        id={`${idPrefix}-${key}`}
                        type="number"
                        min={1}
                        value={value[key]}
                        disabled={disabled}
                        onChange={(event) => onChange(key, event.target.value)}
                    />
                </div>
            ))}
        </div>
    );
}
