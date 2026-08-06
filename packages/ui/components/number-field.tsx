'use client';

import { NumberField, NumberFieldRootProps } from '@base-ui/react/number-field';
import { MinusIcon, PlusIcon, ArrowsHorizontalIcon } from '@phosphor-icons/react';
import { useId } from 'react';

import { cn } from '../lib/utils';

function SideButtonNumberField({
    label,
    className,
    ...props
}: NumberFieldRootProps & { label: string }) {
    const id = useId();
    return (
        <NumberField.Root
            {...props}
            id={id}
            className={cn('flex flex-col items-start gap-1', className)}
        >
            <NumberField.ScrubArea className="cursor-ew-resize">
                <label htmlFor={id} className="cursor-ew-resize text-sm font-medium">
                    {label}
                </label>
                <NumberField.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#0008] filter">
                    <ArrowsHorizontalIcon />
                </NumberField.ScrubAreaCursor>
            </NumberField.ScrubArea>

            <NumberField.Group className="flex">
                <NumberField.Decrement className="flex size-10 items-center justify-center rounded-tl-md rounded-bl-md border bg-clip-padding select-none">
                    <MinusIcon />
                </NumberField.Decrement>
                <NumberField.Input
                    // The visible label is bound to Root, not to this input, so
                    // without this the field reaches assistive tech — and test
                    // selectors — with no name.
                    aria-label={label}
                    className="h-10 w-24 border-t border-b text-center text-base tabular-nums focus:z-1 focus:outline-2 focus:-outline-offset-1"
                    onKeyDownCapture={(event) => event.stopPropagation()}
                    onKeyUpCapture={(event) => event.stopPropagation()}
                />
                <NumberField.Increment className="flex size-10 items-center justify-center rounded-tr-md rounded-br-md border bg-clip-padding select-none">
                    <PlusIcon />
                </NumberField.Increment>
            </NumberField.Group>
        </NumberField.Root>
    );
}

export default SideButtonNumberField;
