import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import Konva from 'konva';
import type { ReactNode } from 'react';
import { KonvaRenderer } from 'react-konva';

import type { LayerWithEditorState } from '~/lib/types';

import { KonvaLineSegments } from './KonvaLineSegments';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

const LINE: LineLayer = {
    numericId: 29,
    type: 'line',
    config: {
        cx: 50,
        cy: 20,
        width: 100,
        height: 40,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 29,
        visible: true,
        locked: true
    },
    line: [0, 0, 20, 0],
    linePaths: [
        [0, 0, 20, 0],
        [40, 20, 60, 20],
        [80, 40, 100, 40]
    ],
    strokeColor: '#ff0000',
    strokeWidth: 10,
    strokeDash: []
};

const cleanups: Array<() => void> = [];

afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    mock.restore();
});

function mount(children: ReactNode) {
    // Render real Konva nodes without needing a browser canvas or a backend.
    const container = new Konva.Group();
    const onError = (error: unknown) => {
        throw error;
    };
    const root = KonvaRenderer.createContainer(
        container,
        1,
        null,
        false,
        null,
        '',
        onError,
        onError,
        onError,
        () => {}
    );
    const render = (next: ReactNode) => {
        KonvaRenderer.flushSyncFromReconciler(() => {
            KonvaRenderer.updateContainer(next, root, null);
        });
    };
    cleanups.push(() => {
        render(null);
        container.destroy();
    });
    render(children);
    return { container, render };
}

describe('KonvaLineSegments', () => {
    test('keeps layer ids unique and reconciles segments across multiple layers', () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const other = { ...LINE, numericId: 30 };
        const draw = (layer: LineLayer) => (
            <>
                <KonvaLineSegments key="29" id="29" layer={layer} />
                <KonvaLineSegments key="30" id="30" layer={other} />
            </>
        );
        const { container, render } = mount(draw(LINE));

        expect(container.find('#29')).toHaveLength(1);
        expect(container.find('#30')).toHaveLength(1);
        expect(container.find('Line')).toHaveLength(6);

        const remaining = [LINE.linePaths![0], [80, 40, 90, 40]];
        render(draw({ ...LINE, linePaths: remaining }));

        expect(container.find('#29')).toHaveLength(1);
        expect(container.find('#30')).toHaveLength(1);
        expect(container.find<Konva.Line>('Line').map((node) => node.points())).toEqual([
            ...remaining,
            ...other.linePaths!
        ]);
        expect(errors).not.toHaveBeenCalled();
    });

    test('the locked outline covers every segment, including after another erase', () => {
        const { container, render } = mount(<KonvaLineSegments id="29" layer={LINE} />);
        const outline = new Konva.Transformer({ resizeEnabled: false, rotateEnabled: false });
        cleanups.push(() => outline.destroy());
        outline.nodes([container.findOne('#29')!]);

        expect(outline.position()).toEqual({ x: -5, y: -5 });
        expect(outline.size()).toEqual({ width: 110, height: 50 });

        render(
            <KonvaLineSegments
                id="29"
                layer={{
                    ...LINE,
                    linePaths: [
                        [0, 0, 20, 0],
                        [40, 20, 50, 20]
                    ]
                }}
            />
        );
        // Refresh the attachment as EditorSlate does when layer data changes.
        outline.nodes([container.findOne('#29')!]);

        expect(outline.position()).toEqual({ x: -5, y: -5 });
        expect(outline.size()).toEqual({ width: 60, height: 30 });
    });

    test('each segment keeps its events and resolves to the same layer ancestor', () => {
        const onClick = mock();
        const onTap = mock();
        const { container } = mount(
            <KonvaLineSegments id="29" layer={LINE} onClick={onClick} onTap={onTap} />
        );
        const segments = container.find<Konva.Line>('Line');

        for (const segment of segments) {
            expect(segment.findAncestor('#29')?.id()).toBe('29');
            segment.fire('click', {}, true);
            segment.fire('tap', {}, true);
        }

        expect(onClick).toHaveBeenCalledTimes(3);
        expect(onTap).toHaveBeenCalledTimes(3);
    });

    test('renders legacy lines without changing their stored data or visual props', () => {
        const { linePaths: _paths, ...legacy } = LINE;
        const snapshot = JSON.stringify(legacy);
        const { container } = mount(
            <KonvaLineSegments
                id="29"
                layer={legacy}
                strokeWidth={20}
                opacity={0.3}
                listening={false}
            />
        );
        const segments = container.find<Konva.Line>('Line');

        expect(segments).toHaveLength(1);
        expect(segments[0].points()).toEqual(legacy.line);
        expect(segments[0].stroke()).toBe(legacy.strokeColor);
        expect(segments[0].strokeWidth()).toBe(20);
        expect(segments[0].getAbsoluteOpacity()).toBe(0.3);
        expect(segments[0].isListening()).toBe(false);
        expect(JSON.stringify(legacy)).toBe(snapshot);
    });
});
