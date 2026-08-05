/**
 * Connection state for a collaborative text layer.
 *
 * A dropped socket is normally a blip the provider recovers from on its own, so
 * an interruption returns to `connecting` rather than showing a failure. Only a
 * connection that never syncs within the timeout is reported as an error.
 */
export type TextHydrationState = 'connecting' | 'synced' | 'error';

export type TextHydrationEvent =
    /** A connection attempt started, or restarted after a drop. */
    | 'attempt'
    /** The provider reported a successful sync. */
    | 'synced'
    /** The socket dropped; the provider will retry. */
    | 'interrupted'
    /** The timeout elapsed without ever syncing. */
    | 'timeout';

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
            // Once synced, a drop is a reconnect rather than a failure; an
            // existing error stays until something actually syncs.
            return state === 'error' ? 'error' : 'connecting';
        case 'timeout':
            // Only fail a connection that never got anywhere.
            return state === 'connecting' ? 'error' : state;
    }
}
