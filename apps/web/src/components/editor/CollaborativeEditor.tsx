import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useAuth } from '@repo/auth/tanstack/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';

import { useEditorStore } from '~/lib/editorStore';

import { createWebsocketProvider, observeProviderStatus } from './providers';
import { TextEditor } from './TextEditor';
import {
    TEXT_HYDRATION_TIMEOUT_MS,
    transitionTextHydrationState,
    type TextHydrationState
} from './textHydrationState';
import theme from './theme';

const editorConfig = {
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
    const containerRef = useRef<HTMLDivElement | null>(null);
    const layer = useEditorStore((s) => s.layers.get(layerId));
    const textEditScope = useEditorStore(
        (s) => `${s.projectId}_${s.commitId}_${s.activeSlideId}_${layerId}`
    );
    const [userColor] = useState(() =>
        getDeterministicCursorColor(`${user?.email ?? ''}:${layerId}`)
    );
    const latestHeightRef = useRef<number>(layer?.type === 'text' ? layer.config.height : 400);

    const providerFactory = useCallback((id: string, yjsDocMap: Map<string, Y.Doc>) => {
        const provider = createWebsocketProvider(id, yjsDocMap);
        return provider;
    }, []);

    const [hydration, setHydration] = useState<TextHydrationState>('connecting');
    // Bumped to remount the collaboration plugin, which rebuilds the provider.
    const [attempt, setAttempt] = useState(0);

    const retryHydration = useCallback(() => {
        setHydration('connecting');
        setAttempt((current) => current + 1);
    }, []);

    if (!user) return null;

    useEffect(() => {
        return () => {
            onMeasuredHeight?.(latestHeightRef.current);
        };
    }, [onMeasuredHeight]);

    useEffect(() => {
        const unobserve = observeProviderStatus(textEditScope, (event) => {
            setHydration((current) => transitionTextHydrationState(current, event));
        });
        // Only a connection that never syncs is a failure; reconnects are handled
        // by the state machine and must not surface as errors.
        const timer = setTimeout(() => {
            setHydration((current) => transitionTextHydrationState(current, 'timeout'));
        }, TEXT_HYDRATION_TIMEOUT_MS);

        return () => {
            unobserve();
            clearTimeout(timer);
        };
    }, [textEditScope, attempt]);

    return (
        <div ref={containerRef}>
            <LexicalCollaboration>
                <LexicalComposer initialConfig={editorConfig}>
                    <CollaborationPlugin
                        key={`${textEditScope}:${attempt}`}
                        id={textEditScope}
                        providerFactory={providerFactory}
                        shouldBootstrap={false}
                        username={user.email}
                        cursorColor={userColor}
                        cursorsContainerRef={containerRef}
                    />
                    <TextEditor
                        layerId={layerId}
                        hydrationState={hydration}
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
