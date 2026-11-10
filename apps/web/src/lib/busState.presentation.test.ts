import { afterEach, expect, mock, test } from 'bun:test';

mock.module('~/server/collections', () => ({ dbCol: {} }));

const {
    cancelWallPresentation,
    dropWallPresentationPeer,
    markWallPresentationReady,
    prepareWallPresentation,
    sendPendingWallPresentation
} = await import('./busState.presentation');
const { scopedState, wallBindings, wallsByWallId } = await import('./busState.state');

const wallId = 'presentation-test-wall';
const scopeId = 987_654;

function setup() {
    const first: Array<Record<string, unknown>> = [];
    const second: Array<Record<string, unknown>> = [];
    const peer = (id: string, messages: Array<Record<string, unknown>>) => ({
        peer: {
            id,
            send: (raw: string) => messages.push(JSON.parse(raw) as Record<string, unknown>)
        },
        meta: { specimen: 'wall', wallId }
    });
    wallsByWallId.set(
        wallId,
        new Set([peer('screen-one', first), peer('screen-two', second)]) as any
    );
    wallBindings.set(wallId, scopeId);
    scopedState.set(scopeId, {
        projectId: 'project',
        commitId: 'commit',
        slideId: 'slide',
        layers: new Map([
            [
                1,
                {
                    numericId: 1,
                    type: 'video',
                    config: { visible: true },
                    playback: {
                        status: 'playing',
                        anchorMediaTime: 0,
                        anchorServerTime: Date.now()
                    }
                }
            ]
        ])
    } as any);
    return { first, second };
}

afterEach(() => {
    cancelWallPresentation(wallId);
    wallsByWallId.delete(wallId);
    wallBindings.delete(wallId);
    scopedState.delete(scopeId);
});

test('starts both screens together only after current presentation is ready', () => {
    const { first, second } = setup();
    expect(prepareWallPresentation(wallId, scopeId)).toBe(true);
    const staleId = first[0]?.presentationId as string;
    expect(second[0]?.presentationId).toBe(staleId);

    expect(prepareWallPresentation(wallId, scopeId)).toBe(true);
    const currentId = first[1]?.presentationId as string;
    expect(currentId).not.toBe(staleId);

    markWallPresentationReady(wallId, 'screen-one', staleId);
    markWallPresentationReady(wallId, 'screen-one', currentId);
    expect(first).toHaveLength(2);
    markWallPresentationReady(wallId, 'screen-two', currentId);

    expect(first[2]).toMatchObject({ type: 'wall_slide_start', presentationId: currentId });
    expect(second[2]).toEqual(first[2]);
    expect(first[2]?.startAt).toBeGreaterThan(Date.now());
});

test('a disconnected screen no longer holds the ready barrier', () => {
    const { first, second } = setup();
    prepareWallPresentation(wallId, scopeId);
    const presentationId = first[0]?.presentationId as string;
    markWallPresentationReady(wallId, 'screen-one', presentationId);
    dropWallPresentationPeer(wallId, 'screen-two');

    expect(first[1]).toMatchObject({ type: 'wall_slide_start', presentationId });
    expect(second).toHaveLength(1);
});

test('a screen joining during preparation receives the same presentation', () => {
    const { first, second } = setup();
    prepareWallPresentation(wallId, scopeId);
    const presentationId = first[0]?.presentationId as string;
    const late: Array<Record<string, unknown>> = [];
    const peer = {
        id: 'late-screen',
        send: (raw: string) => late.push(JSON.parse(raw) as Record<string, unknown>)
    };
    wallsByWallId.get(wallId)?.add({ peer, meta: { specimen: 'wall', wallId } } as any);
    expect(sendPendingWallPresentation(wallId, peer as any)).toBe(true);
    expect(late[0]?.presentationId).toBe(presentationId);

    markWallPresentationReady(wallId, 'screen-one', presentationId);
    markWallPresentationReady(wallId, 'screen-two', presentationId);
    expect(first).toHaveLength(1);
    markWallPresentationReady(wallId, 'late-screen', presentationId);
    expect(first[1]).toMatchObject({ type: 'wall_slide_start', presentationId });
    expect(second[1]).toEqual(first[1]);
    expect(late[1]).toEqual(first[1]);
});
