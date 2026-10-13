import Konva from 'konva';
import { useEffect, useRef, type ComponentProps, type RefObject } from 'react';
import { Ellipse, Line, Rect } from 'react-konva';

import {
    getPolylineLength,
    getShapeEffectFrame,
    getShapeEffectSettings,
    getShapeOutline,
    partialShapeOutline
} from '~/lib/shapeEffects';
import type { ShapeEffect, ShapeEffectSettings } from '~/lib/types';

type EffectProps = {
    effect?: ShapeEffect;
    effectSettings?: ShapeEffectSettings;
    followNodeId?: string;
    getTimeMs?: () => number;
};

function copyGeometry(target: Konva.Shape, source: Konva.Shape) {
    target.position(source.position());
    target.rotation(source.rotation());
    target.offset(source.offset());
    target.scale(source.scale());
    if (target instanceof Konva.Rect && source instanceof Konva.Rect) {
        target.size(source.size());
        target.cornerRadius(source.cornerRadius());
    } else if (target instanceof Konva.Ellipse && source instanceof Konva.Ellipse) {
        target.radius(source.radius());
    }
}

function useShapeAnimation<T extends Konva.Rect | Konva.Ellipse>(
    ref: RefObject<T | null>,
    focusRef: RefObject<T | null>,
    pingRefs: RefObject<Array<T | null>>,
    traceRef: RefObject<Konva.Line | null>,
    effect: ShapeEffect | undefined,
    settings: ShapeEffectSettings | undefined,
    getTimeMs: (() => number) | undefined,
    options: {
        shape: 'rectangle' | 'oval';
        width: number;
        height: number;
        cornerRadius: number;
        scaleX: number;
        scaleY: number;
        opacity: number;
        strokeWidth: number;
        followNodeId?: string;
    }
) {
    const settingsRef = useRef(settings);
    const timeRef = useRef(getTimeMs);
    useEffect(() => {
        settingsRef.current = settings;
        timeRef.current = getTimeMs;
    }, [settings, getTimeMs]);
    const {
        shape,
        width,
        height,
        cornerRadius,
        scaleX,
        scaleY,
        opacity,
        strokeWidth,
        followNodeId
    } = options;
    useEffect(() => {
        const node = ref.current;
        const layer = node?.getLayer();
        if (!node || !layer || !effect || effect === 'none') return;
        const outline = getShapeOutline(shape, width, height, cornerRadius);
        const xOffset = shape === 'oval' ? width / 2 : 0;
        const yOffset = shape === 'oval' ? height / 2 : 0;
        const animation = new Konva.Animation(() => {
            let baseScale = { x: scaleX, y: scaleY };
            if (followNodeId) {
                const source = node.getStage()?.findOne<Konva.Shape>(`#${followNodeId}`);
                if (source) {
                    copyGeometry(node, source);
                    baseScale = source.scale();
                }
            }
            const frame = getShapeEffectFrame(
                effect,
                timeRef.current?.() ?? Date.now(),
                settingsRef.current
            );
            node.scale({ x: baseScale.x * frame.scale, y: baseScale.y * frame.scale });
            node.opacity(opacity);
            node.strokeWidth(effect === 'reveal' && frame.revealProgress < 1 ? 0 : strokeWidth);

            const focus = focusRef.current;
            if (focus) {
                copyGeometry(focus, node);
                focus.scale({
                    x: baseScale.x * frame.focusScale,
                    y: baseScale.y * frame.focusScale
                });
                focus.opacity(opacity * frame.focusOpacity);
            }
            pingRefs.current.forEach((ring, index) => {
                if (!ring) return;
                const values = frame.rings[index];
                copyGeometry(ring, node);
                ring.scale({
                    x: baseScale.x * (values?.scale ?? 1),
                    y: baseScale.y * (values?.scale ?? 1)
                });
                ring.opacity(opacity * (values?.opacity ?? 0));
            });

            const trace = traceRef.current;
            if (trace) {
                trace.position(node.position());
                trace.rotation(node.rotation());
                trace.offset(node.offset());
                trace.scale(baseScale);
                if (effect === 'travel') {
                    const segmentLength =
                        getShapeEffectSettings(settingsRef.current).segmentLength / 100;
                    trace.dash([
                        Math.max(1, outline.total * segmentLength),
                        Math.max(1, outline.total * (1 - segmentLength))
                    ]);
                    trace.dashOffset(-outline.total * frame.travelProgress);
                    trace.opacity(opacity * frame.travelOpacity);
                } else if (effect === 'reveal') {
                    const points = partialShapeOutline(
                        outline,
                        frame.revealProgress,
                        settingsRef.current?.direction === 'reverse'
                    );
                    for (let i = 0; i < points.length; i += 2) {
                        points[i] -= xOffset;
                        points[i + 1] -= yOffset;
                    }
                    trace.points(points);
                    trace.opacity(frame.revealProgress >= 1 ? 0 : opacity);
                }
            }
        }, layer);
        animation.start();
        return () => {
            animation.stop();
            node.scale({ x: scaleX, y: scaleY });
            node.opacity(opacity);
            node.strokeWidth(strokeWidth);
            layer.batchDraw();
        };
    }, [
        effect,
        followNodeId,
        focusRef,
        pingRefs,
        traceRef,
        ref,
        shape,
        width,
        height,
        cornerRadius,
        scaleX,
        scaleY,
        opacity,
        strokeWidth
    ]);
}

export function EffectRect({
    effect,
    effectSettings,
    followNodeId,
    getTimeMs,
    ...props
}: ComponentProps<typeof Rect> & EffectProps) {
    const ref = useRef<Konva.Rect>(null);
    const focusRef = useRef<Konva.Rect>(null);
    const pingRefs = useRef<Array<Konva.Rect | null>>([]);
    const traceRef = useRef<Konva.Line>(null);
    const width = props.width ?? 0;
    const height = props.height ?? 0;
    const outline = getShapeOutline(
        'rectangle',
        width,
        height,
        typeof props.cornerRadius === 'number' ? props.cornerRadius : 0
    );
    const settings = getShapeEffectSettings(effectSettings);
    useShapeAnimation(ref, focusRef, pingRefs, traceRef, effect, effectSettings, getTimeMs, {
        shape: 'rectangle',
        width,
        height,
        cornerRadius: typeof props.cornerRadius === 'number' ? props.cornerRadius : 0,
        scaleX: props.scaleX ?? 1,
        scaleY: props.scaleY ?? 1,
        opacity: props.opacity ?? 1,
        strokeWidth: props.strokeWidth ?? 0,
        followNodeId
    });
    return (
        <>
            <Rect {...props} ref={ref} />
            {effect === 'focus' ? (
                <Rect
                    {...props}
                    id={undefined}
                    ref={focusRef}
                    listening={false}
                    draggable={false}
                    fill="transparent"
                    dash={[]}
                    stroke={settings.accentColor ?? '#ffffff'}
                    strokeWidth={Math.max(2, (props.strokeWidth ?? 0) * 0.65)}
                    opacity={0}
                />
            ) : null}
            {effect === 'ping'
                ? Array.from({ length: settings.ringCount }, (_, index) => (
                      <Rect
                          key={index}
                          {...props}
                          id={undefined}
                          ref={(node) => {
                              pingRefs.current[index] = node;
                          }}
                          listening={false}
                          draggable={false}
                          fill="transparent"
                          dash={[]}
                          stroke={settings.accentColor ?? '#ffffff'}
                          strokeWidth={Math.max(2, (props.strokeWidth ?? 0) * 0.65)}
                          opacity={0}
                      />
                  ))
                : null}
            {effect === 'travel' || effect === 'reveal' ? (
                <Line
                    ref={traceRef}
                    points={outline.points.flatMap(({ x, y }) => [x, y])}
                    x={props.x}
                    y={props.y}
                    rotation={props.rotation}
                    offsetX={props.offsetX}
                    offsetY={props.offsetY}
                    scaleX={props.scaleX}
                    scaleY={props.scaleY}
                    stroke={settings.accentColor ?? '#ffffff'}
                    strokeWidth={
                        effect === 'reveal'
                            ? (props.strokeWidth ?? 0)
                            : Math.max(3, (props.strokeWidth ?? 0) + 2)
                    }
                    dash={effect === 'reveal' ? props.dash : undefined}
                    lineCap="round"
                    lineJoin="round"
                    listening={false}
                    opacity={0}
                />
            ) : null}
        </>
    );
}

export function EffectEllipse({
    effect,
    effectSettings,
    followNodeId,
    getTimeMs,
    ...props
}: ComponentProps<typeof Ellipse> & EffectProps) {
    const ref = useRef<Konva.Ellipse>(null);
    const focusRef = useRef<Konva.Ellipse>(null);
    const pingRefs = useRef<Array<Konva.Ellipse | null>>([]);
    const traceRef = useRef<Konva.Line>(null);
    const width = (props.radiusX ?? 0) * 2;
    const height = (props.radiusY ?? 0) * 2;
    const outline = getShapeOutline('oval', width, height);
    const settings = getShapeEffectSettings(effectSettings);
    useShapeAnimation(ref, focusRef, pingRefs, traceRef, effect, effectSettings, getTimeMs, {
        shape: 'oval',
        width,
        height,
        cornerRadius: 0,
        scaleX: props.scaleX ?? 1,
        scaleY: props.scaleY ?? 1,
        opacity: props.opacity ?? 1,
        strokeWidth: props.strokeWidth ?? 0,
        followNodeId
    });
    return (
        <>
            <Ellipse {...props} ref={ref} />
            {effect === 'focus' ? (
                <Ellipse
                    {...props}
                    id={undefined}
                    ref={focusRef}
                    listening={false}
                    draggable={false}
                    fill="transparent"
                    dash={[]}
                    stroke={settings.accentColor ?? '#ffffff'}
                    strokeWidth={Math.max(2, (props.strokeWidth ?? 0) * 0.65)}
                    opacity={0}
                />
            ) : null}
            {effect === 'ping'
                ? Array.from({ length: settings.ringCount }, (_, index) => (
                      <Ellipse
                          key={index}
                          {...props}
                          id={undefined}
                          ref={(node) => {
                              pingRefs.current[index] = node;
                          }}
                          listening={false}
                          draggable={false}
                          fill="transparent"
                          dash={[]}
                          stroke={settings.accentColor ?? '#ffffff'}
                          strokeWidth={Math.max(2, (props.strokeWidth ?? 0) * 0.65)}
                          opacity={0}
                      />
                  ))
                : null}
            {effect === 'travel' || effect === 'reveal' ? (
                <Line
                    ref={traceRef}
                    points={outline.points.flatMap(({ x, y }) => [x - width / 2, y - height / 2])}
                    x={props.x}
                    y={props.y}
                    rotation={props.rotation}
                    offsetX={props.offsetX}
                    offsetY={props.offsetY}
                    scaleX={props.scaleX}
                    scaleY={props.scaleY}
                    stroke={settings.accentColor ?? '#ffffff'}
                    strokeWidth={
                        effect === 'reveal'
                            ? (props.strokeWidth ?? 0)
                            : Math.max(3, (props.strokeWidth ?? 0) + 2)
                    }
                    dash={effect === 'reveal' ? props.dash : undefined}
                    lineCap="round"
                    lineJoin="round"
                    listening={false}
                    opacity={0}
                />
            ) : null}
        </>
    );
}

export function EffectLine({
    effect,
    effectSettings,
    getTimeMs,
    ...props
}: ComponentProps<typeof Line> & EffectProps) {
    const baseRef = useRef<Konva.Line>(null);
    const traceRef = useRef<Konva.Line>(null);
    const settingsRef = useRef(effectSettings);
    const timeRef = useRef(getTimeMs);
    useEffect(() => {
        settingsRef.current = effectSettings;
        timeRef.current = getTimeMs;
    }, [effectSettings, getTimeMs]);
    const points = props.points ?? [];
    const length = getPolylineLength(points);
    useEffect(() => {
        const layer = baseRef.current?.getLayer();
        if (!layer || effect !== 'travel') return;
        const animation = new Konva.Animation(() => {
            const trace = traceRef.current;
            if (!trace) return;
            const settings = getShapeEffectSettings(settingsRef.current);
            const frame = getShapeEffectFrame(
                effect,
                timeRef.current?.() ?? Date.now(),
                settingsRef.current
            );
            const visibleLength = Math.max(1, (length * settings.segmentLength) / 100);
            trace.dash([visibleLength, Math.max(1, length - visibleLength)]);
            trace.dashOffset(-length * frame.travelProgress);
            trace.opacity((props.opacity ?? 1) * frame.travelOpacity);
        }, layer);
        animation.start();
        return () => {
            animation.stop();
        };
    }, [effect, length, props.opacity]);
    const settings = getShapeEffectSettings(effectSettings);
    return (
        <>
            <Line {...props} ref={baseRef} />
            {effect === 'travel' ? (
                <Line
                    {...props}
                    id={undefined}
                    ref={traceRef}
                    listening={false}
                    draggable={false}
                    stroke={settings.accentColor ?? '#ffffff'}
                    strokeWidth={Math.max(3, (props.strokeWidth ?? 0) + 2)}
                    dash={[]}
                    opacity={0}
                />
            ) : null}
        </>
    );
}
