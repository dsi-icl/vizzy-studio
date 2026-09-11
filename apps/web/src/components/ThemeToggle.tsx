import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger
} from '@repo/ui/components/dropdown-menu';
import { useTheme } from '@repo/ui/lib/theme-provider';

const actionLabelClass =
    'hidden xl:inline overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ml-0 max-w-0 opacity-0 last-touch:ml-1 last-touch:max-w-36 last-touch:opacity-100 group-hover/button:ml-1 group-hover/button:max-w-36 group-hover/button:opacity-100 group-focus-visible/button:ml-1 group-focus-visible/button:max-w-36 group-focus-visible/button:opacity-100';
const actionButtonClass =
    'px-2 xl:px-3 gap-0 last-touch:gap-1.5 group-hover/button:gap-1.5 group-focus-visible/button:gap-1.5';

export function ThemeToggle() {
    const { theme, setTheme } = useTheme();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={<Button variant="outline" title="Theme" className={actionButtonClass} />}
            >
                <MoonIcon className="block h-[1.2rem] w-[1.2rem] rotate-0 transition-all dark:hidden dark:-rotate-90" />
                <SunIcon className="hidden h-[1.2rem] w-[1.2rem] rotate-90 transition-all dark:block dark:rotate-0" />
                <span className={actionLabelClass}>Theme</span>
                <span className="sr-only">Toggle theme</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                    checked={theme === 'light'}
                    onCheckedChange={(v) => v && setTheme('light')}
                >
                    Light
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                    checked={theme === 'dark'}
                    onCheckedChange={(v) => v && setTheme('dark')}
                >
                    Dark
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                    checked={theme === 'system'}
                    onCheckedChange={(v) => v && setTheme('system')}
                >
                    System
                </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
