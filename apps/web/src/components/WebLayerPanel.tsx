import {
    CameraIcon,
    CircleNotchIcon,
    LightningIcon,
    LightningSlashIcon
} from '@phosphor-icons/react';
import { Input } from '@repo/ui/components/input';
import { TipButton } from '@repo/ui/components/tip-button';
import { throttle } from '@tanstack/pacer';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import type { LayerWithEditorState } from '~/lib/types';

interface WebLayerPanelProps {
    activeLayer: Extract<LayerWithEditorState, { type: 'web' }>;
    projectId: string;
}

export function WebLayerPanel({ activeLayer, projectId }: WebLayerPanelProps) {
    const [webUrl, setWebUrl] = useState(activeLayer.url);
    const [isCapturing, setIsCapturing] = useState(false);

    // Keep local webUrl in sync when selection changes to a different web layer
    if (webUrl !== activeLayer.url && !isCapturing) {
        setWebUrl(activeLayer.url);
    }

    const throttledWebUrlBroadcast = useRef(
        throttle(
            (layer: LayerWithEditorState) => {
                const engine = EditorEngine.getInstance();
                engine.sendJSON({ type: 'upsert_layer', origin: 'editor:toolbar_web_url', layer });
                useEditorStore.getState().markDirty();
            },
            { wait: 500 }
        )
    );

    const handleWebUrlChange = useCallback(
        (value: string) => {
            setWebUrl(value);
            const updatedLayer = { ...activeLayer, url: value };
            useEditorStore.setState((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(activeLayer.numericId, updatedLayer);
                return { layers: newLayers };
            });
            throttledWebUrlBroadcast.current(updatedLayer);
        },
        [activeLayer]
    );

    const handleWebProxyToggle = useCallback(() => {
        const updatedLayer = { ...activeLayer, proxy: !activeLayer.proxy };
        useEditorStore.getState().upsertLayer(updatedLayer);
        const engine = EditorEngine.getInstance();
        engine.sendJSON({
            type: 'upsert_layer',
            origin: 'editor:toolbar_web_proxy_toggle',
            layer: updatedLayer
        });
        useEditorStore.getState().markDirty();
    }, [activeLayer]);

    const captureScreenshot = useCallback(async () => {
        if (!activeLayer.url) return;
        setIsCapturing(true);
        try {
            const res = await fetch('/api/web-screenshot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId,
                    url: activeLayer.url,
                    width: activeLayer.config.width,
                    height: activeLayer.config.height,
                    scale: activeLayer.scale,
                    previousBaseId: activeLayer.stillImage
                        ? activeLayer.stillImage.replace(/\.[^.]+$/, '')
                        : undefined
                })
            });
            if (!res.ok) {
                const payload = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(payload?.error || `Screenshot capture failed (${res.status})`);
            }
            const { filename, blurhash, sizes } = await res.json();
            const updatedLayer = {
                ...activeLayer,
                stillImage: filename,
                stillImageSizes: Array.isArray(sizes) ? sizes : undefined,
                blurhash: blurhash ?? undefined
            };
            useEditorStore.getState().upsertLayer(updatedLayer);
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:capture_screenshot',
                layer: updatedLayer
            });
            useEditorStore.getState().markDirty();
            toast.success('Screenshot captured');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to capture screenshot');
        } finally {
            setIsCapturing(false);
        }
    }, [activeLayer, projectId]);

    return (
        <>
            <Input
                type="url"
                placeholder="https://example.com"
                value={webUrl}
                onChange={(e) => handleWebUrlChange(e.target.value)}
                className="h-7 min-w-48 flex-1 text-xs"
            />
            <TipButton
                tip={activeLayer.proxy ? 'Disable Proxy' : 'Enable Proxy'}
                aria-label={activeLayer.proxy ? 'Disable proxy' : 'Enable proxy'}
                variant={activeLayer.proxy ? 'outline' : 'ghost'}
                onClick={handleWebProxyToggle}
            >
                {activeLayer.proxy ? <LightningIcon /> : <LightningSlashIcon />}
            </TipButton>
            <TipButton
                tip={activeLayer.url ? 'Capture screenshot' : 'Set a URL first'}
                aria-label="Capture screenshot"
                onClick={captureScreenshot}
                disabled={!activeLayer.url || isCapturing}
            >
                {isCapturing ? <CircleNotchIcon className="animate-spin" /> : <CameraIcon />}
            </TipButton>
        </>
    );
}
