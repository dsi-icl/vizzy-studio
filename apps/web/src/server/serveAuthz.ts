import '@tanstack/react-start/server-only';
import { scopedState, wallBindingIds, wallBindings } from '~/lib/busState';

export function isWallBoundToProject(
    wallId: string,
    projectId: string,
    scopeId?: number,
    bindingId?: string
): boolean {
    const currentScopeId = wallBindings.get(wallId);
    if (currentScopeId === undefined) return false;
    if (scopeId !== undefined && currentScopeId !== scopeId) return false;
    if (bindingId !== undefined && wallBindingIds.get(wallId) !== bindingId) return false;
    return scopedState.get(currentScopeId)?.projectId === projectId;
}
