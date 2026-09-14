import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import {
    $adminDevicesForWall,
    $adminDevicesList,
    $adminGetWall,
    $adminGetWallBindingMeta,
    $adminGetStats,
    $adminListAuditsPage,
    $adminListConfig,
    $adminListProjects,
    $adminListPublicAssets,
    $adminListUsers,
    $adminListWalls
} from './admin.fns';

export interface AdminAuditFilters {
    projectId?: string | null;
    outcomes?: Array<'success' | 'denied' | 'failure' | 'error'>;
    resourceTypes?: Array<
        | 'project'
        | 'commit'
        | 'asset'
        | 'wall'
        | 'device'
        | 'user'
        | 'upload_token'
        | 'start_route'
        | 'ws_message'
        | 'portal_token'
        | 'bootstrap'
        | 'config'
        | 'smtp'
        | 'scope'
        | 'signage_slideshow'
        | 'unknown'
    >;
    operation?: string;
    surface?: 'http' | 'serverfn' | 'ws' | 'yjs' | 'job' | 'system' | 'unknown' | null;
    actorId?: string;
    reasonCode?: string;
}

export const adminUsersQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'users'],
        queryFn: () => $adminListUsers()
    });

export const adminProjectsQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'projects'],
        queryFn: () => $adminListProjects()
    });

export const adminAuditsInfiniteQueryOptions = (filters: AdminAuditFilters = {}) =>
    infiniteQueryOptions({
        queryKey: ['admin', 'audits', 'infinite', filters],
        staleTime: 0,
        refetchOnMount: 'always',
        refetchInterval: 5_000,
        initialPageParam: null as { createdAt: number; id: string } | null,
        queryFn: ({ pageParam }) =>
            $adminListAuditsPage({
                data: {
                    projectId: filters.projectId ?? null,
                    limit: 50,
                    cursor: pageParam,
                    outcomes: filters.outcomes,
                    resourceTypes: filters.resourceTypes,
                    operation: filters.operation,
                    surface: filters.surface ?? undefined,
                    actorId: filters.actorId,
                    reasonCode: filters.reasonCode
                }
            }),
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
    });

export const adminStatsQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'stats'],
        queryFn: () => $adminGetStats(),
        refetchInterval: 10_000
    });

export const adminWallsQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'walls'],
        queryFn: () => $adminListWalls(),
        refetchInterval: 5_000
    });

export const adminPublicAssetsQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'public-assets'],
        queryFn: () => $adminListPublicAssets()
    });

export const adminWallBindingMetaQueryOptions = (input: {
    boundProjectId?: string | null;
    boundCommitId?: string | null;
    boundSlideId?: string | null;
}) =>
    queryOptions({
        queryKey: ['admin', 'walls', 'binding-meta', input],
        queryFn: () =>
            $adminGetWallBindingMeta({
                data: {
                    boundProjectId: input.boundProjectId ?? null,
                    boundCommitId: input.boundCommitId ?? null,
                    boundSlideId: input.boundSlideId ?? null
                }
            }),
        staleTime: 15_000
    });

export const adminConfigQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'config'],
        queryFn: () => $adminListConfig()
    });

export const adminDevicesQueryOptions = () =>
    queryOptions({
        queryKey: ['admin', 'devices'],
        queryFn: () => $adminDevicesList(),
        refetchInterval: 5_000
    });

export const adminWallQueryOptions = (wallId: string) =>
    queryOptions({
        queryKey: ['admin', 'walls', wallId],
        queryFn: () => $adminGetWall({ data: { wallId } }),
        refetchInterval: 5_000
    });

export const adminDevicesForWallQueryOptions = (wallId: string) =>
    queryOptions({
        queryKey: ['admin', 'walls', wallId, 'devices'],
        queryFn: () => $adminDevicesForWall({ data: { wallId } }),
        refetchInterval: 5_000
    });
