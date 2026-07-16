import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import { adminStatsQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/stats')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminStatsQueryOptions());
    },
    component: AdminStats,
    head: () => ({
        meta: [{ title: 'Stats · Admin · Vizzy Studio' }]
    })
});

function StatCard({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-2xl font-bold tabular-nums">{value}</div>
            <div className="mt-1 text-sm text-muted-foreground">{label}</div>
        </div>
    );
}

function MiniChart({
    title,
    points,
    color,
    unit = ''
}: {
    title: string;
    points: number[];
    color: string;
    unit?: string;
}) {
    const width = 360;
    const height = 120;
    const max = Math.max(1, ...points);
    const path = points
        .map((v, i) => {
            const x = (i / Math.max(1, points.length - 1)) * width;
            const y = height - (v / max) * height;
            return `${x},${y}`;
        })
        .join(' ');
    const latest = points[points.length - 1] ?? 0;

    return (
        <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                    {latest.toFixed(1)}
                    {unit}
                </div>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full overflow-visible">
                <polyline
                    points={path}
                    fill="none"
                    stroke={color}
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.15}
                />
                <motion.polyline
                    points={path}
                    fill="none"
                    stroke={color}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    animate={{ points: path }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                />
            </svg>
        </div>
    );
}

function AdminStats() {
    const { data: stats } = useSuspenseQuery({
        ...adminStatsQueryOptions(),
        refetchInterval: 2000
    });
    const [history, setHistory] = useState<
        Array<{
            ts: number;
            cpuPercent: number;
            rssMb: number;
            incomingPerSec: number;
            outgoingPerSec: number;
            activeVideos: number;
        }>
    >([]);

    useEffect(() => {
        setHistory((prev) => {
            const now = Date.now();
            const minuteAgo = now - 60_000;
            const next = [
                ...prev.filter((point) => point.ts >= minuteAgo),
                {
                    ts: now,
                    cpuPercent: stats.system.cpuPercent,
                    rssMb: stats.system.rssMb,
                    incomingPerSec: stats.bus.incomingPerSec,
                    outgoingPerSec: stats.bus.outgoingPerSec,
                    activeVideos: stats.bus.activeVideos
                }
            ];
            return next;
        });
    }, [stats]);

    const uptimeMins = Math.floor(stats.uptime / 60);
    const uptimeHours = Math.floor(uptimeMins / 60);
    const uptimeDisplay =
        uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins % 60}m` : `${uptimeMins}m`;

    const cpuPoints = useMemo(() => history.map((h) => h.cpuPercent), [history]);
    const ramPoints = useMemo(() => history.map((h) => h.rssMb), [history]);
    const inPoints = useMemo(() => history.map((h) => h.incomingPerSec), [history]);
    const outPoints = useMemo(() => history.map((h) => h.outgoingPerSec), [history]);

    return (
        <div className="space-y-6">
            <h2 className="mb-2 text-sm font-medium tracking-wider text-muted-foreground uppercase">
                Database
            </h2>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Users" value={stats.db.users} />
                <StatCard label="Projects" value={stats.db.projects} />
                <StatCard label="Commits" value={stats.db.commits} />
                <StatCard label="Assets" value={stats.db.assets} />
            </div>

            <h2 className="mb-2 text-sm font-medium tracking-wider text-muted-foreground uppercase">
                Live Connections
            </h2>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Editors" value={stats.live.editor} />
                <StatCard label="Wall Nodes" value={stats.live.wall} />
                <StatCard label="Controllers" value={stats.live.controller} />
            </div>

            <h2 className="mb-2 text-sm font-medium tracking-wider text-muted-foreground uppercase">
                System
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <StatCard label="Server Uptime" value={uptimeDisplay} />
                <StatCard label="CPU Usage" value={`${stats.system.cpuPercent.toFixed(1)}%`} />
                <StatCard label="RAM RSS" value={`${stats.system.rssMb.toFixed(0)} MB`} />
                <StatCard label="Heap Used" value={`${stats.system.heapUsedMb.toFixed(0)} MB`} />
                <StatCard label="Active Videos" value={stats.bus.activeVideos} />
            </div>

            <h2 className="mb-2 text-sm font-medium tracking-wider text-muted-foreground uppercase">
                Bus Pressure
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Incoming / s" value={stats.bus.incomingPerSec.toFixed(1)} />
                <StatCard label="Outgoing / s" value={stats.bus.outgoingPerSec.toFixed(1)} />
                <StatCard label="Dirty Scopes" value={stats.bus.dirtyScopes} />
                <StatCard label="Video Sync Frames" value={stats.bus.videoSyncFrames} />
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <MiniChart title="CPU (%)" points={cpuPoints} color="#22c55e" unit="%" />
                <MiniChart title="RAM RSS (MB)" points={ramPoints} color="#3b82f6" unit="MB" />
                <MiniChart title="Bus Incoming Rate" points={inPoints} color="#f59e0b" unit="/s" />
                <MiniChart title="Bus Outgoing Rate" points={outPoints} color="#ef4444" unit="/s" />
            </div>
        </div>
    );
}
