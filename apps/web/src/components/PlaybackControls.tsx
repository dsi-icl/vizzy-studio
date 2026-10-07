'use client';

import { PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
import { useEffect, useState } from 'react';

import type { EditorEngine } from '~/lib/editorEngine';
import { makeLayerPatch } from '~/lib/editorLayerChange';
import { useEditorStore } from '~/lib/editorStore';
import type { LayerWithEditorState } from '~/lib/types';

export function PlaybackControls({
    layer,
    engine
}: {
    layer: Extract<LayerWithEditorState, { type: 'video' }>;
    engine: EditorEngine;
}) {
    const [status, setStatus] = useState(engine.getPlayback(layer.numericId)?.status || 'paused');

    useEffect(() => {
        const unsubscribe = engine.subscribeToPlayback((id: number, pb) => {
            if (id === layer.numericId) setStatus(pb.status);
        });
        return () => unsubscribe();
    }, [layer.numericId, engine]);

    const isLooping = layer.loop ?? true;

    return (
        <div className="flex items-center gap-0.5">
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                const playback = engine.getPlayback(layer.numericId);
                                if (playback)
                                    engine.sendJSON({
                                        type: 'video_seek',
                                        numericId: layer.numericId,
                                        mediaTime: 0,
                                        issuedAt: Date.now(),
                                        playback
                                    });
                            }}
                        />
                    }
                >
                    <SkipBackIcon />
                </TooltipTrigger>
                <TooltipContent side="top">Rewind</TooltipContent>
            </Tooltip>

            {status === 'paused' ? (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                    engine.sendJSON({
                                        type: 'video_play',
                                        numericId: layer.numericId,
                                        issuedAt: Date.now()
                                    })
                                }
                            />
                        }
                    >
                        <PlayIcon />
                    </TooltipTrigger>
                    <TooltipContent side="top">Play</TooltipContent>
                </Tooltip>
            ) : (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                    engine.sendJSON({
                                        type: 'video_pause',
                                        numericId: layer.numericId,
                                        issuedAt: Date.now()
                                    })
                                }
                            />
                        }
                    >
                        <PauseIcon />
                    </TooltipTrigger>
                    <TooltipContent side="top">Pause</TooltipContent>
                </Tooltip>
            )}

            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button
                            variant={isLooping ? 'secondary' : 'ghost'}
                            size="icon-sm"
                            onClick={() => {
                                const updatedLayer = { ...layer, loop: !isLooping };
                                useEditorStore.getState().recordLayerChange({
                                    patches: [makeLayerPatch(layer.numericId, layer, updatedLayer)]
                                });
                                engine.sendJSON({
                                    type: 'upsert_layer',
                                    origin: 'editor:playback_controls_input',
                                    layer: updatedLayer
                                });
                            }}
                        />
                    }
                >
                    <RepeatIcon />
                </TooltipTrigger>
                <TooltipContent side="top">{isLooping ? 'Loop on' : 'Loop off'}</TooltipContent>
            </Tooltip>
        </div>
    );
}
