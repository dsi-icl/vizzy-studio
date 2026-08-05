export type TextHydrationState = 'connecting' | 'synced' | 'error';

export type TextHydrationEvent = 'attempt' | 'synced' | 'interrupted' | 'timeout';

export const TEXT_HYDRATION_TIMEOUT_MS = 15_000;

export function transitionTextHydrationState(
    state: TextHydrationState,
    event: TextHydrationEvent
): TextHydrationState {
    switch (event) {
        case 'attempt':
            return 'connecting';
        case 'synced':
            return 'synced';
        case 'interrupted':
            return state === 'error' ? 'error' : 'connecting';
        case 'timeout':
            return state === 'connecting' ? 'error' : state;
    }
}
