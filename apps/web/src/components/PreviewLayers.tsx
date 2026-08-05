import { decode, isBlurhashValid } from 'blurhash';
import Konva from 'konva';
import { useEffect, useRef, useState } from 'react';
import { Image, Rect } from 'react-konva';

import { applyKonvaFilters } from '~/lib/konvaFilters';
import { deriveVideoStillImageFilename } from '~/lib/mediaUtils';
import { textHtmlToImage } from '~/lib/textToCanvas';
import type { LayerWithEditorState } from '~/lib/types';

export function PreviewMediaLayer({
    shape,
    stageScaleFactor
}: {
    shape: Extract<LayerWithEditorState, { type: 'image' | 'video' | 'web' }>;
    stageScaleFactor: number;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);

    const mediaUrl =
        shape.type === 'image'
            ? shape.url
            : shape.type === 'video'
              ? shape.stillImage
                  ? `/api/assets/${shape.stillImage}`
                  : (() => {
                        const fallbackStill = deriveVideoStillImageFilename(shape.url);
                        return fallbackStill ? `/api/assets/${fallbackStill}` : null;
                    })()
              : shape.stillImage
                ? `/api/assets/${shape.stillImage}`
                : null;

    useEffect(() => {
        if (!mediaUrl) return;
        const i = new window.Image();
        if (!mediaUrl.startsWith('blob:') && !mediaUrl.startsWith('data:')) {
            i.crossOrigin = 'anonymous';
        }
        i.onload = () => setImg(i);
        i.onerror = () => setImg(null);
        i.src = mediaUrl;
    }, [mediaUrl]);

    useEffect(() => {
        applyKonvaFilters(imageRef.current, shape.config.filters);
    }, [shape.config.filters, img, shape.config.width, shape.config.height]);

    if (mediaUrl && img) {
        return (
            <Image
                ref={imageRef}
                image={img}
                x={shape.config.cx * stageScaleFactor}
                y={shape.config.cy * stageScaleFactor}
                width={shape.config.width * stageScaleFactor}
                height={shape.config.height * stageScaleFactor}
                offsetX={(shape.config.width * stageScaleFactor) / 2}
                offsetY={(shape.config.height * stageScaleFactor) / 2}
                rotation={shape.config.rotation}
                listening={false}
            />
        );
    }

    if (shape.blurhash && isBlurhashValid(shape.blurhash)) {
        const pixels = decode(shape.blurhash, 100, 100) as Uint8ClampedArray<ArrayBuffer>;
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
                x={shape.config.cx * stageScaleFactor}
                y={shape.config.cy * stageScaleFactor}
                width={shape.config.width * stageScaleFactor}
                height={shape.config.height * stageScaleFactor}
                offsetX={(shape.config.width * stageScaleFactor) / 2}
                offsetY={(shape.config.height * stageScaleFactor) / 2}
                rotation={shape.config.rotation}
                listening={false}
            />
        );
    }

    return (
        <Rect
            x={shape.config.cx * stageScaleFactor}
            y={shape.config.cy * stageScaleFactor}
            width={shape.config.width * stageScaleFactor}
            height={shape.config.height * stageScaleFactor}
            offsetX={(shape.config.width * stageScaleFactor) / 2}
            offsetY={(shape.config.height * stageScaleFactor) / 2}
            rotation={shape.config.rotation}
            fill="#555"
            listening={false}
        />
    );
}

export function PreviewTextLayer({
    shape,
    stageScaleFactor
}: {
    shape: Extract<LayerWithEditorState, { type: 'text' }>;
    stageScaleFactor: number;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);

    useEffect(() => {
        let cancelled = false;
        textHtmlToImage(shape.textHtml ?? '', shape.config.width, shape.config.height)
            .then((rendered) => {
                if (!cancelled) setImg(rendered);
            })
            .catch(() => {
                if (!cancelled) setImg(null);
            });
        return () => {
            cancelled = true;
        };
    }, [shape.textHtml, shape.config.width, shape.config.height]);

    useEffect(() => {
        applyKonvaFilters(imageRef.current, shape.config.filters);
    }, [shape.config.filters, img, shape.config.width, shape.config.height]);

    if (img) {
        return (
            <Image
                ref={imageRef}
                image={img}
                x={shape.config.cx * stageScaleFactor}
                y={shape.config.cy * stageScaleFactor}
                width={shape.config.width * stageScaleFactor}
                height={shape.config.height * stageScaleFactor}
                offsetX={(shape.config.width * stageScaleFactor) / 2}
                offsetY={(shape.config.height * stageScaleFactor) / 2}
                rotation={shape.config.rotation}
                listening={false}
            />
        );
    }

    return (
        <Rect
            x={shape.config.cx * stageScaleFactor}
            y={shape.config.cy * stageScaleFactor}
            width={shape.config.width * stageScaleFactor}
            height={shape.config.height * stageScaleFactor}
            offsetX={(shape.config.width * stageScaleFactor) / 2}
            offsetY={(shape.config.height * stageScaleFactor) / 2}
            rotation={shape.config.rotation}
            fill="#555"
            listening={false}
        />
    );
}
