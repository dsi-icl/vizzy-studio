interface WallBindingChanged {
    wallId: string;
    bound: boolean;
    projectId?: string;
    commitId?: string;
}

interface BindWallMessage {
    type: 'bind_wall';
    wallId: string;
    projectId: string;
    commitId: string;
    slideId: 'default';
}

interface GalleryBindingClient {
    sendJSON(message: BindWallMessage): boolean | void;
    onWallBindingChanged(callback: (change: WallBindingChanged) => void): () => void;
}

/** Confirm the requested binding before reporting success or issuing a controller grant. */
export function bindGalleryWallAndWait(
    client: GalleryBindingClient,
    input: { wallId: string; projectId: string; commitId: string },
    timeoutMs = 15_000
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const unsubscribe = client.onWallBindingChanged((change) => {
            if (
                change.wallId !== input.wallId ||
                !change.bound ||
                change.projectId !== input.projectId ||
                change.commitId !== input.commitId
            ) {
                return;
            }
            clearTimeout(timeoutId);
            unsubscribe();
            resolve();
        });
        timeoutId = setTimeout(() => {
            unsubscribe();
            reject(new Error('Could not load project on wall'));
        }, timeoutMs);
        try {
            if (client.sendJSON({ type: 'bind_wall', ...input, slideId: 'default' }) === false) {
                throw new Error('Gallery connection is not ready');
            }
        } catch (error) {
            clearTimeout(timeoutId);
            unsubscribe();
            reject(error);
        }
    });
}
