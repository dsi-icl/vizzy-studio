import SideButtonNumberField from '@repo/ui/components/number-field';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { TipButton } from '@repo/ui/components/tip-button';

interface RectangleCornerRadiusToolProps {
    cornerRadius: number;
    setCornerRadius: (radius: number) => void;
}

export function RectangleCornerRadiusTool({
    cornerRadius,
    setCornerRadius
}: RectangleCornerRadiusToolProps) {
    const previewRadius = Math.min(8, Math.max(0, cornerRadius / 5));

    return (
        <Popover>
            <PopoverTrigger nativeButton={false} render={<div />}>
                <TipButton
                    tip="Rectangle corner radius"
                    aria-label="Rectangle corner radius"
                    variant="outline"
                    size="sm"
                >
                    <svg
                        width="32"
                        height="20"
                        viewBox="0 0 32 20"
                        aria-hidden="true"
                        className="w-auto!"
                    >
                        <rect
                            x="2"
                            y="2"
                            width="28"
                            height="16"
                            rx={previewRadius}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        />
                    </svg>
                </TipButton>
            </PopoverTrigger>
            <PopoverContent className="w-fit p-3" side="bottom" align="start">
                <SideButtonNumberField
                    label="Corner radius"
                    value={cornerRadius}
                    min={0}
                    step={5}
                    smallStep={1}
                    allowWheelScrub
                    onValueChange={(value) => {
                        if (value !== null) setCornerRadius(Math.max(0, value));
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}
