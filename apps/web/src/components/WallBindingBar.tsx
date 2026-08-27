import {
    ArrowsClockwiseIcon,
    CircleNotchIcon,
    MonitorIcon,
    WarningCircleIcon
} from '@phosphor-icons/react';
import { TipButton } from '@repo/ui/components/tip-button';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useBindableWalls, WallPickerPopover } from '~/components/WallPicker';
import type { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';

interface WallBindingBarProps {
    engine: EditorEngine | null;
    boundWallId: string | null;
}

export function WallBindingBar({ engine, boundWallId }: WallBindingBarProps) {
    const { walls: bindableWalls, isLoading: wallsLoading } = useBindableWalls();
    const [bindPending, setBindPending] = useState<{ requestId: string; wallId: string } | null>(
        null
    );
    const [lastBindAttempt, setLastBindAttempt] = useState<{
        wallId: string;
        projectId: string;
        commitId: string;
        slideId: string;
        denied: boolean;
    } | null>(null);
    const ignoredBindRequestIdsRef = useRef<Set<string>>(new Set());

    const handleWallSelect = (wallId: string) => {
        if (!engine) return;
        const { projectId, commitId, activeSlideId } = useEditorStore.getState();
        if (!projectId || !commitId || !activeSlideId) return;
        engine.bindWall(wallId, projectId, commitId, activeSlideId);
        const requestId = engine.getLastBindRequestId();
        if (requestId) {
            setBindPending({ requestId, wallId });
            setLastBindAttempt({
                wallId,
                projectId,
                commitId,
                slideId: activeSlideId,
                denied: false
            });
        }
    };

    const handleWallUnbind = () => {
        if (!engine) return;
        engine.unbindWall();
        useEditorStore.setState({ boundWallId: null });
        setBindPending(null);
    };

    const retryWallBind = () => {
        if (!engine || !lastBindAttempt) return;
        engine.bindWall(
            lastBindAttempt.wallId,
            lastBindAttempt.projectId,
            lastBindAttempt.commitId,
            lastBindAttempt.slideId
        );
        const requestId = engine.getLastBindRequestId();
        if (requestId) {
            setBindPending({ requestId, wallId: lastBindAttempt.wallId });
            setLastBindAttempt((prev) => (prev ? { ...prev, denied: false } : prev));
        }
    };

    const cancelPendingBind = () => {
        if (bindPending) {
            ignoredBindRequestIdsRef.current.add(bindPending.requestId);
        }
        setBindPending(null);
    };

    useEffect(() => {
        if (!engine) return;
        return engine.onBindOverrideResult((result) => {
            if (ignoredBindRequestIdsRef.current.has(result.requestId)) return;
            if (!bindPending || bindPending.requestId !== result.requestId) return;

            if (result.allow) {
                setBindPending(null);
                setLastBindAttempt((prev) => (prev ? { ...prev, denied: false } : prev));
                if (result.reason === 'approved') {
                    toast.success('Takeover approved. Your deck is now live.');
                }
                return;
            }

            setBindPending(null);
            setLastBindAttempt((prev) => (prev ? { ...prev, denied: true } : prev));
            if (result.reason === 'timeout') {
                toast.error('No response in time. The takeover request expired.');
            } else if (result.reason === 'denied') {
                toast.error('Takeover request declined.');
            } else if (result.reason === 'unknown_wall') {
                toast.error('This wall no longer exists.');
            } else {
                toast.error('Could not complete the takeover request.');
            }
        });
    }, [engine, bindPending]);

    useEffect(() => {
        if (boundWallId) {
            setBindPending(null);
            setLastBindAttempt((prev) => (prev ? { ...prev, denied: false } : prev));
        }
    }, [boundWallId]);

    const canBindSomeWall =
        bindableWalls.some((wall) => wall.wallId === boundWallId) ||
        (!boundWallId && bindableWalls.length > 0);
    if (wallsLoading || !canBindSomeWall) return null;

    if (boundWallId) {
        return (
            <TipButton tip="Disconnect wall" variant="outline" onClick={handleWallUnbind}>
                <MonitorIcon weight="fill" className="text-green-500" />
            </TipButton>
        );
    }

    if (bindPending) {
        return (
            <div className="flex items-center gap-1">
                <TipButton tip={`Awaiting approval for ${bindPending.wallId}`} variant="outline">
                    <CircleNotchIcon className="animate-spin" />
                </TipButton>
                <TipButton tip="Cancel pending bind request" onClick={cancelPendingBind}>
                    <WarningCircleIcon />
                </TipButton>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-1">
            <WallPickerPopover
                onSelect={handleWallSelect}
                trigger={
                    <TipButton tip="Launch live preview">
                        <MonitorIcon />
                    </TipButton>
                }
            />
            {lastBindAttempt?.denied ? (
                <TipButton tip="Retry last bind request" onClick={retryWallBind}>
                    <ArrowsClockwiseIcon />
                </TipButton>
            ) : null}
        </div>
    );
}
