import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
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

/**
 * How tall the document actually is, in layer pixels.
 *
 * `scrollHeight` cannot answer this: the content editable is stretched to fill
 * the layer box, so it never reports less than the box it sits in. Block
 * children are measured instead, through `offsetTop`/`offsetHeight` rather than
 * bounding rects — the editor renders under a CSS scale that rects would fold
 * into the number, while offsets stay in layout pixels.
 */
function measureDocumentHeight(editorInput: HTMLElement): number {
    const styles = window.getComputedStyle(editorInput);
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;

    let contentBottom = 0;
    let measuredAny = false;
    for (const child of Array.from(editorInput.children)) {
        if (!(child instanceof HTMLElement)) continue;
        // `offsetTop` already carries the container's top padding and every
        // preceding sibling's margin; only the trailing margin is left to add.
        const marginBottom = Number.parseFloat(window.getComputedStyle(child).marginBottom) || 0;
        contentBottom = Math.max(
            contentBottom,
            child.offsetTop + child.offsetHeight + marginBottom
        );
        measuredAny = true;
    }

    if (!measuredAny) return Math.round(editorInput.scrollHeight);
    return Math.round(contentBottom + paddingBottom);
}

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
    const [editor] = useLexicalComposerContext();
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
            onMeasuredHeight?.(Math.max(40, measureDocumentHeight(editorInput)));
        };

        notify();
        // Two triggers, because neither covers the other: the input is stretched
        // to the box, so typing never resizes it and the observer stays silent,
        // while a box that changes width reflows the document without an edit.
        const unregisterUpdates = editor.registerUpdateListener(() => notify());
        const ro = new ResizeObserver(() => notify());
        ro.observe(editorInput);
        return () => {
            unregisterUpdates();
            ro.disconnect();
        };
    }, [editor, onMeasuredHeight, safeWidth, safeHeight]);

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
