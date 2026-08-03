'use client';

import { EyedropperIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { TipButton } from '@repo/ui/components/tip-button';
import { PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { HexAlphaColorPicker } from 'react-colorful';

import { isExplicitCommitKey, normalizeHexColor } from '~/lib/explicitInputCommit';

interface ColorPickerProps extends PropsWithChildren {
    value: string;
    tip?: string;
    variant?: Parameters<typeof TipButton>[0]['variant'];
    onChange: (value: string) => void;
    onTextCommit?: (value: string) => void;
    onTextCancel?: () => void;
    liveTextChange?: boolean;
}

function normalizeIncomingColor(raw: string): string {
    return normalizeHexColor(raw) ?? '#000000ff';
}

export function ColorPicker({
    value,
    onChange,
    onTextCommit,
    onTextCancel,
    liveTextChange = true
}: ColorPickerProps) {
    const [hasEyeDropper, setHasEyeDropper] = useState(false);
    const [localValue, setLocalValue] = useState(() => normalizeIncomingColor(value));
    const [inputValue, setInputValue] = useState(() => normalizeIncomingColor(value));
    const [isTyping, setIsTyping] = useState(false);
    const [isInputInvalid, setIsInputInvalid] = useState(false);
    const lastUserEditAtRef = useRef(0);
    const lastTypingLiveCommitRef = useRef<string | null>(null);
    const typingStartValueRef = useRef(localValue);
    const pendingCommitKeyRef = useRef<'Enter' | 'Tab' | null>(null);
    const typingLiveCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setHasEyeDropper('EyeDropper' in window);
    }, []);

    useEffect(() => {
        if (isTyping) return;
        // While the user is actively dragging/typing, parent echoes can be stale
        // (due to debounced/throttled upstream updates). Hold local color briefly.
        const withinUserEditLock = Date.now() - lastUserEditAtRef.current < 200;
        if (withinUserEditLock) return;
        const normalized = normalizeIncomingColor(value);
        if (normalized !== localValue) setLocalValue(normalized);
        if (normalized !== inputValue) setInputValue(normalized);
    }, [value, localValue, inputValue, isTyping]);

    const commitColor = useCallback(
        (next: string, options?: { syncInput?: boolean }) => {
            const syncInput = options?.syncInput ?? true;
            lastUserEditAtRef.current = Date.now();
            setLocalValue(next);
            if (syncInput) setInputValue(next);
            onChange(next);
        },
        [onChange]
    );

    const commitColorFromTyping = useCallback(
        (next: string) => {
            // While typing, only emit upstream for live propagation.
            // Avoid local picker state updates that can cause focus churn.
            lastUserEditAtRef.current = Date.now();
            lastTypingLiveCommitRef.current = next;
            onChange(next);
        },
        [onChange]
    );

    const clearTypingLiveCommit = useCallback(() => {
        if (!typingLiveCommitTimerRef.current) return;
        clearTimeout(typingLiveCommitTimerRef.current);
        typingLiveCommitTimerRef.current = null;
    }, []);

    const queueTypingLiveCommit = useCallback(
        (next: string) => {
            clearTypingLiveCommit();
            typingLiveCommitTimerRef.current = setTimeout(() => {
                commitColorFromTyping(next);
                typingLiveCommitTimerRef.current = null;
            }, 120);
        },
        [clearTypingLiveCommit, commitColorFromTyping]
    );

    useEffect(
        () => () => {
            clearTypingLiveCommit();
        },
        [clearTypingLiveCommit]
    );

    const commitTypedColor = useCallback(
        (next: string) => {
            clearTypingLiveCommit();
            lastUserEditAtRef.current = Date.now();
            setLocalValue(next);
            setInputValue(next);
            setIsTyping(false);
            setIsInputInvalid(false);

            if (lastTypingLiveCommitRef.current !== next) {
                onChange(next);
            }
            lastTypingLiveCommitRef.current = null;
            onTextCommit?.(next);
        },
        [clearTypingLiveCommit, onChange, onTextCommit]
    );

    const handleEyeDropper = async () => {
        if (!hasEyeDropper) return;

        try {
            // @ts-expect-error - TypeScript might not recognize EyeDropper yet
            const eyeDropper = new window.EyeDropper();
            const result = await eyeDropper.open();
            commitColor(result.sRGBHex);
        } catch (e) {
            // User cancelled the selection, do nothing
            console.debug('EyeDropper cancelled', e);
        }
    };

    return (
        <div className="space-y-3">
            <HexAlphaColorPicker color={localValue} onChange={commitColor} className="mr-0" />
            <div className="flex w-full items-center gap-2">
                <Input
                    maxLength={9}
                    value={inputValue}
                    aria-invalid={isInputInvalid || undefined}
                    aria-label="Hex colour"
                    onFocus={() => {
                        typingStartValueRef.current = localValue;
                        lastTypingLiveCommitRef.current = null;
                        pendingCommitKeyRef.current = null;
                        setIsTyping(true);
                        setIsInputInvalid(false);
                    }}
                    onBlur={() => {
                        clearTypingLiveCommit();
                        pendingCommitKeyRef.current = null;
                        setIsTyping(false);
                        setIsInputInvalid(false);
                        if (!normalizeHexColor(inputValue)) {
                            setInputValue(localValue);
                        }
                    }}
                    onKeyDown={(e) => {
                        if (isExplicitCommitKey(e.key)) {
                            const normalized = normalizeHexColor(e.currentTarget.value);
                            e.preventDefault();
                            if (!normalized) {
                                pendingCommitKeyRef.current = null;
                                setIsInputInvalid(true);
                                return;
                            }

                            if (!e.repeat) pendingCommitKeyRef.current = e.key;
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            clearTypingLiveCommit();
                            pendingCommitKeyRef.current = null;
                            const initialValue = typingStartValueRef.current;
                            setLocalValue(initialValue);
                            setInputValue(initialValue);
                            setIsTyping(false);
                            setIsInputInvalid(false);
                            if (
                                lastTypingLiveCommitRef.current &&
                                lastTypingLiveCommitRef.current !== initialValue
                            ) {
                                onChange(initialValue);
                            }
                            lastTypingLiveCommitRef.current = null;
                            onTextCancel?.();
                        }
                    }}
                    onKeyUp={(e) => {
                        if (!isExplicitCommitKey(e.key) || pendingCommitKeyRef.current !== e.key) {
                            return;
                        }

                        pendingCommitKeyRef.current = null;
                        const normalized = normalizeHexColor(e.currentTarget.value);
                        if (normalized) commitTypedColor(normalized);
                    }}
                    onChange={(e) => {
                        const next = e.target.value;
                        setInputValue(next);
                        setIsInputInvalid(false);
                        const normalized = normalizeHexColor(next);
                        if (normalized) {
                            setLocalValue(normalized);
                            if (liveTextChange) {
                                queueTypingLiveCommit(normalized);
                            } else {
                                clearTypingLiveCommit();
                            }
                        } else {
                            clearTypingLiveCommit();
                        }
                    }}
                    className="h-8 w-39 font-mono uppercase"
                />
                {hasEyeDropper && (
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-8 shrink-0"
                        onClick={handleEyeDropper}
                        title="Pick color from screen"
                    >
                        <EyedropperIcon className="h-4 w-4" />
                        <span className="sr-only">Pick color from screen</span>
                    </Button>
                )}
            </div>
        </div>
    );
}

export function ColorPickerPopover({
    value,
    onChange,
    onTextCommit,
    liveTextChange,
    tip,
    variant,
    children
}: ColorPickerProps) {
    const [open, setOpen] = useState(false);
    const pendingTextCommitRef = useRef<string | null>(null);

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            onOpenChangeComplete={(nextOpen) => {
                if (nextOpen || pendingTextCommitRef.current === null) return;
                const committedValue = pendingTextCommitRef.current;
                pendingTextCommitRef.current = null;
                onTextCommit?.(committedValue);
            }}
        >
            <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
                <TipButton
                    tip={tip ?? 'Color'}
                    aria-label={tip ?? 'Color'}
                    variant={variant ?? 'outline'}
                    className="h-8 w-8 p-0"
                >
                    {children ?? (
                        <div className="h-4 w-4 rounded-full" style={{ backgroundColor: value }} />
                    )}
                </TipButton>
            </PopoverTrigger>
            <PopoverContent
                className="w-auto p-3"
                side="bottom"
                align="start"
                finalFocus={onTextCommit ? false : undefined}
            >
                <ColorPicker
                    value={value}
                    onChange={onChange}
                    liveTextChange={liveTextChange}
                    onTextCommit={(committedValue) => {
                        pendingTextCommitRef.current = committedValue;
                        setOpen(false);
                    }}
                    onTextCancel={() => setOpen(false)}
                />
            </PopoverContent>
        </Popover>
    );
}
