import { KeyboardIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { useLocalStorageToggle } from '@repo/ui/hooks/use-localstorage-toggle';
import { cn } from '@repo/ui/lib/utils';
import { useEffect, useRef } from 'react';

import { useIsTouchOnlyDevice, useLastInputType } from '~/lib/inputMode';

const actionLabelClass =
    'hidden xl:inline overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ml-0 max-w-0 opacity-0 last-touch:ml-1 last-touch:max-w-36 last-touch:opacity-100 group-hover/button:ml-1 group-hover/button:max-w-36 group-hover/button:opacity-100 group-focus-visible/button:ml-1 group-focus-visible/button:max-w-36 group-focus-visible/button:opacity-100';
const actionButtonClass =
    'px-2 xl:px-3 gap-0 last-touch:gap-1.5 group-hover/button:gap-1.5 group-focus-visible/button:gap-1.5';

export function KeyboardToggle() {
    const isTouchOnly = useIsTouchOnlyDevice();
    const lastInputType = useLastInputType();
    const previousInputTypeRef = useRef(lastInputType);

    const [showKeyboard, toggleKeyboard] = useLocalStorageToggle(
        'virtual-keyboard-display',
        isTouchOnly
    );

    useEffect(() => {
        const previousInputType = previousInputTypeRef.current;
        const isMouseToTouch = previousInputType === 'mouse' && lastInputType === 'touch';

        if (isMouseToTouch && !showKeyboard) {
            toggleKeyboard();
        }

        previousInputTypeRef.current = lastInputType;
    }, [lastInputType, showKeyboard, toggleKeyboard]);

    return (
        <div
            className={cn(
                showKeyboard ? 'bg-black text-white dark:bg-white dark:text-black' : '',
                'rounded-4xl transition-all'
            )}
        >
            <Button
                variant={isTouchOnly ? 'outline' : 'ghost'}
                className={actionButtonClass}
                title="Toggle keyboard"
                onClick={() => toggleKeyboard()}
            >
                <KeyboardIcon className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all" />
                <span className={actionLabelClass}>Keyboard</span>
                <span className="sr-only">Toggle keyboard</span>
            </Button>
        </div>
    );
}
