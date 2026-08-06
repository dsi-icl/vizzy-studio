import { Button } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

function TipButton({
    tip,
    tipSide,
    children,
    ...props
}: { tip: string; tipSide?: Parameters<typeof TooltipContent>[0]['side'] } & React.ComponentProps<
    typeof Button
>) {
    return (
        <Tooltip>
            {/* Deliberately no aria-label from `tip`: these buttons are often
                nested inside a larger button whose accessible name is composed
                from its descendants, so labelling them all would rename the
                ancestor. Set aria-label per button where it is needed. */}
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" {...props} />}>
                {children}
            </TooltipTrigger>
            <TooltipContent side={tipSide}>{tip}</TooltipContent>
        </Tooltip>
    );
}

export { TipButton };
