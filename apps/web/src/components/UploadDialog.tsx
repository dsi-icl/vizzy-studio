import {
    CloudArrowUpIcon,
    DeviceMobileIcon,
    CircleNotchIcon,
    UploadSimpleIcon,
    XIcon
} from '@phosphor-icons/react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogTitle,
    DialogTrigger
} from '@repo/ui/components/dialog';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { scrubInsecureTusResumeEntries } from '~/lib/tusClient';
import { $createUploadToken, $revokeUploadToken } from '~/server/projects.fns';

interface UploadDialogProps {
    projectId: string;
    trigger: React.ReactNode;
    onUploadComplete?: () => void;
    createTokenFn?: (projectId: string) => Promise<{ token: string; expiresAt: number }>;
    revokeTokenFn?: (token: string) => Promise<void>;
}

interface FileProgress {
    name: string;
    progress: number;
    status: 'uploading' | 'complete' | 'error';
}

function isWoff2File(file: File): boolean {
    return (
        file.type === 'font/woff2' ||
        file.name.toLowerCase().endsWith('.woff2') ||
        file.type === 'application/font-woff2'
    );
}

function isSvgFile(file: File): boolean {
    return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
}

export function UploadDialog({
    projectId,
    trigger,
    onUploadComplete,
    createTokenFn,
    revokeTokenFn
}: UploadDialogProps) {
    const [open, setOpen] = useState(false);
    const [token, setToken] = useState<string | null>(null);
    const [tokenExpiresAt, setTokenExpiresAt] = useState<number>(0);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState('');
    const [files, setFiles] = useState<FileProgress[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uppyRef = useRef<Uppy | null>(null);
    const onUploadCompleteRef = useRef(onUploadComplete);

    useEffect(() => {
        onUploadCompleteRef.current = onUploadComplete;
    }, [onUploadComplete]);

    const resetDialogState = useCallback(
        (tokenToRevoke?: string | null) => {
            if (tokenToRevoke) {
                const revoke = revokeTokenFn
                    ? revokeTokenFn(tokenToRevoke)
                    : $revokeUploadToken({ data: { token: tokenToRevoke } });
                revoke.catch(() => {});
            }
            if (uppyRef.current) {
                uppyRef.current.destroy();
                uppyRef.current = null;
            }
            setToken(null);
            setQrDataUrl(null);
            setFiles([]);
        },
        [revokeTokenFn]
    );

    // Create upload token when dialog opens
    useEffect(() => {
        if (!open) return;

        let cancelled = false;
        let issuedToken: string | undefined;
        const create = createTokenFn
            ? createTokenFn(projectId)
            : $createUploadToken({ data: { projectId } });

        create
            .then((result) => {
                issuedToken = result.token;
                if (cancelled) {
                    const revoke = revokeTokenFn
                        ? revokeTokenFn(result.token)
                        : $revokeUploadToken({ data: { token: result.token } });
                    void revoke.catch(() => {});
                    return null;
                }
                setToken(result.token);
                setTokenExpiresAt(result.expiresAt);

                const url = `${window.location.origin}/upload/${projectId}?token=${result.token}`;
                return QRCode.toDataURL(url, {
                    width: 240,
                    margin: 0,
                    errorCorrectionLevel: 'L',
                    color: {
                        dark: '#939393FF',
                        light: '#00000000'
                    }
                });
            })
            .then((dataUrl) => {
                if (!cancelled) setQrDataUrl(dataUrl);
            })
            .catch((error: any) => {
                if (cancelled) return;
                toast.error(error?.message ?? 'Failed to create upload token');
                setToken(null);
                setQrDataUrl(null);
            });
        return () => {
            cancelled = true;
            resetDialogState(issuedToken);
        };
    }, [open, projectId, createTokenFn, revokeTokenFn, resetDialogState]);

    // Countdown timer
    useEffect(() => {
        if (!tokenExpiresAt) return;
        const tick = () => {
            const remaining = Math.max(0, tokenExpiresAt - Date.now());
            const mins = Math.floor(remaining / 60000);
            const secs = Math.floor((remaining % 60000) / 1000);
            setTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);

            if (remaining <= 0) {
                setToken(null);
                setQrDataUrl(null);
                setTimeLeft('Expired');
            }
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [tokenExpiresAt]);

    const uploadFiles = useCallback(
        (selectedFiles: File[]) => {
            if (selectedFiles.length === 0) return;
            if (!token) {
                toast.error('Upload token missing or expired. Reopen the dialog to refresh it.');
                return;
            }
            scrubInsecureTusResumeEntries();

            let uppy = uppyRef.current;
            const shouldAttachHandlers = !uppy;
            if (!uppy) {
                uppy = new Uppy({
                    restrictions: { allowedFileTypes: ['image/*', '.svg', 'video/*', '.woff2'] }
                }).use(Tus, {
                    endpoint: '/api/uploads/',
                    chunkSize: 5 * 1024 * 1024,
                    // Avoid reusing stale absolute upload URLs from previous sessions
                    // (e.g. cached http:// links after moving behind HTTPS).
                    storeFingerprintForResuming: false,
                    removeFingerprintOnSuccess: true
                });
            }
            uppyRef.current = uppy;

            if (shouldAttachHandlers) {
                uppy.on('upload-progress', (file, progress) => {
                    if (!file || !progress.bytesTotal) return;
                    const pct = Math.round((progress.bytesUploaded / progress.bytesTotal) * 100);
                    setFiles((prev) =>
                        prev.map((f) => (f.name === file.name ? { ...f, progress: pct } : f))
                    );
                });

                uppy.on('upload-success', (file) => {
                    if (!file) return;
                    setFiles((prev) =>
                        prev.map((f) =>
                            f.name === file.name ? { ...f, progress: 100, status: 'complete' } : f
                        )
                    );
                });

                uppy.on('upload-error', (file, error) => {
                    if (!file) return;
                    setFiles((prev) =>
                        prev.map((f) => (f.name === file.name ? { ...f, status: 'error' } : f))
                    );
                    const message = error instanceof Error ? error.message : 'Upload failed';
                    toast.error(`${file.name}: ${message}`);
                });

                uppy.on('complete', (result) => {
                    const failed = result.failed?.length ?? 0;
                    const successful = result.successful?.length ?? 0;
                    if (successful > 0) onUploadCompleteRef.current?.();
                    if (failed > 0) {
                        toast.error(
                            successful > 0
                                ? `${successful} uploaded, ${failed} failed`
                                : `Upload failed (${failed} file${failed === 1 ? '' : 's'})`
                        );
                        return;
                    }
                    toast.success('Upload complete');
                });
            }

            const newEntries: FileProgress[] = [];

            for (const file of selectedFiles) {
                try {
                    uppy.addFile({
                        name: file.name,
                        type: file.type,
                        data: file,
                        meta: { projectId, uploadToken: token }
                    });
                    newEntries.push({ name: file.name, progress: 0, status: 'uploading' });
                } catch (e: any) {
                    toast.error(e.message);
                }
            }

            setFiles((prev) => [...prev, ...newEntries]);

            uppy.upload();
        },
        [projectId, token]
    );

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const droppedFiles = Array.from(e.dataTransfer.files).filter(
                (f) =>
                    f.type.startsWith('image/') ||
                    isSvgFile(f) ||
                    f.type.startsWith('video/') ||
                    isWoff2File(f)
            );
            uploadFiles(droppedFiles);
        },
        [uploadFiles]
    );

    const handleFileInput = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            if (e.target.files?.length) {
                uploadFiles(Array.from(e.target.files));
                e.target.value = '';
            }
        },
        [uploadFiles]
    );

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger nativeButton={false} render={<div />}>
                {trigger}
            </DialogTrigger>
            <DialogContent className="w-160 max-w-[90vw]">
                <div className="flex items-center justify-between border-b border-border px-6 py-4">
                    <DialogTitle className="flex items-center gap-2">
                        <CloudArrowUpIcon size={20} weight="bold" />
                        Upload Assets
                    </DialogTitle>
                    <DialogClose className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground">
                        <XIcon size={16} weight="bold" />
                    </DialogClose>
                </div>

                <div className="flex min-h-75 divide-x divide-border">
                    {/* Left: QR Code */}
                    <div className="flex w-1/2 flex-col items-center justify-center gap-3 p-6">
                        <DeviceMobileIcon
                            size={24}
                            weight="bold"
                            className="text-muted-foreground"
                        />
                        <p className="text-center text-xs text-muted-foreground">
                            Scan to upload from your phone
                        </p>
                        {qrDataUrl ? (
                            <img
                                src={qrDataUrl}
                                alt="Upload QR Code"
                                loading="eager"
                                fetchPriority="high"
                                decoding="async"
                                className="rounded-lg border border-border"
                                width={160}
                                height={160}
                            />
                        ) : (
                            <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-border">
                                <CircleNotchIcon
                                    size={24}
                                    className="animate-spin text-muted-foreground"
                                />
                            </div>
                        )}
                        {token && (
                            <div className="flex flex-col items-center gap-1">
                                <code className="rounded bg-muted px-2 py-1 font-mono text-xs tracking-widest">
                                    {token}
                                </code>
                                <span className="text-[10px] text-muted-foreground">
                                    Expires in {timeLeft}
                                </span>
                            </div>
                        )}
                        {!token && tokenExpiresAt > 0 && (
                            <p className="text-xs text-destructive">
                                Token expired. Close and reopen to get a new one.
                            </p>
                        )}
                    </div>

                    {/* Right: Drag & Drop */}
                    <div className="flex w-1/2 flex-col p-6">
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="image/*,.svg,video/*,.woff2"
                            className="hidden"
                            onChange={handleFileInput}
                        />

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragOver(true);
                            }}
                            onDragLeave={() => setDragOver(false)}
                            onDrop={handleDrop}
                            className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors ${
                                dragOver
                                    ? 'border-primary bg-primary/10'
                                    : 'border-border hover:border-primary/50'
                            }`}
                        >
                            <UploadSimpleIcon size={32} className="text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                                Drop files or click to browse
                            </span>
                            <span className="text-[10px] text-muted-foreground/60">
                                Images, videos, and WOFF2 fonts
                            </span>
                        </button>

                        {files.length > 0 && (
                            <div className="mt-3 max-h-32 space-y-1.5 overflow-y-auto">
                                {files.map((f, i) => (
                                    <div key={`${f.name}-${i}`} className="flex items-center gap-2">
                                        <div className="flex-1 truncate text-xs">{f.name}</div>
                                        {f.status === 'uploading' && (
                                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                                <div
                                                    className="h-full rounded-full bg-primary transition-all"
                                                    style={{ width: `${f.progress}%` }}
                                                />
                                            </div>
                                        )}
                                        {f.status === 'complete' && (
                                            <span className="text-[10px] text-green-500">Done</span>
                                        )}
                                        {f.status === 'error' && (
                                            <span className="text-[10px] text-destructive">
                                                Failed
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
