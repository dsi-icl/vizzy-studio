import { queryOptions } from '@tanstack/react-query';

import {
    $getSignageSlideshow,
    $listSignageSlideshows,
    $listSignageSources,
    $resolveSignageEntries
} from './signage.fns';

export const signageSlideshowsQueryOptions = () =>
    queryOptions({
        queryKey: ['signage', 'slideshows'],
        queryFn: () => $listSignageSlideshows()
    });

export const signageSlideshowQueryOptions = (id: string) =>
    queryOptions({
        queryKey: ['signage', 'slideshows', id],
        queryFn: () => $getSignageSlideshow({ data: { id } })
    });

export const signageEntryStatusQueryOptions = (id: string) =>
    queryOptions({
        queryKey: ['signage', 'slideshows', id, 'entry-status'],
        queryFn: () => $resolveSignageEntries({ data: { id } })
    });

export const signageSourcesQueryOptions = (layout: {
    columns: number;
    rows: number;
    screenWidth: number;
    screenHeight: number;
}) =>
    queryOptions({
        queryKey: ['signage', 'sources', layout],
        queryFn: () => $listSignageSources({ data: { layout } })
    });
