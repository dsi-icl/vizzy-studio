export type ScopeDirtyState = {
    dirty: boolean;
    mutationRevision: number;
};

export function markScopeDirty(scope: ScopeDirtyState): number {
    scope.dirty = true;
    scope.mutationRevision += 1;
    return scope.mutationRevision;
}

export function captureScopeMutation(scope: ScopeDirtyState): number {
    return scope.mutationRevision;
}

/** Clear dirty only if no newer mutation arrived while persistence was in flight. */
export function markScopePersisted(scope: ScopeDirtyState, persistedRevision: number): boolean {
    if (scope.mutationRevision !== persistedRevision) return false;
    scope.dirty = false;
    return true;
}
