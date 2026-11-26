import { expect, it, spyOn } from 'bun:test';

import type { EditorEngine } from './editorEngine';
import type { EditorState } from './editorStore.types';
import { DEFAULT_NETWORK_SETTINGS } from './network/schema';

it('updates Values locally immediately and sends the latest change within the 100 ms limit', async () => {
    Object.assign(globalThis, {
        __APP_COMMIT_SHA__: 'test',
        __APP_BUILD_TIMESTAMP__: 'test'
    });
    const [{ EditorEngine }, { createLayerSlice }] = await Promise.all([
        import('./editorEngine'),
        import('./editorStore.layers')
    ]);
    const sent: Array<{ at: number; value: number }> = [];
    const engine = spyOn(EditorEngine, 'getInstance').mockReturnValue({
        sendJSON: (message: { type: string; influence?: { values: Record<string, number> } }) => {
            if (message.type === 'network_influence')
                sent.push({ at: Date.now(), value: message.influence!.values.A! });
            return true;
        }
    } as unknown as EditorEngine);
    let state = {
        projectId: 'project',
        commitId: 'commit',
        activeSlideId: 'slide',
        saveStatus: 'saved',
        layers: new Map([
            [
                1,
                {
                    numericId: 1,
                    type: 'graph',
                    config: {
                        cx: 500,
                        cy: 325,
                        width: 1000,
                        height: 650,
                        scaleX: 1,
                        scaleY: 1,
                        rotation: 0,
                        zIndex: 1,
                        visible: true
                    },
                    network: {
                        name: 'Values',
                        source: 'import',
                        data: { nodes: [{ id: 'A' }], edges: [] },
                        settings: DEFAULT_NETWORK_SETTINGS,
                        reheat: 0,
                        influence: { activeNodeId: 'A', values: {}, propagation: 1 }
                    }
                }
            ]
        ])
    } as unknown as EditorState;
    const set: Parameters<typeof createLayerSlice>[0] = (partial) => {
        state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    const actions = createLayerSlice(
        set,
        () => state,
        {} as Parameters<typeof createLayerSlice>[2]
    );
    const change = (value: number) =>
        actions.updateNetworkInfluence(1, {
            activeNodeId: 'A',
            values: { A: value },
            propagation: 1
        });

    try {
        change(60);
        await Bun.sleep(10);
        change(70);
        await Bun.sleep(10);
        change(80);

        expect(sent.map((item) => item.value)).toEqual([60]);
        const layer = state.layers.get(1);
        expect(layer?.type === 'graph' && layer.network?.influence?.values.A).toBe(80);

        await Bun.sleep(130);
        expect(sent.map((item) => item.value)).toEqual([60, 80]);
        expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(95);
    } finally {
        engine.mockRestore();
    }
});
