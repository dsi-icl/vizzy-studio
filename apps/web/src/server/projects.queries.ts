import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import {
    $getAudits,
    $getAuditsPage,
    $getCommit,
    $getProject,
    $getProjectCommits,
    $listAssets,
    $listAssetsByUrlsForPicker,
    $listKnownTags,
    $listProjects,
    $listPublishedProjects
} from './projects.fns';

export interface AuditHistoryFilters {
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
        | 'unknown'
    >;
}

export const projectsQueryOptions = (includeArchived = false) =>
    queryOptions({
        queryKey: ['projects', { includeArchived }],
        queryFn: () => $listProjects({ data: { includeArchived } })
    });

export const projectAssetsQueryOptions = (projectId: string) =>
    queryOptions({
        queryKey: ['projects', projectId, 'assets'],
        queryFn: () => $listAssets({ data: { projectId } })
    });

export const projectPickerSelectedAssetsQueryOptions = (projectId: string, urls: string[]) => {
    const normalized = Array.from(new Set(urls.map((url) => url.replace(/^\/api\/assets\//, ''))));
    return queryOptions({
        queryKey: ['projects', projectId, 'assets', 'picker-selected', normalized.sort()],
        queryFn: () => $listAssetsByUrlsForPicker({ data: { projectId, urls: normalized } })
    });
};

export const projectQueryOptions = (id: string) =>
    queryOptions({
        queryKey: ['projects', id],
        queryFn: () => $getProject({ data: { id } })
    });

export const publishedProjectsQueryOptions = () =>
    queryOptions({
        queryKey: ['projects', 'published'],
        queryFn: () => $listPublishedProjects()
    });

export const projectTagSuggestionsQueryOptions = () =>
    queryOptions({
        queryKey: ['projects', 'tags', 'suggestions'],
        queryFn: () => $listKnownTags()
    });

export const auditsQueryOptions = (projectId: string) =>
    queryOptions({
        queryKey: ['projects', projectId, 'audit'],
        queryFn: () => $getAudits({ data: { projectId } })
    });

export const auditsInfiniteQueryOptions = (projectId: string, filters: AuditHistoryFilters = {}) =>
    infiniteQueryOptions({
        queryKey: ['projects', projectId, 'audit', 'infinite', filters],
        staleTime: 0,
        refetchOnMount: 'always',
        refetchInterval: 5_000,
        initialPageParam: null as { createdAt: number; id: string } | null,
        queryFn: ({ pageParam }) =>
            $getAuditsPage({
                data: {
                    projectId,
                    limit: 40,
                    cursor: pageParam,
                    outcomes: filters.outcomes,
                    resourceTypes: filters.resourceTypes
                }
            }),
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
    });

export const commitsQueryOptions = (projectId: string, stageId: string) =>
    queryOptions({
        queryKey: ['projects', projectId, 'stages', stageId, 'commits'],
        queryFn: () => $getProjectCommits({ data: { projectId, stageId } })
    });

export const commitQueryOptions = (commitId: string) =>
    queryOptions({
        queryKey: ['commits', commitId],
        queryFn: () => $getCommit({ data: { id: commitId } })
    });
