'use client';

import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useState, useRef } from 'react';
import { Group, Image, Rect, Text } from 'react-konva';

import { EditorEngine } from '~/lib/editorEngine';
import { applyKonvaFilters } from '~/lib/konvaFilters';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaVideo({
    layer,
    isDrawing,
    isPinching,
    opacity,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'video' }>;
    isDrawing: boolean;
    isPinching: boolean;
    opacity?: number;
    onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform: (e: KonvaEventObject<Event>) => void;
    onTransformEnd: (e: KonvaEventObject<Event>) => void;
}) {
    const imageRef = useRef<Konva.Image>(null);
    const [imgElement, setImgElement] = useState<HTMLImageElement | null>(null);
    const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);

    useEffect(() => {
        const i = new window.Image();
        if (!layer.url.startsWith('blob:') && !layer.url.startsWith('data:')) {
            i.crossOrigin = 'anonymous';
        }
        i.onload = () => {
            setImgElement(i);
            imageRef.current?.getLayer()?.batchDraw();
        };
        i.src = layer.url;
    }, [layer.isUploading, layer.url, layer.numericId]);

    useEffect(() => {
        if (layer.isUploading) return;

        const vid = document.createElement('video');
        if (!layer.url.startsWith('blob:') && !layer.url.startsWith('data:')) {
            vid.crossOrigin = 'anonymous';
        }
        vid.muted = true;
        vid.preload = 'auto';
        vid.playsInline = true;
        vid.loop = layer.loop ?? true;

        // Force a canvas paint the exact millisecond the browser has a frame ready
        vid.addEventListener('canplay', () => {
            setImgElement(null);
            imageRef.current?.getLayer()?.batchDraw();
        });

        vid.src = layer.url;
        setVideoElement(vid);

        return () => {
            vid.pause();
            vid.removeAttribute('src');
            vid.load();
        };
    }, [layer.isUploading, layer.url, layer.numericId]);

    // Seamlessly toggle loop without unmounting the video
    useEffect(() => {
        // oxlint-disable-next-line react-hooks-js/immutability
        if (videoElement) videoElement.loop = layer.loop ?? true;
    }, [layer.loop, videoElement]);

    useEffect(() => {
        // Avoid caching live video frames; apply filters only to static image fallback/upload states.
        if (imgElement) applyKonvaFilters(imageRef.current, layer.config.filters);
        else applyKonvaFilters(imageRef.current, undefined);
    }, [imgElement, layer.config.filters, layer.config.width, layer.config.height]);

    // 3. Playback Loop (Completely bypasses React state for 60fps performance)
    useEffect(() => {
        if (!videoElement) return;
        const engine = EditorEngine.getInstance();
        const pbRef = { current: engine.getPlayback(layer.numericId) || layer.playback };

        const unsubscribe = engine.subscribeToPlayback((id, pb) => {
            if (id === layer.numericId) {
                pbRef.current = pb;
                if (pb.status === 'paused') {
                    videoElement.pause();
                    if (Math.abs(videoElement.currentTime - pb.anchorMediaTime) > 0.05) {
                        videoElement.currentTime = pb.anchorMediaTime;
                        imageRef.current?.getLayer()?.batchDraw();
                    }
                }
            }
        });

        let frameId: number;
        const loop = () => {
            const pb = pbRef.current;
            if (pb?.status === 'playing') {
                const now = engine.getServerTime();
                if (now >= pb.anchorServerTime) {
                    if (videoElement.paused) videoElement.play().catch(() => {});

                    let expected = pb.anchorMediaTime + (now - pb.anchorServerTime) / 1000;

                    // Native wrapping math to match the browser's loop
                    if ((layer.loop ?? true) && layer.duration) {
                        expected = expected % layer.duration;
                    }
                    const drift = expected - videoElement.currentTime;
                    if (Math.abs(drift) > 0.5) {
                        videoElement.currentTime = expected; // Hard snap for heavy desync
                    } else if (drift > 0.3) {
                        videoElement.playbackRate = 1.05; // Gentle catch up
                    } else if (drift < -0.3) {
                        videoElement.playbackRate = 0.95; // Gentle slow down
                    } else {
                        videoElement.playbackRate = 1.0; // Coast perfectly smoothly
                    }
                    // if (Math.abs(drift) > 0.5) videoElement.currentTime = expected;
                    // else if (drift > 0.05) videoElement.playbackRate = 1.05;
                    // else if (drift < -0.05) videoElement.playbackRate = 0.95;
                    // else videoElement.playbackRate = 1.0;

                    imageRef.current?.getLayer()?.batchDraw();
                }
            }
            frameId = requestAnimationFrame(loop);
        };
        frameId = requestAnimationFrame(loop);

        return () => {
            unsubscribe();
            cancelAnimationFrame(frameId);
        };
    }, [videoElement, layer.numericId, layer.loop, layer.duration]);

    return (
        <Group
            id={layer.numericId.toString()}
            x={layer.config.cx}
            y={layer.config.cy}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            rotation={layer.config.rotation}
            width={layer.config.width}
            height={layer.config.height}
            offsetX={layer.config.width / 2}
            offsetY={layer.config.height / 2}
            opacity={opacity}
            listening={!isDrawing}
            draggable={!isDrawing && !isPinching}
            onClick={onSelect}
            onTap={onSelect}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
        >
            <Image
                ref={imageRef}
                image={imgElement ?? videoElement ?? undefined}
                width={layer.config.width}
                height={layer.config.height}
            />
            {layer.isUploading && (
                <>
                    <Rect
                        width={layer.config.width}
                        height={layer.config.height}
                        fill="rgba(0,0,0,0.6)"
                    />
                    {/* Centered progress bar */}
                    <Rect
                        x={layer.config.width * 0.1}
                        y={layer.config.height / 2 - 20}
                        width={layer.config.width * 0.8}
                        height={40}
                        fill="#222"
                        cornerRadius={20}
                    />
                    <Rect
                        x={layer.config.width * 0.1}
                        y={layer.config.height / 2 - 20}
                        width={layer.config.width * 0.8 * ((layer.progress || 2) / 100)}
                        height={40}
                        fill="#4caf50"
                        cornerRadius={20}
                    />
                    <Text
                        x={layer.config.width * 0.1}
                        y={layer.config.height / 2 + 40}
                        text={`Optimizing Video... ${layer.progress || 0}%`}
                        fill="white"
                        fontSize={48}
                        fontFamily="Arial"
                    />
                </>
            )}
        </Group>
    );
}
