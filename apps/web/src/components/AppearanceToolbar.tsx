import { useShallow } from 'zustand/react/shallow';

import { useEditorStore } from '~/lib/editorStore';

import { ColorPickerPopover } from './ColourPicker';
import { RectangleCornerRadiusTool } from './RectangleCornerRadiusTool';
import { StrokeTool } from './StrokeTool';

export function AppearanceToolbar({
    showRectangleCornerRadius
}: {
    showRectangleCornerRadius: boolean;
}) {
    const {
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
