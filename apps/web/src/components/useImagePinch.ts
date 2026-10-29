import type Konva from 'konva';
import { useEffect, useEffectEvent, type RefObject } from 'react';

import type { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import {
    imagePinchWheelFactor,
    pinchImageTransform,
    scaleImageAroundPoint,
    type ImagePinchPoint,
    type ImagePinchTransform,
    touchToStagePoint
} from '~/lib/stageGeometry';

type SafariGestureEvent = Event & { scale: number; clientX?: number; clientY?: number };

/** do-image's trackpad/touch gestures, adapted to Vizzy's Konva + binary/upsert paths. */
export function useImagePinch({
    surfaceRef,
    stageRef,
    transformerRef,
    engine,
    onActive,
    onCommit
}: {
    surfaceRef: RefObject<HTMLDivElement | null>;
    stageRef: RefObject<Konva.Stage | null>;
    transformerRef: RefObject<Konva.Transformer | null>;
    engine: EditorEngine | null;
    onActive: (active: boolean) => void;
    onCommit: (node: Konva.Shape, numericId: number) => void;
}) {
    const commit = useEffectEvent(onCommit);
    useEffect(() => {
        const surface = surfaceRef.current;
        if (!surface || !engine) return;
        type Gesture = {
            source: 'wheel' | 'safari' | 'touch';
            id: number;
            node: Konva.Shape;
            scope: string;
            resource: string;
            uploading: boolean;
            base: ImagePinchTransform;
            current: ImagePinchTransform;
            pivot: ImagePinchPoint;
            pair?: [ImagePinchPoint, ImagePinchPoint];
            fingers?: [number, number];
            changed: boolean;
        };
        let active: Gesture | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let suppressTouch = false;
        let touchCount = 0;
        const scope = () => {
            const s = useEditorStore.getState();
            return `${s.projectId}/${s.commitId}/${s.activeSlideId}/${s.placementEpoch}`;
        };
        const resource = (id: number) => {
            const layer = useEditorStore.getState().layers.get(id);
            return layer?.type === 'image' ? JSON.stringify([layer.url, layer.deepZoom]) : null;
        };
        const valid = (gesture: Gesture) => {
            const s = useEditorStore.getState(),
                layer = s.layers.get(gesture.id);
            return (
                !s.loading &&
                s.connectionStatus === 'connected' &&
                scope() === gesture.scope &&
                layer?.type === 'image' &&
                !layer.config.locked &&
                layer.config.visible &&
                (gesture.uploading || resource(gesture.id) === gesture.resource) &&
                gesture.node.getStage() === stageRef.current
            );
        };
        const finish = (persist = true) => {
            clearTimeout(timer);
            timer = undefined;
            const last = active;
            active = null;
            if (!last) return;
            last.node.setAttr('imagePinching', false);
            if (persist && last.changed && valid(last)) {
                commit(last.node, last.id);
                engine.flushBinaryMove();
            } else {
                engine.cancelBinaryMove();
                last.node.setAttr('preTransformConfig', undefined);
            }
            onActive(false);
        };
        const selected = () => {
            const s = useEditorStore.getState();
            if (
                s.loading ||
                s.isDrawing ||
                s.editingTextLayerId !== null ||
                s.connectionStatus !== 'connected' ||
                s.selectedLayerIds.length !== 1
            )
                return null;
            const layer = s.layers.get(Number(s.selectedLayerIds[0]));
            if (layer?.type !== 'image' || layer.config.locked || !layer.config.visible)
                return null;
            const node = stageRef.current?.findOne<Konva.Shape>(`#${layer.numericId}`);
            return node ? { layer, node } : null;
        };
        const pointAt = (x: number, y: number) => {
            const stage = stageRef.current;
            return stage ? touchToStagePoint(stage, { clientX: x, clientY: y }) : null;
        };
        const consume = (event: Event) => {
            event.preventDefault();
            // Capture before Konva's normal wheel panning/touch transforms.
            event.stopPropagation();
        };
        const begin = (source: Gesture['source'], pivot?: ImagePinchPoint): Gesture | null => {
            const target = selected();
            if (!target) return null;
            if (
                source !== 'touch' &&
                (target.node.isDragging() || transformerRef.current?.isTransforming())
            )
                return null;
            finish();
            target.node.stopDrag();
            if (transformerRef.current?.isTransforming()) transformerRef.current.stopTransform();
            const base = {
                cx: target.node.x(),
                cy: target.node.y(),
                scaleX: target.node.scaleX(),
                scaleY: target.node.scaleY(),
                rotation: target.node.rotation()
            };
            active = {
                source,
                id: target.layer.numericId,
                node: target.node,
                scope: scope(),
                resource: resource(target.layer.numericId)!,
                uploading: Boolean(target.layer.isUploading),
                base,
                current: base,
                pivot: pivot ?? { x: base.cx, y: base.cy },
                changed: false
            };
            target.node.setAttr('preTransformConfig', { ...target.layer.config });
            target.node.setAttr('lastActiveAnchor', null);
            target.node.setAttr('imagePinching', true);
            onActive(true);
            return active;
        };
        const apply = (gesture: Gesture, transform: ImagePinchTransform) => {
            if (!valid(gesture)) {
                finish(false);
                return;
            }
            if (!Object.values(transform).every(Number.isFinite)) return;
            gesture.changed ||= Object.keys(transform).some(
                (key) =>
                    transform[key as keyof ImagePinchTransform] !==
                    gesture.current[key as keyof ImagePinchTransform]
            );
            gesture.current = transform;
            const node = gesture.node;
            node.position({ x: transform.cx, y: transform.cy });
            node.scale({ x: transform.scaleX, y: transform.scaleY });
            node.rotation(transform.rotation);
            const layer = useEditorStore.getState().layers.get(gesture.id);
            if (layer?.isUploading) layer.config = { ...layer.config, ...transform };
            transformerRef.current?.forceUpdate();
            node.getLayer()?.batchDraw();
            engine.broadcastBinaryMove(
                gesture.id,
                Math.round(node.x()),
                Math.round(node.y()),
                Math.round(node.width()),
                Math.round(node.height()),
                Math.round(node.scaleX() * 1000) / 1000,
                Math.round(node.scaleY() * 1000) / 1000,
                Math.round(node.rotation())
            );
        };
        const wheel = (event: WheelEvent) => {
            if (!event.ctrlKey || !selected()) return;
            consume(event);
            if (touchCount || suppressTouch || active?.source === 'safari') return;
            if (!Number.isFinite(event.deltaY) || !event.deltaY) return;
            const pivot = pointAt(event.clientX, event.clientY);
            if (!pivot) return;
            const gesture = active ?? begin('wheel', pivot);
            if (!gesture) return;
            apply(
                gesture,
                scaleImageAroundPoint(
                    gesture.current,
                    pivot,
                    imagePinchWheelFactor(event.deltaY, event.deltaMode, surface.clientHeight)
                )
            );
            clearTimeout(timer);
            timer = setTimeout(() => finish(), 180);
        };
        const safariStart = (event: Event) => {
            if (!selected()) return;
            consume(event);
            if (touchCount || suppressTouch) return;
            const native = event as SafariGestureEvent;
            const pivot =
                typeof native.clientX === 'number' && typeof native.clientY === 'number'
                    ? pointAt(native.clientX, native.clientY)
                    : null;
            begin('safari', pivot ?? undefined);
        };
        const safariChange = (event: Event) => {
            if (active?.source !== 'safari') return;
            consume(event);
            const scale = (event as SafariGestureEvent).scale;
            if (!Number.isFinite(scale) || scale <= 0) return;
            // Safari reports absolute scale since gesturestart, not a delta.
            apply(active, scaleImageAroundPoint(active.base, active.pivot, scale));
        };
        const safariEnd = (event: Event) => {
            if (active?.source !== 'safari') return;
            safariChange(event);
            finish();
        };
        const touchStart = (event: TouchEvent) => {
            touchCount = event.touches.length;
            if (suppressTouch) {
                consume(event);
                return;
            }
            if (touchCount !== 2 || !selected()) return;
            consume(event);
            const pair = Array.from(event.touches).map((t) => pointAt(t.clientX, t.clientY)) as [
                ImagePinchPoint,
                ImagePinchPoint
            ];
            if (pair.some((p) => !p)) return;
            const gesture = begin('touch');
            if (!gesture) return;
            gesture.pair = pair;
            gesture.fingers = [event.touches[0].identifier, event.touches[1].identifier];
            suppressTouch = true;
        };
        const touchMove = (event: TouchEvent) => {
            if (!suppressTouch) return;
            consume(event);
            const gesture = active;
            if (gesture?.source !== 'touch' || !gesture.fingers || !gesture.pair) return;
            const touches = gesture.fingers.map((id) =>
                Array.from(event.touches).find((t) => t.identifier === id)
            );
            if (touches.some((t) => !t)) {
                finish();
                return;
            }
            const pair = touches.map((t) => pointAt(t!.clientX, t!.clientY)) as [
                ImagePinchPoint,
                ImagePinchPoint
            ];
            if (pair.some((p) => !p)) return;
            if (
                Math.hypot(
                    gesture.pair[0].x - gesture.pair[1].x,
                    gesture.pair[0].y - gesture.pair[1].y
                ) < 1
            ) {
                gesture.pair = pair;
                gesture.base = gesture.current;
            } else apply(gesture, pinchImageTransform(gesture.base, gesture.pair, pair));
        };
        const touchEnd = (event: TouchEvent) => {
            touchCount = event.touches.length;
            if (!suppressTouch) return;
            consume(event);
            const remaining = new Set(Array.from(event.touches).map((t) => t.identifier));
            if (event.type === 'touchcancel' || active?.fingers?.some((id) => !remaining.has(id)))
                finish();
            if (!touchCount) suppressTouch = false;
        };
        const blur = () => {
            finish();
            touchCount = 0;
            suppressTouch = false;
        };
        const unsubscribe = useEditorStore.subscribe(() => {
            if (!active) return;
            if (!valid(active)) finish(false);
            else if (selected()?.layer.numericId !== active.id) finish();
        });
        const options = { capture: true, passive: false };
        surface.addEventListener('wheel', wheel, options);
        surface.addEventListener('gesturestart', safariStart, options);
        surface.addEventListener('gesturechange', safariChange, options);
        surface.addEventListener('gestureend', safariEnd, options);
        surface.addEventListener('touchstart', touchStart, options);
        surface.addEventListener('touchmove', touchMove, options);
        surface.addEventListener('touchend', touchEnd, options);
        surface.addEventListener('touchcancel', touchEnd, options);
        window.addEventListener('blur', blur);
        window.addEventListener('resize', blur);
        return () => {
            unsubscribe();
            finish();
            surface.removeEventListener('wheel', wheel, true);
            surface.removeEventListener('gesturestart', safariStart, true);
            surface.removeEventListener('gesturechange', safariChange, true);
            surface.removeEventListener('gestureend', safariEnd, true);
            surface.removeEventListener('touchstart', touchStart, true);
            surface.removeEventListener('touchmove', touchMove, true);
            surface.removeEventListener('touchend', touchEnd, true);
            surface.removeEventListener('touchcancel', touchEnd, true);
            window.removeEventListener('blur', blur);
            window.removeEventListener('resize', blur);
        };
    }, [surfaceRef, stageRef, transformerRef, engine, onActive]);
}
