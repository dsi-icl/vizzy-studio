import { SlidersHorizontalIcon } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { TipButton } from '@repo/ui/components/tip-button';
import { useEffect, useRef, useState } from 'react';

import { useEditorStore } from '~/lib/editorStore';
import type { NetworkSettings } from '~/lib/network/schema';
import type { Layer } from '~/lib/types';

import { NetworkMotionSettings, NetworkPlaybackControls } from './NetworkSettingsControls';

export function NetworkLiveControls({ layer }: { layer: Extract<Layer, { type: 'graph' }> }) {
    const [local, setLocal] = useState<{ base: NetworkSettings; settings: NetworkSettings } | null>(
        null
    );
    const settings =
        local?.base === layer.network!.settings ? local.settings : layer.network!.settings;
    const pending = useRef<Partial<NetworkSettings>>({});
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const scope = useEditorStore((s) => `${s.projectId}/${s.commitId}/${s.activeSlideId}`);
    useEffect(() => () => clearTimeout(timer.current), []);
    const flush = (reheat = false) => {
        clearTimeout(timer.current);
        timer.current = undefined;
        const store = useEditorStore.getState();
        if (`${store.projectId}/${store.commitId}/${store.activeSlideId}` !== scope) return;
        const current = store.layers.get(layer.numericId);
        if (current?.type !== 'graph' || !current.network || current.config.locked) return;
        store.updateNetworkLayer(layer.numericId, {
            ...current.network,
            settings: { ...current.network.settings, ...pending.current },
            reheat: current.network.reheat + (reheat ? 1 : 0)
        });
        pending.current = {};
    };
    const change = (patch: Partial<NetworkSettings>, immediate = false, reheat = false) => {
        setLocal({ base: layer.network!.settings, settings: { ...settings, ...patch } });
        pending.current = { ...pending.current, ...patch };
        if (immediate) flush(reheat);
        else timer.current ??= setTimeout(() => flush(), 150);
    };
    return (
        <Popover>
            <PopoverTrigger
                render={
                    <TipButton tip="Live network controls" aria-label="Live network controls" />
                }
                disabled={!!layer.config.locked}
            >
                <SlidersHorizontalIcon />
            </PopoverTrigger>
            <PopoverContent className="w-80 gap-5 p-5" side="bottom" align="start">
                <div>
                    <p className="text-sm font-semibold">Network motion</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Same data. Shared motion across the wall.
                    </p>
                </div>
                <NetworkPlaybackControls
                    paused={settings.paused}
                    onPause={() => change({ paused: !settings.paused }, true)}
                    onNudge={() => change({ paused: false }, true, true)}
                />
                <NetworkMotionSettings settings={settings} onChange={change} />
            </PopoverContent>
        </Popover>
    );
}
