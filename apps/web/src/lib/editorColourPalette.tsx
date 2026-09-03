import { useCallback, useMemo, type ReactNode } from 'react';

import { ColourPaletteContext, type ColourPalette } from '~/components/ColourPicker';

import { EditorEngine } from './editorEngine';
import { useEditorStore } from './editorStore';

export function EditorColourPaletteProvider({ children }: { children: ReactNode }) {
    const recentColours = useEditorStore((s) => s.recentColours);

    const onRecordColour = useCallback((colour: string) => {
        EditorEngine.getInstance().sendJSON({ type: 'record_colour', colour });
    }, []);

    const value = useMemo<ColourPalette>(
        () => ({ recentColours, onRecordColour }),
        [recentColours, onRecordColour]
    );

    return <ColourPaletteContext.Provider value={value}>{children}</ColourPaletteContext.Provider>;
}
