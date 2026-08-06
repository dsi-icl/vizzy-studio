'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@repo/ui/components/dialog';
import { useRef } from 'react';

import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import { resizeHeightFromTopEdge } from '~/lib/textLayerGeometry';

import { CollaborativeEditor } from './editor/CollaborativeEditor';

interface TextEditorDialogProps {
    layerId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function TextEditorDialog({ layerId, open, onOpenChange }: TextEditorDialogProps) {
    const latestMeasuredHeightRef = useRef<number | null>(null);
    const openSyncDoneRef = useRef(false);
    const commitMeasuredHeight = (
        origin: 'editor:text_editor_open' | 'editor:text_editor_close',
        measured?: number
    ) => {
        if (typeof window === 'undefined') return;

        // Read through, rather than a subscription: the commit runs from a dialog
        // callback and needs the config as it stands at that moment.
        const liveLayer = useEditorStore.getState().layers.get(layerId);
        if (!liveLayer || liveLayer.type !== 'text') return;

        const contentHeight = Math.round(
            measured ?? latestMeasuredHeightRef.current ?? liveLayer.config.height
        );
        // Auto-height only ever grows: a box shorter than its content clips it,
        // but a box the author deliberately dragged taller is theirs to keep.
        const nextHeight = Math.max(40, liveLayer.config.height, contentHeight);
        if (Math.abs(nextHeight - liveLayer.config.height) <= 1) return;

        // Resizing a centre-anchored box has to move the centre, or the text —
        // which flows from the top — slides by half the growth.
        const updatedLayer = {
            ...liveLayer,
            config: resizeHeightFromTopEdge(liveLayer.config, nextHeight)
        };
        useEditorStore.getState().updateLayerConfig(liveLayer.numericId, updatedLayer.config);
        const engine = EditorEngine.getInstance();
        engine.sendJSON({
            type: 'upsert_layer',
            origin,
            layer: updatedLayer
        });
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    commitMeasuredHeight('editor:text_editor_close');
                    openSyncDoneRef.current = false;
                }
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent className="flex max-h-[95vh] max-w-fit flex-col gap-3 overflow-hidden p-4">
                <DialogTitle className="text-sm font-medium">Edit Text Layer</DialogTitle>
                <DialogDescription className="sr-only">Text Edit</DialogDescription>
                {open && (
                    <CollaborativeEditor
                        layerId={layerId}
                        onMeasuredHeight={(height) => {
                            latestMeasuredHeightRef.current = height;
                            if (open && !openSyncDoneRef.current) {
                                commitMeasuredHeight('editor:text_editor_open', height);
                                openSyncDoneRef.current = true;
                            }
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
