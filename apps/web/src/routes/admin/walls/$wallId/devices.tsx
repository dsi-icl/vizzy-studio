import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { $adminDeleteDevice, $adminDevicesEnrollBySignature } from '~/server/admin.fns';
import {
    adminDevicesForWallQueryOptions,
    adminDevicesQueryOptions,
    adminWallQueryOptions
} from '~/server/admin.queries';

const Scanner = lazy(async () => {
    const [{ configureQrScannerWasm }, { Scanner: ScannerComponent }] = await Promise.all([
        import('~/lib/qrScannerWasm'),
        import('@yudiel/react-qr-scanner')
    ]);
    configureQrScannerWasm();
    return { default: ScannerComponent };
});

export const Route = createFileRoute('/admin/walls/$wallId/devices')({
    loader: async ({ context, params }) => {
        const wall = await context.queryClient.ensureQueryData(
            adminWallQueryOptions(params.wallId)
        );
        context.queryClient.ensureQueryData(adminDevicesForWallQueryOptions(params.wallId));
        return {
            wallName: wall?.name || wall?.wallId || 'Wall'
        };
    },
    head: ({ loaderData }) => ({
        meta: [{ title: `Wall Devices · ${loaderData?.wallName ?? 'Wall'} · Admin · Vizzy Studio` }]
    }),
    component: WallDevicesTab
});

function WallDevicesTab() {
    const { wallId } = Route.useParams();
    const queryClient = useQueryClient();
    const { data: devices } = useSuspenseQuery(adminDevicesForWallQueryOptions(wallId));
    const { data: allDevices = [] } = useQuery(adminDevicesQueryOptions());
    const [scanDialogOpen, setScanDialogOpen] = useState(false);
    const [deleteTargetDeviceId, setDeleteTargetDeviceId] = useState<string | null>(null);
    const [scanStatus, setScanStatus] = useState<string>('Ready to scan');
    const [cameraPermission, setCameraPermission] = useState<
        'unknown' | 'prompt' | 'granted' | 'denied'
    >('unknown');
    const [cameraReady, setCameraReady] = useState(false);
    const [scannerKey, setScannerKey] = useState(0);
    const [scanEvents, setScanEvents] = useState<Array<{ id: string; text: string; ok: boolean }>>(
        []
    );
    const [qrDetections, setQrDetections] = useState(0);
    const [qrDetectedFlash, setQrDetectedFlash] = useState(false);
    const seenPayloadsRef = useRef(new Set<string>());
    const processingRef = useRef(false);
    const qrFlashTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        if (!scanDialogOpen) return;
        setScanStatus('Checking camera access...');
        setCameraPermission('unknown');
        setCameraReady(false);
        seenPayloadsRef.current.clear();
        setScanEvents([]);
        setQrDetections(0);
        setQrDetectedFlash(false);

        void (async () => {
            try {
                const permissionsApi = (navigator as any).permissions;
                if (!permissionsApi?.query) {
                    setScanStatus('Allow camera access to scan device QR codes.');
                    return;
                }

                const permission = await permissionsApi.query({ name: 'camera' });
                const nextState = permission.state as 'prompt' | 'granted' | 'denied';
                setCameraPermission(nextState);

                if (nextState === 'granted') {
                    setScanStatus('Scanning... Keep moving between screens.');
                    setCameraReady(true);
                } else if (nextState === 'prompt') {
                    setScanStatus('Tap Enable Camera to continue.');
                } else {
                    setScanStatus('Camera access is blocked. Enable camera permission and retry.');
                }
            } catch {
                setScanStatus('Tap Enable Camera to continue.');
            }
        })();
    }, [scanDialogOpen]);

    useEffect(
        () => () => {
            if (qrFlashTimeoutRef.current != null) {
                window.clearTimeout(qrFlashTimeoutRef.current);
                qrFlashTimeoutRef.current = null;
            }
        },
        []
    );

    const requestCameraPermission = async () => {
        setScanStatus('Requesting camera access...');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            for (const track of stream.getTracks()) track.stop();
            setCameraPermission('granted');
            setCameraReady(true);
            setScanStatus('Scanning... Keep moving between screens.');
            setScannerKey((current) => current + 1);
        } catch (error: any) {
            const errorName = error?.name ?? '';
            if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
                setCameraPermission('denied');
                setCameraReady(false);
                setScanStatus('Camera access is blocked. Enable camera permission and retry.');
                return;
            }
            setCameraReady(false);
            setScanStatus('Camera unavailable. Check permissions and retry.');
        }
    };

    const pushEvent = (text: string, ok: boolean) => {
        setScanEvents((prev) =>
            [{ id: `${Date.now()}-${Math.random()}`, text, ok }, ...prev].slice(0, 20)
        );
    };

    const signalQrDetected = () => {
        setQrDetections((current) => current + 1);
        setQrDetectedFlash(true);
        if (qrFlashTimeoutRef.current != null) {
            window.clearTimeout(qrFlashTimeoutRef.current);
        }
        qrFlashTimeoutRef.current = window.setTimeout(() => {
            setQrDetectedFlash(false);
            qrFlashTimeoutRef.current = null;
        }, 1200);
    };

    const parsePayload = (raw: string) => {
        try {
            const parsed = JSON.parse(raw) as {
                did?: string;
                sig?: string;
            };
            const id = parsed.did;
            const signature = parsed.sig;
            if (typeof id !== 'string' || typeof signature !== 'string') {
                return null;
            }
            return {
                id,
                signature
            } as const;
        } catch {
            return null;
        }
    };

    const handleScan = async (detectedCodes: IDetectedBarcode[]) => {
        if (!scanDialogOpen || processingRef.current) return;
        if (cameraPermission !== 'granted' && cameraPermission !== 'prompt') return;

        for (const detection of detectedCodes) {
            const raw = detection.rawValue?.trim();
            if (!raw || seenPayloadsRef.current.has(raw)) continue;
            seenPayloadsRef.current.add(raw);
            signalQrDetected();
            setScanStatus('QR detected. Validating payload...');
            const payload = parsePayload(raw);
            if (!payload) {
                setScanStatus('Detected QR code is not a valid enrollment payload.');
                pushEvent('Skipped: QR is not a valid enrollment payload', false);
                continue;
            }
            const knownDevice = (
                allDevices as Array<{ id: string; kind?: 'wall' | 'gallery' | 'controller' }>
            ).find((d) => d.id === payload.id);
            if (!knownDevice) {
                setScanStatus('QR detected, but this device ID is not registered.');
                pushEvent(`Failed ${payload.id.slice(0, 8)}...: unknown device`, false);
                continue;
            }
            const kind = knownDevice.kind;
            if (!kind) {
                setScanStatus('QR detected, but device kind is missing.');
                pushEvent(`Failed ${payload.id.slice(0, 8)}...: missing device kind`, false);
                continue;
            }

            processingRef.current = true;
            try {
                setScanStatus(`QR detected for ${payload.id.slice(0, 8)}... enrolling...`);
                await $adminDevicesEnrollBySignature({
                    data: {
                        id: payload.id,
                        signature: payload.signature,
                        kind,
                        wallId
                    }
                });
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: adminDevicesForWallQueryOptions(wallId).queryKey
                    }),
                    queryClient.invalidateQueries({ queryKey: ['admin', 'devices'] }),
                    queryClient.invalidateQueries({ queryKey: ['admin', 'walls'] })
                ]);
                pushEvent(`Enrolled ${payload.id.slice(0, 8)}...`, true);
                setScanStatus('Enrollment succeeded. Continue scanning.');
                toast.success(`Device enrolled: ${payload.id.slice(0, 8)}...`);
            } catch (error: any) {
                setScanStatus('Enrollment failed. Continue scanning.');
                pushEvent(
                    `Failed ${payload.id.slice(0, 8)}...: ${error?.message ?? 'Unknown error'}`,
                    false
                );
            } finally {
                processingRef.current = false;
            }
        }
    };

    const deleteDeviceMutation = useMutation({
        mutationFn: async (id: string) => $adminDeleteDevice({ data: { id } }),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: adminDevicesForWallQueryOptions(wallId).queryKey
                }),
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
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button onClick={() => setScanDialogOpen(true)}>Enroll Devices</Button>
            </div>
            <div className="rounded-lg border border-border">
                {(devices as Array<any>).length === 0 ? (
                    <div className="p-8 text-center text-sm text-muted-foreground">
                        No devices assigned to this wall yet.
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-muted-foreground">
                            <tr>
                                <th className="px-4 py-3 text-left font-medium">Device ID</th>
                                <th className="px-4 py-3 text-left font-medium">Kind</th>
                                <th className="px-4 py-3 text-left font-medium">Status</th>
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
                )}
            </div>

            <Dialog open={scanDialogOpen} onOpenChange={setScanDialogOpen}>
                <DialogContent className="w-[calc(100vw-0.5rem)] max-w-[calc(100vw-0.5rem)] p-4 sm:max-w-xl sm:p-5">
                    <DialogTitle>Enroll Devices</DialogTitle>
                    <DialogDescription className="mt-1">
                        Point your camera at each screen QR code. Scanning stays active until you
                        press Done.
                    </DialogDescription>

                    <div className="mt-4 space-y-3">
                        <div className="overflow-hidden rounded-lg border border-border bg-black">
                            {cameraReady ? (
                                <Suspense
                                    fallback={
                                        <div className="flex h-88 w-full items-center justify-center text-sm text-muted-foreground sm:h-104">
                                            Initializing scanner...
                                        </div>
                                    }
                                >
                                    <Scanner
                                        key={scannerKey}
                                        onScan={(codes) => void handleScan(codes)}
                                        onError={(error: any) => {
                                            const errorName = error?.name ?? '';
                                            if (
                                                errorName === 'NotAllowedError' ||
                                                errorName === 'PermissionDeniedError'
                                            ) {
                                                setCameraPermission('denied');
                                                setCameraReady(false);
                                                setScanStatus(
                                                    'Camera access is blocked. Enable camera permission and retry.'
                                                );
                                                return;
                                            }

                                            setScanStatus(
                                                'Camera unavailable. Check permissions and retry.'
                                            );
                                        }}
                                        constraints={{ facingMode: { ideal: 'environment' } }}
                                        formats={['qr_code']}
                                        sound={false}
                                        paused={!scanDialogOpen || cameraPermission === 'denied'}
                                        scanDelay={250}
                                        classNames={{
                                            container: 'h-[22rem] w-full sm:h-[26rem]',
                                            video: 'h-[22rem] w-full object-cover sm:h-[26rem]'
                                        }}
                                    />
                                </Suspense>
                            ) : (
                                <div className="flex h-88 w-full items-center justify-center text-sm text-muted-foreground sm:h-104">
                                    Camera is not active yet.
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">{scanStatus}</p>
                        <div className="flex items-center justify-between rounded border border-border bg-muted/20 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2">
                                <span
                                    className={`h-2 w-2 rounded-full ${
                                        qrDetectedFlash
                                            ? 'bg-emerald-500'
                                            : 'bg-muted-foreground/40'
                                    }`}
                                />
                                <span
                                    className={
                                        qrDetectedFlash
                                            ? 'font-medium text-emerald-600'
                                            : 'text-muted-foreground'
                                    }
                                >
                                    {qrDetectedFlash ? 'QR code detected' : 'Waiting for QR code'}
                                </span>
                            </div>
                            <span className="text-muted-foreground">Detected: {qrDetections}</span>
                        </div>
                        <div className="max-h-40 overflow-auto rounded border border-border bg-muted/20 p-2 text-xs">
                            {scanEvents.length === 0 ? (
                                <div className="text-muted-foreground">No scans yet.</div>
                            ) : (
                                <div className="space-y-1">
                                    {scanEvents.map((event) => (
                                        <div
                                            key={event.id}
                                            className={
                                                event.ok ? 'text-emerald-600' : 'text-rose-600'
                                            }
                                        >
                                            {event.text}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="mt-4 flex justify-end gap-3">
                        {!cameraReady ? (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void requestCameraPermission()}
                            >
                                Enable Camera
                            </Button>
                        ) : null}
                        {cameraPermission === 'denied' ? (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void requestCameraPermission()}
                            >
                                Retry Camera
                            </Button>
                        ) : null}
                        <Button variant="outline" onClick={() => setScanDialogOpen(false)}>
                            Done
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

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
