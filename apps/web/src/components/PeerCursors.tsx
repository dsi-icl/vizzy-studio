'use client';

import type Konva from 'konva';
import { useEffect, useRef, useState } from 'react';
import { Group, Label, Layer as KonvaLayer, Line, Tag, Text } from 'react-konva';

import { getDeterministicCursorColor, getReadableTextColor } from '~/lib/cursorColor';
import { EditorEngine } from '~/lib/editorEngine';

/**
 * A cursor stops being drawn once its peer has gone silent for this long.
 * Must stay comfortably above the sender's heartbeat interval, which is what
 * keeps a resting pointer alive.
 */
const PEER_CURSOR_TTL_MS = 2500;
/** Tail of the TTL spent fading, so a peer leaving decays instead of blinking out. */
const PEER_CURSOR_FADE_MS = 600;
/**
 * Convergence rate of the position smoothing, in e-folds per second. Tuned
 * against the send interval: fast enough that the cursor is not visibly
 * trailing the peer, slow enough to absorb jitter between packets.
 */
const PEER_CURSOR_SMOOTHING = 12;
/** Guards the smoothing against a huge step after a backgrounded tab resumes. */
const MAX_FRAME_SECONDS = 0.25;

const CURSOR_POINTS = [0, 0, 0, 17, 4.6, 12.7, 7.7, 19, 10.2, 17.8, 7.2, 11.6, 12, 11];

interface PeerCursor {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    lastSeen: number;
}

interface PeerCursorIdentity {
    peerId: string;
    label: string;
    color: string;
    textColor: string;
}

/**
 * Draws co-editors' pointers on the stage. Positions arrive about once a
 * second and are eased toward, rather than jumped to, so a cursor reads as a
 * moving hand instead of a strobe. Everything is peer-scoped and expires on a
 * TTL, so departures need no signal from the bus.
 *
 * Cursors are per-slide: remount this on scope change so the previous slide's
 * peers go with it instead of lingering for a TTL.
 */
export function PeerCursors({ stageScaleFactor }: { stageScaleFactor: number }) {
    const [identities, setIdentities] = useState<Array<PeerCursorIdentity>>([]);
    const cursorsRef = useRef(new Map<string, PeerCursor>());
    const identitiesRef = useRef(new Map<string, PeerCursorIdentity>());
    const nodesRef = useRef(new Map<string, Konva.Group>());
    const layerRef = useRef<Konva.Layer>(null);
    const scaleRef = useRef(stageScaleFactor);

    useEffect(() => {
        scaleRef.current = stageScaleFactor;
    }, [stageScaleFactor]);

    useEffect(() => {
        const engine = EditorEngine.getInstance();
        return engine.subscribeToPointer((data) => {
            if (!data.peerId) return;

            const existing = cursorsRef.current.get(data.peerId);
            if (existing) {
                existing.targetX = data.x;
                existing.targetY = data.y;
                existing.lastSeen = performance.now();
                return;
            }

            cursorsRef.current.set(data.peerId, {
                x: data.x,
                y: data.y,
                targetX: data.x,
                targetY: data.y,
                lastSeen: performance.now()
            });

            const email = data.email || 'unknown';
            // Seeded on identity alone, so one person is one colour everywhere:
            // across slides, across sessions, and in the text editor's carets.
            const color = getDeterministicCursorColor(email);
            identitiesRef.current.set(data.peerId, {
                peerId: data.peerId,
                label: email,
                color,
                textColor: getReadableTextColor(color)
            });
            setIdentities(Array.from(identitiesRef.current.values()));
        });
    }, []);

    useEffect(() => {
        let frame = 0;
        let previous = performance.now();

        const step = (now: number) => {
            frame = requestAnimationFrame(step);
            const elapsed = Math.min(MAX_FRAME_SECONDS, (now - previous) / 1000);
            previous = now;

            const cursors = cursorsRef.current;
            if (cursors.size === 0) return;

            // Children are drawn in screen pixels, so undo the stage zoom to
            // keep every cursor the same size however far out the user is.
            const inverseScale = 1 / Math.max(scaleRef.current, 0.001);
            const converge = 1 - Math.exp(-PEER_CURSOR_SMOOTHING * elapsed);
            let expired = false;

            for (const [peerId, cursor] of cursors) {
                const age = now - cursor.lastSeen;
                if (age > PEER_CURSOR_TTL_MS) {
                    cursors.delete(peerId);
                    identitiesRef.current.delete(peerId);
                    nodesRef.current.delete(peerId);
                    expired = true;
                    continue;
                }

                cursor.x += (cursor.targetX - cursor.x) * converge;
                cursor.y += (cursor.targetY - cursor.y) * converge;

                const node = nodesRef.current.get(peerId);
                if (!node) continue;
                node.position({ x: cursor.x, y: cursor.y });
                node.scale({ x: inverseScale, y: inverseScale });
                node.opacity(
                    Math.min(1, Math.max(0, (PEER_CURSOR_TTL_MS - age) / PEER_CURSOR_FADE_MS))
                );
            }

            if (expired) setIdentities(Array.from(identitiesRef.current.values()));
            layerRef.current?.batchDraw();
        };

        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <KonvaLayer ref={layerRef} listening={false}>
            {identities.map((identity) => (
                <Group
                    key={identity.peerId}
                    listening={false}
                    ref={(node) => {
                        if (!node) {
                            nodesRef.current.delete(identity.peerId);
                            return;
                        }
                        nodesRef.current.set(identity.peerId, node);
                        // Place it before the first animation frame, otherwise
                        // a joining peer flashes at the stage origin.
                        const cursor = cursorsRef.current.get(identity.peerId);
                        if (cursor) node.position({ x: cursor.x, y: cursor.y });
                    }}
                >
                    <Line
                        points={CURSOR_POINTS}
                        closed
                        fill={identity.color}
                        stroke="#ffffff"
                        strokeWidth={1.25}
                        lineJoin="round"
                    />
                    <Label x={13} y={17}>
                        <Tag fill={identity.color} cornerRadius={3} />
                        <Text
                            text={identity.label}
                            fill={identity.textColor}
                            fontFamily="sans-serif"
                            fontSize={11}
                            padding={4}
                        />
                    </Label>
                </Group>
            ))}
        </KonvaLayer>
    );
}
