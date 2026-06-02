import { useShallow } from 'zustand/react/shallow';

import { useEditorStore } from '~/lib/editorStore';

import { ColorPickerPopover } from './ColourPicker';
import { EraserTool } from './EraserTool';
import { StrokeTool } from './StrokeTool';

export function AppearanceToolbar() {
    const {
        isErasing,
        eraserWidth,
        setEraserWidth,
        shapeFill,
        setShapeFill,
        strokeColor,
        setStrokeColor,
        strokeWidth,
        setStrokeWidth,
        strokeDash,
        setStrokeDash
    } = useEditorStore(
        useShallow((s) => ({
            isErasing: s.isErasing,
            eraserWidth: s.eraserWidth,
            setEraserWidth: s.setEraserWidth,
            shapeFill: s.shapeFill,
            setShapeFill: s.setShapeFill,
            strokeColor: s.strokeColor,
            setStrokeColor: s.setStrokeColor,
            strokeWidth: s.strokeWidth,
            setStrokeWidth: s.setStrokeWidth,
            strokeDash: s.strokeDash,
            setStrokeDash: s.setStrokeDash
        }))
    );

    if (isErasing) {
        return (
            <div className="flex items-center gap-2">
                <EraserTool eraserWidth={eraserWidth} setEraserWidth={setEraserWidth} />
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <ColorPickerPopover value={shapeFill} onChange={setShapeFill} />
            <StrokeTool
                strokeColor={strokeColor}
                setStrokeColor={setStrokeColor}
                strokeWidth={strokeWidth}
                setStrokeWidth={setStrokeWidth}
                strokeDash={strokeDash}
                setStrokeDash={setStrokeDash}
            />
        </div>
    );
}
