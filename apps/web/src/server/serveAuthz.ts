import '@tanstack/react-start/server-only';
import { scopedState, wallBindings } from '~/lib/busState';

export function isWallBoundToProject(wallId: string, projectId: string, scopeId?: number): boolean {
    const currentScopeId = wallBindings.get(wallId);
    if (currentScopeId === undefined) return false;
    if (scopeId !== undefined && currentScopeId !== scopeId) return false;
    return scopedState.get(currentScopeId)?.projectId === projectId;
}
