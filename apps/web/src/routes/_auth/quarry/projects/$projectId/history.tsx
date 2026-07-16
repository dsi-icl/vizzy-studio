import { ClockIcon } from '@phosphor-icons/react';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@repo/ui/components/select';
import { useQueryClient, useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
    auditsInfiniteQueryOptions,
    type AuditHistoryFilters,
    projectQueryOptions
} from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/projects/$projectId/history')({
    loader: async ({ context, params }) => {
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    component: HistoryTab,
    head: ({ loaderData }) => ({
        meta: [{ title: `History · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    })
});

const OUTCOME_FILTERS = [
    { value: 'non_success', label: 'Non-success (issues)' },
    { value: 'all', label: 'All outcomes' },
    { value: 'success', label: 'Success' },
    { value: 'denied', label: 'Denied' },
    { value: 'failure', label: 'Failure' },
    { value: 'error', label: 'Error' }
] as const;
const ALL_AUDIT_OUTCOMES: Array<'success' | 'denied' | 'failure' | 'error'> = [
    'success',
    'denied',
    'failure',
    'error'
];
const NON_SUCCESS_AUDIT_OUTCOMES: Array<'denied' | 'failure' | 'error'> = [
    'denied',
    'failure',
    'error'
];

const RESOURCE_FILTERS = [
    { value: 'all', label: 'All resources' },
    { value: 'project', label: 'Project' },
    { value: 'commit', label: 'Commit' },
    { value: 'asset', label: 'Asset' },
    { value: 'upload_token', label: 'Upload token' },
    { value: 'device', label: 'Device' },
    { value: 'wall', label: 'Wall' },
    { value: 'user', label: 'User' },
    { value: 'bootstrap', label: 'Bootstrap' },
    { value: 'config', label: 'Config' }
] as const;

function labelize(raw: string | null | undefined): string {
    if (!raw) return 'Unknown';
    return raw
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
        .replaceAll('Csp', 'CSP');
}

function outcomeBadgeClass(outcome: string | null | undefined): string {
    if (outcome === 'success')
        return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300';
    if (outcome === 'denied')
        return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300';
    if (outcome === 'failure' || outcome === 'error')
        return 'border-destructive/50 bg-destructive/10 text-destructive dark:bg-destructive/20';
    return '';
}

function collapseCountBadgeClass(): string {
    return 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300';
}

function deviceKindFromChanges(changes: unknown): 'wall' | 'gallery' | 'controller' | null {
    if (!changes || typeof changes !== 'object') return null;
    const kind = (changes as { kind?: unknown }).kind;
    if (kind === 'wall' || kind === 'gallery' || kind === 'controller') return kind;
    return null;
}

function hasPayload(event: {
    changes?: unknown;
    error?: string | null;
    authContext?: unknown;
    executionContext?: unknown;
}): boolean {
    return Boolean(event.changes || event.error || event.authContext || event.executionContext);
}

function eventCollapseSignature(event: {
    action?: string | null;
    outcome?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    actorId?: string | null;
    reasonCode?: string | null;
    executionContext?: { operation?: string | null } | null;
    changes?: unknown;
}) {
    const deviceKind =
        event.resourceType === 'device' ? deviceKindFromChanges(event.changes) : null;
    if (event.action === 'DEVICE_SEEN' && event.outcome === 'success') {
        return [
            event.action,
            event.outcome,
            event.resourceType ?? 'device',
            event.executionContext?.operation ?? '',
            deviceKind ?? ''
        ].join('|');
    }
    return [
        event.action ?? '',
        event.outcome ?? '',
        event.resourceType ?? '',
        event.resourceId ?? '',
        event.actorId ?? '',
        event.reasonCode ?? '',
        event.executionContext?.operation ?? '',
        deviceKind ?? ''
    ].join('|');
}

function HistoryTab() {
    const { projectId } = Route.useParams();
    const queryClient = useQueryClient();
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [outcomeFilter, setOutcomeFilter] =
        useState<(typeof OUTCOME_FILTERS)[number]['value']>('non_success');
    const [resourceFilter, setResourceFilter] =
        useState<(typeof RESOURCE_FILTERS)[number]['value']>('all');

    const filters = useMemo<AuditHistoryFilters>(
        () => ({
            outcomes:
                outcomeFilter === 'all'
                    ? ALL_AUDIT_OUTCOMES
                    : outcomeFilter === 'non_success'
                      ? NON_SUCCESS_AUDIT_OUTCOMES
                      : [outcomeFilter],
            resourceTypes: resourceFilter === 'all' ? undefined : [resourceFilter]
        }),
        [outcomeFilter, resourceFilter]
    );

    const queryOptions = useMemo(
        () => auditsInfiniteQueryOptions(projectId, filters),
        [filters, projectId]
    );
    const { data, hasNextPage, isFetchingNextPage, fetchNextPage } =
        useSuspenseInfiniteQuery(queryOptions);

    const logs = useMemo(() => data.pages.flatMap((page) => page.items), [data.pages]);
    const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const groupedLogs = useMemo(() => {
        const groups: Array<{
            id: string;
            events: typeof logs;
            signature: string;
        }> = [];
        for (const log of logs) {
            const signature = eventCollapseSignature(log);
            const previous = groups[groups.length - 1];
            if (previous && previous.signature === signature && log.outcome === 'success') {
                previous.events.push(log);
                continue;
            }
            groups.push({
                id: `${log.id}:${signature}`,
                events: [log],
                signature
            });
        }
        return groups;
    }, [logs]);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const first = entries[0];
                if (!first?.isIntersecting) return;
                if (!hasNextPage || isFetchingNextPage) return;
                void fetchNextPage();
            },
            { rootMargin: '300px 0px' }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (logs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-12 text-muted-foreground">
                <p>No audit events found</p>
                <p className="text-xs">
                    Try adjusting filters, or perform an action on this project.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="sticky top-2 z-10 rounded-xl border bg-background/90 p-3 backdrop-blur">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">History Filters</span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFiltersOpen((prev) => !prev)}
                    >
                        {filtersOpen ? 'Hide filters' : 'Show filters'}
                    </Button>
                </div>
                {filtersOpen ? (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>Outcome</span>
                            <Select
                                items={OUTCOME_FILTERS.map((opt) => ({
                                    label: opt.label,
                                    value: opt.value
                                }))}
                                value={outcomeFilter}
                                onValueChange={(value) =>
                                    setOutcomeFilter(
                                        value as (typeof OUTCOME_FILTERS)[number]['value']
                                    )
                                }
                            >
                                <SelectTrigger
                                    size="sm"
                                    className="w-40 justify-start bg-background"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {OUTCOME_FILTERS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>Resource</span>
                            <Select
                                items={RESOURCE_FILTERS.map((opt) => ({
                                    label: opt.label,
                                    value: opt.value
                                }))}
                                value={resourceFilter}
                                onValueChange={(value) =>
                                    setResourceFilter(
                                        value as (typeof RESOURCE_FILTERS)[number]['value']
                                    )
                                }
                            >
                                <SelectTrigger
                                    size="sm"
                                    className="w-40 justify-start bg-background"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {RESOURCE_FILTERS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <span className="text-xs text-muted-foreground">
                            Loaded {logs.length} event{logs.length === 1 ? '' : 's'}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                void queryClient.resetQueries({ queryKey: queryOptions.queryKey });
                            }}
                        >
                            Refresh
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="space-y-3">
                {groupedLogs.map((group) => {
                    const log = group.events[0];
                    const deviceKind =
                        log.resourceType === 'device' ? deviceKindFromChanges(log.changes) : null;
                    const isCollapsedGroup = log.outcome === 'success' && group.events.length > 1;
                    const isExpanded = expandedGroupIds.has(group.id);
                    return (
                        <div
                            key={group.id}
                            className="flex items-start gap-3 overflow-hidden rounded-xl border p-4 text-sm shadow-sm select-text"
                        >
                            <ClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{labelize(log.action)}</span>
                                        <Badge
                                            variant={
                                                log.outcome === 'failure' || log.outcome === 'error'
                                                    ? 'destructive'
                                                    : 'outline'
                                            }
                                            className={`text-[11px] ${outcomeBadgeClass(log.outcome)}`}
                                        >
                                            {labelize(log.outcome)}
                                        </Badge>
                                        {log.resourceType && (
                                            <Badge variant="outline" className="text-[11px]">
                                                {labelize(log.resourceType)}
                                            </Badge>
                                        )}
                                        {deviceKind && (
                                            <Badge variant="outline" className="text-[11px]">
                                                {labelize(deviceKind)}
                                            </Badge>
                                        )}
                                        {isCollapsedGroup && (
                                            <Badge
                                                variant="outline"
                                                className={`text-[11px] ${collapseCountBadgeClass()}`}
                                            >
                                                x{group.events.length}
                                            </Badge>
                                        )}
                                    </div>
                                    <DateDisplay
                                        value={log.createdAt}
                                        className="text-xs text-muted-foreground"
                                    />
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Actor:{' '}
                                    {typeof log.actorId === 'string'
                                        ? log.actorId
                                        : 'Unknown actor'}
                                </p>
                                {(log.executionContext?.operation ||
                                    log.executionContext?.method ||
                                    log.executionContext?.path ||
                                    log.reasonCode) && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {log.executionContext?.operation
                                            ? `Operation: ${log.executionContext.operation}`
                                            : ''}
                                        {log.executionContext?.method
                                            ? `${log.executionContext?.operation ? ' · ' : ''}Method: ${log.executionContext.method}`
                                            : ''}
                                        {log.executionContext?.path
                                            ? `${log.executionContext?.operation || log.executionContext?.method ? ' · ' : ''}Path: ${log.executionContext.path}`
                                            : ''}
                                        {log.reasonCode
                                            ? `${log.executionContext?.operation || log.executionContext?.method || log.executionContext?.path ? ' · ' : ''}Reason: ${labelize(log.reasonCode)}`
                                            : ''}
                                    </p>
                                )}
                                {hasPayload(log) && (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs text-muted-foreground">
                                            View payload
                                        </summary>
                                        <pre className="mt-2 max-h-40 max-w-full overflow-auto rounded-lg bg-muted/50 p-2 text-xs break-words whitespace-pre-wrap select-text">
                                            {JSON.stringify(
                                                {
                                                    changes: log.changes ?? null,
                                                    error: log.error ?? null,
                                                    authContext: log.authContext ?? null,
                                                    executionContext: log.executionContext ?? null
                                                },
                                                null,
                                                2
                                            )}
                                        </pre>
                                    </details>
                                )}
                                {isCollapsedGroup && (
                                    <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                                        <div className="flex items-center justify-between gap-2">
                                            <span>
                                                Collapsed {group.events.length - 1} repeated success
                                                events
                                            </span>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                    setExpandedGroupIds((prev) => {
                                                        const next = new Set(prev);
                                                        if (next.has(group.id)) {
                                                            next.delete(group.id);
                                                        } else {
                                                            next.add(group.id);
                                                        }
                                                        return next;
                                                    })
                                                }
                                            >
                                                {isExpanded ? 'Hide' : 'Show'}
                                            </Button>
                                        </div>
                                        {isExpanded && (
                                            <div className="mt-2 space-y-1">
                                                {group.events.slice(1).map((repeatLog) => (
                                                    <div
                                                        key={repeatLog.id}
                                                        className="rounded-md border bg-muted/30 px-2 py-2"
                                                    >
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className="truncate">
                                                                {repeatLog.actorId ??
                                                                    'Unknown actor'}
                                                            </span>
                                                            <DateDisplay
                                                                value={repeatLog.createdAt}
                                                                className="text-[11px] text-muted-foreground"
                                                            />
                                                        </div>
                                                        {(repeatLog.executionContext?.operation ||
                                                            repeatLog.reasonCode) && (
                                                            <p className="mt-1 text-[11px] text-muted-foreground">
                                                                {repeatLog.executionContext
                                                                    ?.operation
                                                                    ? `Operation: ${repeatLog.executionContext.operation}`
                                                                    : ''}
                                                                {repeatLog.reasonCode
                                                                    ? `${repeatLog.executionContext?.operation ? ' · ' : ''}Reason: ${labelize(repeatLog.reasonCode)}`
                                                                    : ''}
                                                            </p>
                                                        )}
                                                        {(repeatLog.changes || repeatLog.error) && (
                                                            <details className="mt-1">
                                                                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                                                                    View payload
                                                                </summary>
                                                                <pre className="mt-1 max-h-32 max-w-full overflow-auto rounded bg-muted/50 p-2 text-[11px] break-words whitespace-pre-wrap select-text">
                                                                    {JSON.stringify(
                                                                        {
                                                                            changes:
                                                                                repeatLog.changes ??
                                                                                null,
                                                                            error:
                                                                                repeatLog.error ??
                                                                                null
                                                                        },
                                                                        null,
                                                                        2
                                                                    )}
                                                                </pre>
                                                            </details>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
                <div ref={sentinelRef} className="h-10" />
                <div className="pb-6 text-center text-xs text-muted-foreground">
                    {isFetchingNextPage
                        ? 'Loading more events...'
                        : hasNextPage
                          ? 'Scroll for more'
                          : 'End of audit history'}
                </div>
            </div>
        </div>
    );
}
