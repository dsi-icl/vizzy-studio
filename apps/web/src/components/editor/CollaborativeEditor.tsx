import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useAuth } from '@repo/auth/tanstack/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';

import { useEditorStore } from '~/lib/editorStore';

import { createWebsocketProvider, type LexicalWebsocketProvider } from './providers';
import { TextEditor } from './TextEditor';
import {
    TEXT_HYDRATION_TIMEOUT_MS,
    transitionTextHydrationState,
    type TextHydrationEvent,
    type TextHydrationState
} from './textHydrationState';
import theme from './theme';

const editorConfig = {
    editable: false,
    editorState: null,
    namespace: 'Vizzy Studio Text Bonanza',
    nodes: [],
    onError(error: Error) {
        throw error;
    },
    theme
};

function getDeterministicCursorColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const color = hash & 0xffffff;
    return `#${color.toString(16).padStart(6, '0')}`;
}

export function CollaborativeEditor({
    layerId,
    onMeasuredHeight
}: {
    layerId: number;
    onMeasuredHeight?: (height: number) => void;
}) {
    const { user } = useAuth();
    if (!user) return null;

    return (
        <AuthenticatedCollaborativeEditor
            layerId={layerId}
            onMeasuredHeight={onMeasuredHeight}
            userEmail={user.email}
        />
    );
}

function HydrationGatePlugin({ ready }: { ready: boolean }) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        editor.setEditable(ready);
        return () => editor.setEditable(false);
    }, [editor, ready]);

    return null;
}

function AuthenticatedCollaborativeEditor({
    layerId,
    onMeasuredHeight,
    userEmail
}: {
    layerId: number;
    onMeasuredHeight?: (height: number) => void;
    userEmail: string;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const providerRef = useRef<LexicalWebsocketProvider | null>(null);
    const destroyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const layer = useEditorStore((s) => s.layers.get(layerId));
    const textEditScope = useEditorStore(
        (s) => `${s.projectId}_${s.commitId}_${s.activeSlideId}_${layerId}`
    );
    const [hydrationState, setHydrationState] = useState<TextHydrationState>('connecting');
    const [userColor] = useState(() => getDeterministicCursorColor(`${userEmail}:${layerId}`));
    const latestHeightRef = useRef<number>(layer?.type === 'text' ? layer.config.height : 400);

    const transitionHydration = useCallback((event: TextHydrationEvent) => {
        setHydrationState((state) => transitionTextHydrationState(state, event));
    }, []);

    const providerFactory = useCallback(
        (id: string, yjsDocMap: Map<string, Y.Doc>) => {
            providerRef.current?.destroy();
            const provider = createWebsocketProvider(id, yjsDocMap);
            providerRef.current = provider;
            queueMicrotask(() => transitionHydration('attempt'));
            provider.on('sync', (synced: boolean) => {
                transitionHydration(synced ? 'synced' : 'interrupted');
            });
            provider.on('status', ({ status }: { status: string }) => {
                if (status !== 'connected') transitionHydration('interrupted');
            });
            provider.on('connection-error', () => transitionHydration('interrupted'));
            return provider;
        },
        [transitionHydration]
    );

    const retryHydration = useCallback(() => {
        const provider = providerRef.current;
        if (!provider) return;
        transitionHydration('attempt');
        provider.disconnect();
        provider.connect();
    }, [transitionHydration]);

    useEffect(() => {
        if (destroyTimerRef.current) {
            clearTimeout(destroyTimerRef.current);
            destroyTimerRef.current = null;
        }
        return () => {
            // Delay irreversible disposal by one task so React StrictMode's
            // effect replay can cancel it and reconnect the same provider.
            const provider = providerRef.current;
            destroyTimerRef.current = setTimeout(() => {
                provider?.destroy();
                if (providerRef.current === provider) providerRef.current = null;
            }, 0);
            onMeasuredHeight?.(latestHeightRef.current);
        };
    }, [onMeasuredHeight]);

    useEffect(() => {
        if (hydrationState !== 'connecting') return;
        const timeout = setTimeout(() => transitionHydration('timeout'), TEXT_HYDRATION_TIMEOUT_MS);
        return () => clearTimeout(timeout);
    }, [hydrationState, textEditScope, transitionHydration]);

    return (
        <div ref={containerRef}>
            <LexicalCollaboration key={textEditScope}>
                <LexicalComposer initialConfig={editorConfig}>
                    <CollaborationPlugin
                        id={textEditScope}
                        providerFactory={providerFactory}
                        shouldBootstrap={false}
                        username={userEmail}
                        cursorColor={userColor}
                        cursorsContainerRef={containerRef}
                    />
                    <HydrationGatePlugin ready={hydrationState === 'synced'} />
                    <TextEditor
                        layerId={layerId}
                        hydrationState={hydrationState}
                        onRetryHydration={retryHydration}
                        onMeasuredHeight={(height) => {
                            latestHeightRef.current = height;
                            onMeasuredHeight?.(height);
                        }}
                    />
                </LexicalComposer>
            </LexicalCollaboration>
        </div>
    );
}
