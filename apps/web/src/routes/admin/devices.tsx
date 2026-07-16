import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { $adminDeleteDevice } from '~/server/admin.fns';
import { adminDevicesQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/devices')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminDevicesQueryOptions());
    },
    component: AdminDevices,
    head: () => ({
        meta: [{ title: 'Devices · Admin · Vizzy Studio' }]
    })
});

function AdminDevices() {
    const { data: devices } = useSuspenseQuery(adminDevicesQueryOptions());
    const queryClient = useQueryClient();
    const [deleteTargetDeviceId, setDeleteTargetDeviceId] = useState<string | null>(null);
    const deleteDeviceMutation = useMutation({
        mutationFn: async (id: string) => $adminDeleteDevice({ data: { id } }),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: adminDevicesQueryOptions().queryKey }),
                queryClient.invalidateQueries({ queryKey: ['admin', 'walls'] })
            ]);
            toast.success('Device deleted');
            setDeleteTargetDeviceId(null);
        },
        onError: (error: any) => {
            toast.error(error?.message ?? 'Failed to delete device');
        }
    });

    return (
        <div className="space-y-6">
            {devices.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No devices registered
                </div>
            ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-muted-foreground">
                            <tr>
                                <th className="px-4 py-3 text-left font-medium">Device ID</th>
                                <th className="px-4 py-3 text-left font-medium">Kind</th>
                                <th className="px-4 py-3 text-left font-medium">Status</th>
                                <th className="px-4 py-3 text-left font-medium">Assigned Wall</th>
                                <th className="px-4 py-3 text-left font-medium">Last Seen</th>
                                <th className="px-4 py-3 text-left font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {(devices as Array<any>).map((device) => (
                                <tr key={device.id} className="hover:bg-muted/30">
                                    <td className="px-4 py-3 font-mono text-xs">{device.id}</td>
                                    <td className="px-4 py-3 capitalize">{device.kind}</td>
                                    <td className="px-4 py-3 capitalize">{device.status}</td>
                                    <td className="px-4 py-3">
                                        {device.assignedWallId ? (
                                            (() => {
                                                const wallId = device.assignedWallId;
                                                return (
                                                    <Link
                                                        to="/admin/walls/$wallId"
                                                        params={{ wallId }}
                                                        className="font-mono text-xs underline-offset-2 hover:underline"
                                                    >
                                                        {device.assignedWallId}
                                                    </Link>
                                                );
                                            })()
                                        ) : (
                                            <span className="text-muted-foreground">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-muted-foreground">
                                        <DateDisplay value={device.lastSeenAt} />
                                    </td>
                                    <td className="px-4 py-3">
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={deleteDeviceMutation.isPending}
                                            onClick={() => setDeleteTargetDeviceId(device.id)}
                                        >
                                            Delete
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog
                open={deleteTargetDeviceId !== null}
                onOpenChange={(open) => {
                    if (!open) setDeleteTargetDeviceId(null);
                }}
            >
                <DialogContent className="w-80 p-5">
                    <DialogTitle>Delete device</DialogTitle>
                    <DialogDescription className="mt-1">
                        {`Delete device "${deleteTargetDeviceId ?? ''}" permanently?`}
                    </DialogDescription>
                    <div className="mt-4 flex justify-end gap-2">
                        <DialogClose>
                            <Button variant="outline" size="sm">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleteDeviceMutation.isPending}
                            onClick={() => {
                                if (deleteTargetDeviceId) {
                                    deleteDeviceMutation.mutate(deleteTargetDeviceId);
                                }
                            }}
                        >
                            {deleteDeviceMutation.isPending ? 'Deleting...' : 'Delete'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
