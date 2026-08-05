import { useShallow } from 'zustand/react/shallow';

import { useEditorStore } from '~/lib/editorStore';

import { ColorPickerPopover } from './ColourPicker';
import { EraserTool } from './EraserTool';
import { RectangleCornerRadiusTool } from './RectangleCornerRadiusTool';
import { StrokeTool } from './StrokeTool';

export function AppearanceToolbar({
    showRectangleCornerRadius
}: {
    showRectangleCornerRadius: boolean;
}) {
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
        setStrokeDash,
        rectangleCornerRadius,
        setRectangleCornerRadius
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
            setStrokeDash: s.setStrokeDash,
            rectangleCornerRadius: s.rectangleCornerRadius,
            setRectangleCornerRadius: s.setRectangleCornerRadius
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
            {showRectangleCornerRadius ? (
                <RectangleCornerRadiusTool
                    cornerRadius={rectangleCornerRadius}
                    setCornerRadius={setRectangleCornerRadius}
                />
            ) : null}
        </div>
    );
}
