import { decode, isBlurhashValid } from 'blurhash';
import Konva from 'konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Rect } from 'react-konva';

import { applyKonvaFilters } from '~/lib/konvaFilters';
import { deriveVideoStillImageFilename } from '~/lib/mediaUtils';
import { textHtmlToImage } from '~/lib/textToCanvas';
import type { LayerWithEditorState } from '~/lib/types';

export function ReadOnlyMediaLayer({
    layer
}: {
    layer: Extract<LayerWithEditorState, { type: 'image' | 'video' | 'web' }>;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);

    const mediaUrl = useMemo(() => {
        if (layer.type === 'image') return layer.url;
        if (layer.type === 'video') {
            const stillName = layer.stillImage ?? deriveVideoStillImageFilename(layer.url);
            return stillName ? `/api/assets/${stillName}` : null;
        }
        const stillName = layer.stillImage;
        return stillName ? `/api/assets/${stillName}` : null;
    }, [layer]);

    useEffect(() => {
        if (!mediaUrl) {
            setImg(null);
            return;
        }
        const i = new window.Image();
        if (!mediaUrl.startsWith('blob:') && !mediaUrl.startsWith('data:')) {
            i.crossOrigin = 'anonymous';
        }
        i.onload = () => setImg(i);
        i.onerror = () => setImg(null);
        i.src = mediaUrl;
    }, [mediaUrl]);

    useEffect(() => {
        applyKonvaFilters(imageRef.current, layer.config.filters);
    }, [layer.config.filters, img, layer.config.width, layer.config.height]);

    if (img) {
        return (
            <Image
                ref={imageRef}
                image={img}
                x={layer.config.cx}
                y={layer.config.cy}
                width={layer.config.width}
                height={layer.config.height}
                scaleX={layer.config.scaleX}
                scaleY={layer.config.scaleY}
                offsetX={layer.config.width / 2}
                offsetY={layer.config.height / 2}
                rotation={layer.config.rotation}
                listening={false}
            />
        );
    }

    if (layer.blurhash && isBlurhashValid(layer.blurhash)) {
        const pixels = decode(layer.blurhash, 100, 100) as Uint8ClampedArray<ArrayBuffer>;
        const imageData = new ImageData(pixels, 100, 100);
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 100;
        offscreenCanvas.height = 100;
        const ctx = offscreenCanvas.getContext('2d');
        ctx?.putImageData(imageData, 0, 0);
        return (
            <Image
                ref={imageRef}
                image={offscreenCanvas}
                x={layer.config.cx}
                y={layer.config.cy}
                width={layer.config.width}
                height={layer.config.height}
                scaleX={layer.config.scaleX}
                scaleY={layer.config.scaleY}
                offsetX={layer.config.width / 2}
                offsetY={layer.config.height / 2}
                rotation={layer.config.rotation}
                listening={false}
            />
        );
    }

    return (
        <Rect
            x={layer.config.cx}
            y={layer.config.cy}
            width={layer.config.width}
            height={layer.config.height}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            offsetX={layer.config.width / 2}
            offsetY={layer.config.height / 2}
            rotation={layer.config.rotation}
            fill="#555"
            listening={false}
        />
    );
}

export function ReadOnlyTextLayer({
    layer
}: {
    layer: Extract<LayerWithEditorState, { type: 'text' }>;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);

    useEffect(() => {
        let cancelled = false;
        textHtmlToImage(layer.textHtml ?? '', layer.config.width, layer.config.height)
            .then((rendered) => {
                if (!cancelled) setImg(rendered);
            })
            .catch(() => {
                if (!cancelled) setImg(null);
            });
        return () => {
            cancelled = true;
        };
    }, [layer.textHtml, layer.config.width, layer.config.height]);

    useEffect(() => {
        applyKonvaFilters(imageRef.current, layer.config.filters);
    }, [layer.config.filters, img, layer.config.width, layer.config.height]);

    if (!img) {
        return (
            <Rect
                x={layer.config.cx}
                y={layer.config.cy}
                width={layer.config.width}
                height={layer.config.height}
                scaleX={layer.config.scaleX}
                scaleY={layer.config.scaleY}
                offsetX={layer.config.width / 2}
                offsetY={layer.config.height / 2}
                rotation={layer.config.rotation}
                fill="#555"
                listening={false}
            />
        );
    }

    return (
        <Image
            ref={imageRef}
            image={img}
            x={layer.config.cx}
            y={layer.config.cy}
            width={layer.config.width}
            height={layer.config.height}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            offsetX={layer.config.width / 2}
            offsetY={layer.config.height / 2}
            rotation={layer.config.rotation}
            listening={false}
        />
    );
}
