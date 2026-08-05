import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { CircleNotchIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useEditorStore } from '~/lib/editorStore';
import { TEXT_BASE_STYLE } from '~/lib/textRenderConfig';

import TextEditorToolbar from './TextEditorToolbar';
import type { TextHydrationState } from './textHydrationState';

export function TextEditor({
    layerId,
    onMeasuredHeight,
    hydrationState,
    onRetryHydration
}: {
    layerId: number;
    onMeasuredHeight?: (height: number) => void;
    hydrationState: TextHydrationState;
    onRetryHydration: () => void;
}) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const layerMetrics = useEditorStore(
        useShallow((s) => {
            const layer = s.layers.get(layerId);
            if (!layer || layer.type !== 'text') {
                return { logicalWidth: 800, logicalHeight: 400, scaleX: 1, scaleY: 1 };
            }
            return {
                logicalWidth: layer.config.width,
                logicalHeight: layer.config.height,
                scaleX: layer.config.scaleX,
                scaleY: layer.config.scaleY
            };
        })
    );
    const [windowSize, setWindowSize] = useState({
        width: typeof window === 'undefined' ? 1920 : window.innerWidth,
        height: typeof window === 'undefined' ? 1080 : window.innerHeight
    });
    const logicalWidth = layerMetrics.logicalWidth;
    const logicalHeight = layerMetrics.logicalHeight;
    const layerScaleX = layerMetrics.scaleX;
    const layerScaleY = layerMetrics.scaleY;
    const safeWidth = Math.max(100, Math.round(logicalWidth));
    const safeHeight = Math.max(80, Math.round(logicalHeight));
    const safeScaleX = Math.max(0.05, layerScaleX);
    const safeScaleY = Math.max(0.05, layerScaleY);
    const maxUsableWidth = Math.max(320, windowSize.width - 160);
    const maxUsableHeight = Math.max(220, windowSize.height - 260);
    const fitScale = Math.min(
        1,
        maxUsableWidth / Math.max(1, safeWidth * safeScaleX),
        maxUsableHeight / Math.max(1, safeHeight * safeScaleY)
    );
    const effectiveScaleX = safeScaleX * fitScale;
    const effectiveScaleY = safeScaleY * fitScale;
    const viewportWidth = useMemo(
        () => Math.max(320, Math.ceil(safeWidth * effectiveScaleX)),
        [safeWidth, effectiveScaleX]
    );
    const viewportHeight = useMemo(
        () => Math.max(220, Math.ceil(safeHeight * effectiveScaleY)),
        [safeHeight, effectiveScaleY]
    );

    useEffect(() => {
        const onResize = () => {
            setWindowSize({
                width: window.innerWidth,
                height: window.innerHeight
            });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        if (!rootRef.current) return;
        const editorInput = rootRef.current.querySelector('.editor-input') as HTMLElement | null;
        if (!editorInput) return;

        const notify = () => {
            const measured = Math.max(40, Math.round(editorInput.scrollHeight));
            onMeasuredHeight?.(measured);
        };

        notify();
        const ro = new ResizeObserver(() => notify());
        ro.observe(editorInput);
        return () => ro.disconnect();
    }, [onMeasuredHeight, safeWidth, safeHeight]);

    const isSynced = hydrationState === 'synced';

    return (
        <div ref={rootRef} className="flex flex-col gap-4">
            {/* Formatting an unsynced document would be lost on hydrate. */}
            <div
                className={isSynced ? undefined : 'pointer-events-none opacity-50'}
                aria-disabled={!isSynced}
            >
                <TextEditorToolbar />
            </div>
            <div
                className="relative overflow-auto rounded-lg border border-border bg-black"
                style={{
                    width: `${viewportWidth}px`,
                    height: `${viewportHeight}px`
                }}
            >
                <div
                    style={{
                        width: `${safeWidth}px`,
                        height: `${safeHeight}px`,
                        transform: `scale(${effectiveScaleX}, ${effectiveScaleY})`,
                        transformOrigin: 'top left'
                    }}
                >
                    <RichTextPlugin
                        contentEditable={
                            <ContentEditable
                                className="editor-input h-full w-full outline-none"
                                style={{
                                    ...TEXT_BASE_STYLE
                                }}
                            />
                        }
                        ErrorBoundary={LexicalErrorBoundary}
                    />
                    {/* Focusing before sync would place the caret in content
                        that is about to be replaced. */}
                    {isSynced ? <AutoFocusPlugin /> : null}
                </div>
                {!isSynced && (
                    <div
                        className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 text-sm text-white"
                        aria-live="polite"
                        aria-busy={hydrationState === 'connecting'}
                    >
                        {hydrationState === 'error' ? (
                            <div className="flex flex-col items-center gap-3">
                                <span>Text could not be loaded.</span>
                                <button
                                    type="button"
                                    onClick={onRetryHydration}
                                    className="rounded-md border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <CircleNotchIcon className="size-4 animate-spin" />
                                <span>Loading text…</span>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
