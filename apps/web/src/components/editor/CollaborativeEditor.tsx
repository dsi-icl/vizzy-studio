import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useAuth } from '@repo/auth/tanstack/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';

import { useEditorStore } from '~/lib/editorStore';

import { createWebsocketProvider } from './providers';
import { TextEditor } from './TextEditor';
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

    if (!user) return null;

    useEffect(() => {
        return () => {
            onMeasuredHeight?.(latestHeightRef.current);
        };
    }, [onMeasuredHeight]);

    return (
        <div ref={containerRef}>
            <LexicalCollaboration>
                <LexicalComposer initialConfig={editorConfig}>
                    <CollaborationPlugin
                        id={textEditScope}
                        providerFactory={providerFactory}
                        shouldBootstrap={false}
                        username={user.email}
                        cursorColor={userColor}
                        cursorsContainerRef={containerRef}
                    />
                    <TextEditor
                        layerId={layerId}
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
