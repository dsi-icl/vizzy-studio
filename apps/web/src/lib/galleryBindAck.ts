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
    sendJSON(message: BindWallMessage): boolean;
    onWallBindingChanged(callback: (change: WallBindingChanged) => void): () => void;
}

/** Do not issue a controller launch until the server has installed this binding. */
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
            reject(new Error('Timed out waiting for the wall to load this project'));
        }, timeoutMs);
        try {
            if (!client.sendJSON({ type: 'bind_wall', ...input, slideId: 'default' })) {
                throw new Error('Gallery connection is not ready');
            }
        } catch (error) {
            clearTimeout(timeoutId);
            unsubscribe();
            reject(error);
        }
    });
}
