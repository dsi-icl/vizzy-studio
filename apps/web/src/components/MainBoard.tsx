import { CircleNotchIcon } from '@phosphor-icons/react';

import { useFonts } from '~/hooks/useFonts';
import { useEditorStore } from '~/lib/editorStore';

import { ConnectionBanner } from './ConnectionBanner';
import { EditorSlate } from './EditorSlate';
import { TextEditorDialog } from './TextEditorDialog';

export function MainBoard() {
    const loading = useEditorStore((s) => s.loading);
    useFonts(useEditorStore((s) => s.projectId));

    return (
        <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-card/20">
            <ConnectionBanner />
            <EditorSlate />
            {loading && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                    <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 shadow-lg">
                        <CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                        <span className="text-sm font-medium text-muted-foreground">
                            Loading slide...
                        </span>
                    </div>
                </div>
            )}
            <TextEditorWrapper />
        </main>
    );
}

function TextEditorWrapper() {
    const projectId = useEditorStore((s) => s.projectId);
    const commitId = useEditorStore((s) => s.commitId);
    const activeSlideId = useEditorStore((s) => s.activeSlideId);
    const editingTextLayerId = useEditorStore((s) => s.editingTextLayerId);
    const stopTextEditing = useEditorStore((s) => s.stopTextEditing);

    if (editingTextLayerId === null) return null;
    return (
        <TextEditorDialog
            key={`txt_edit_${projectId}/${commitId}/${activeSlideId}/${editingTextLayerId}`}
            layerId={editingTextLayerId}
            open
            onOpenChange={(open) => {
                if (!open) stopTextEditing();
            }}
        />
    );
}
