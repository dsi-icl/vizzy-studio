'use client';

import {
    CheckCircleIcon,
    CloudArrowUpIcon,
    CircleNotchIcon,
    UploadSimpleIcon,
    WarningCircleIcon
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import { useCallback, useEffect, useRef, useState } from 'react';

import { scrubInsecureTusResumeEntries } from '~/lib/tusClient';
import { $validateUploadToken } from '~/server/projects.fns';

export const Route = createFileRoute('/upload/$projectId')({
    head: () => ({
        meta: [{ title: 'Upload · Vizzy Studio' }]
    }),
    component: MobileUpload
});

interface FileProgress {
    name: string;
    progress: number;
    status: 'uploading' | 'complete' | 'error';
}

function MobileUpload() {
    const { projectId } = Route.useParams();
    const token =
        typeof window === 'undefined'
            ? null
            : new URLSearchParams(window.location.search).get('token');

    const [validating, setValidating] = useState(true);
    const [valid, setValid] = useState(false);
    const [userEmail, setUserEmail] = useState('');
    const [files, setFiles] = useState<FileProgress[]>([]);
    const [totalComplete, setTotalComplete] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uppyRef = useRef<Uppy | null>(null);

    // Validate the token on mount
    useEffect(() => {
        if (!token) {
            setValidating(false);
            return;
        }
        $validateUploadToken({ data: { token } })
            .then((result) => {
                if (result && result.projectId === projectId) {
                    setValid(true);
                    setUserEmail(result.userEmail);
                }
            })
            .catch(() => {})
            .finally(() => setValidating(false));
    }, [token, projectId]);

    const uploadFiles = useCallback(
        (selectedFiles: File[]) => {
            if (selectedFiles.length === 0 || !token) return;
            scrubInsecureTusResumeEntries();

            const uppy =
                uppyRef.current ??
                new Uppy({
                    restrictions: { allowedFileTypes: ['image/*', '.svg', 'video/*'] }
                }).use(Tus, {
                    endpoint: '/api/uploads/',
                    chunkSize: 5 * 1024 * 1024,
                    // Avoid reusing stale absolute upload URLs from previous sessions
                    // (e.g. cached http:// links after moving behind HTTPS).
                    storeFingerprintForResuming: false,
                    removeFingerprintOnSuccess: true
                });
            uppyRef.current = uppy;

            const newEntries: FileProgress[] = [];

            for (const file of selectedFiles) {
                try {
                    uppy.addFile({
                        name: file.name,
                        type: file.type,
                        data: file,
                        meta: {
                            projectId,
                            userEmail,
                            uploadToken: token
                        }
                    });
                    newEntries.push({ name: file.name, progress: 0, status: 'uploading' });
                } catch {
                    // duplicate or invalid file
                }
            }

            setFiles((prev) => [...prev, ...newEntries]);

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
                setTotalComplete((c) => c + 1);
            });

            uppy.on('upload-error', (file) => {
                if (!file) return;
                setFiles((prev) =>
                    prev.map((f) => (f.name === file.name ? { ...f, status: 'error' } : f))
                );
            });

            uppy.upload();
        },
        [projectId, userEmail, token]
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

    // Loading state
    if (validating) {
        return (
            <div className="container flex min-h-svh min-w-full flex-col pt-18 pb-13">
                <div className="flex h-full grow items-center justify-center bg-background p-4">
                    <CircleNotchIcon size={32} className="animate-spin text-muted-foreground" />
                </div>
            </div>
        );
    }

    // Invalid token
    if (!valid) {
        return (
            <div className="container flex min-h-svh min-w-full flex-col pt-18 pb-13">
                <div className="flex h-full grow flex-col items-center justify-center gap-4 bg-background p-6 text-center">
                    <WarningCircleIcon size={48} className="text-destructive" />
                    <h1 className="text-lg font-semibold">Upload link expired</h1>
                    <p className="max-w-xs text-sm text-muted-foreground">
                        Sorry, this upload link is no longer valid. Please scan a new QR code from
                        the editor.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="container flex min-h-svh min-w-full flex-col pt-18 pb-13">
            <div className="flex h-full grow flex-col bg-background">
                {/* Header */}
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                    <CloudArrowUpIcon size={24} weight="bold" className="text-primary" />
                    <span className="font-semibold">Mobile Upload</span>
                </div>

                {/* Upload area */}
                <div className="flex flex-1 flex-col gap-4 p-4">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,.svg,video/*"
                        className="hidden"
                        onChange={handleFileInput}
                    />

                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border p-8 transition-colors active:border-primary active:bg-primary/10"
                    >
                        <UploadSimpleIcon size={48} className="text-muted-foreground" />
                        <span className="text-sm font-medium">Tap to select files</span>
                        <span className="text-xs text-muted-foreground">Images and videos</span>
                    </button>

                    {/* File list */}
                    {files.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground">
                                {totalComplete} of {files.length} uploaded
                            </div>
                            {files.map((f, i) => (
                                <div
                                    key={`${f.name}-${i}`}
                                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                                >
                                    {f.status === 'complete' && (
                                        <CheckCircleIcon
                                            size={20}
                                            weight="fill"
                                            className="shrink-0 text-green-500"
                                        />
                                    )}
                                    {f.status === 'error' && (
                                        <WarningCircleIcon
                                            size={20}
                                            weight="fill"
                                            className="shrink-0 text-destructive"
                                        />
                                    )}
                                    {f.status === 'uploading' && (
                                        <CircleNotchIcon
                                            size={20}
                                            className="shrink-0 animate-spin text-primary"
                                        />
                                    )}
                                    <div className="flex flex-1 flex-col gap-1 overflow-hidden">
                                        <span className="truncate text-sm">{f.name}</span>
                                        {f.status === 'uploading' && (
                                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                                                <div
                                                    className="h-full rounded-full bg-primary transition-all"
                                                    style={{ width: `${f.progress}%` }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
