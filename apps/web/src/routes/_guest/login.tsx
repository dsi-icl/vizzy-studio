import { CircleNotchIcon, DiscoBallIcon } from '@phosphor-icons/react';
import authClient from '@repo/auth/auth-client';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { VirtualEmailKeyboard } from '@repo/ui/components/virtual-email-keyboard';
import { VirtualNumericKeypad } from '@repo/ui/components/virtual-numeric-keypad';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';

import { z } from '~/lib/zod';
import { $bootstrapStatus } from '~/server/bootstrap.fns';

export const Route = createFileRoute('/_guest/login')({
    beforeLoad: async () => {
        const status = await $bootstrapStatus();
        if (status.requiresBootstrap) {
            throw redirect({ to: '/bootstrap' });
        }
    },
    head: () => ({
        meta: [{ title: 'Login · Vizzy Studio' }]
    }),
    component: LoginForm
});

const OTP_LENGTH = 6;

const VIEW_ORDER = { email: 0, choose: 1, 'magic-link-sent': 2, otp: 2 } as const;

type View = keyof typeof VIEW_ORDER;

const SLIDE_OFFSET = 40;

function LoginForm() {
    const [view, setView] = useState<View>('email');
    const [email, setEmail] = useState('');
    const [direction, setDirection] = useState(1);

    const navigateTo = (next: View) => {
        setDirection(VIEW_ORDER[next] >= VIEW_ORDER[view] ? 1 : -1);
        setView(next);
    };

    const { mutate: sendOtp, isPending: isOtpSendPending } = useMutation({
        mutationFn: async (addr: string) =>
            await authClient.emailOtp.sendVerificationOtp(
                { email: addr, type: 'sign-in' },
                {
                    onError: ({ error }) => {
                        toast.error(error.message || 'An error occurred while sending the code.');
                    },
                    onSuccess: () => {
                        navigateTo('otp');
                    }
                }
            )
    });

    const isSending = isOtpSendPending;

    const goBack = () => {
        setDirection(-1);
        setEmail('');
        setView('email');
    };

    return (
        <div className="grid h-[70vh] px-1">
            <AnimatePresence mode="sync" custom={direction}>
                {view === 'email' && (
                    <SlidePanel key="email" direction={direction}>
                        <EmailView
                            onSubmit={(addr) => {
                                setEmail(addr);
                                navigateTo('choose');
                            }}
                        />
                    </SlidePanel>
                )}

                {view === 'choose' && (
                    <SlidePanel key="choose" direction={direction}>
                        <div className="flex flex-col items-center gap-4 text-center">
                            <Link to="/" className="flex flex-col items-center gap-2 font-medium">
                                <div className="flex h-12 w-12 items-center justify-center rounded-md">
                                    <DiscoBallIcon className="size-12" />
                                </div>
                            </Link>
                            <h1 className="text-xl font-bold">How would you like to sign in?</h1>
                            <p className="text-sm text-muted-foreground">
                                Signing in as <strong>{email}</strong>
                            </p>
                            <div className="flex w-full flex-col gap-4">
                                <Button
                                    className="w-full"
                                    size="lg"
                                    disabled={isSending}
                                    onClick={() => sendOtp(email)}
                                >
                                    {isOtpSendPending && (
                                        <CircleNotchIcon className="animate-spin" />
                                    )}
                                    Send a one-time code
                                </Button>
                            </div>
                            <button
                                type="button"
                                className="text-sm text-muted-foreground underline underline-offset-4"
                                onClick={goBack}
                            >
                                Use a different email
                            </button>
                        </div>
                    </SlidePanel>
                )}

                {view === 'magic-link-sent' && (
                    <SlidePanel key="magic-link-sent" direction={direction}>
                        <div className="flex flex-col items-center gap-4 text-center">
                            <Link to="/" className="flex flex-col items-center gap-2 font-medium">
                                <div className="flex h-12 w-12 items-center justify-center rounded-md">
                                    <DiscoBallIcon className="size-12" />
                                </div>
                            </Link>
                            <h1 className="text-xl font-bold">Check your email</h1>
                            <p className="text-muted-foreground">
                                We sent a magic link to <strong>{email}</strong>. Click the link in
                                your email to sign in.
                            </p>
                            <button
                                type="button"
                                className="text-sm text-muted-foreground underline underline-offset-4"
                                onClick={goBack}
                            >
                                Use a different email
                            </button>
                        </div>
                    </SlidePanel>
                )}

                {view === 'otp' && (
                    <SlidePanel key="otp" direction={direction}>
                        <OtpView email={email} onBack={goBack} />
                    </SlidePanel>
                )}
            </AnimatePresence>
        </div>
    );
}

const slidePanelVariants = {
    enter: (d: number) => ({
        x: d * SLIDE_OFFSET,
        opacity: 0,
        filter: 'blur(4px)'
    }),
    center: {
        x: 0,
        opacity: 1,
        filter: 'blur(0px)'
    },
    exit: (d: number) => ({
        x: d * -SLIDE_OFFSET,
        opacity: 0,
        filter: 'blur(4px)'
    })
};

function SlidePanel({ children, direction }: { children: React.ReactNode; direction: number }) {
    return (
        <motion.div
            className="col-start-1 row-start-1 w-full"
            custom={direction}
            variants={slidePanelVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        >
            {children}
        </motion.div>
    );
}

function EmailView({ onSubmit }: { onSubmit: (email: string) => void }) {
    const inputRef = useRef<HTMLInputElement>(null);

    const form = useForm({
        defaultValues: {
            email: ''
        },
        onSubmit: ({ value }) => {
            onSubmit(value.email);
        }
    });

    const handleVirtualKey = useCallback(
        (key: string) => {
            form.setFieldValue('email', form.getFieldValue('email') + key);
            inputRef.current?.focus();
        },
        [form]
    );

    const handleVirtualDelete = useCallback(() => {
        form.setFieldValue('email', form.getFieldValue('email').slice(0, -1));
        inputRef.current?.focus();
    }, [form]);

    return (
        <div className="flex flex-col items-center gap-4">
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
                className="w-full"
            >
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col items-center gap-2">
                        <Link to="/" className="flex flex-col items-center gap-2 font-medium">
                            <div className="flex h-12 w-12 items-center justify-center rounded-md">
                                <DiscoBallIcon className="size-12" />
                            </div>
                            <span className="sr-only">Vizzy Studio</span>
                        </Link>
                        <h1 className="text-xl font-bold">Welcome to Vizzy Studio</h1>
                        <p className="text-sm text-muted-foreground">Enter your email to sign in</p>
                    </div>
                    <div className="flex flex-col gap-4">
                        <form.Field
                            name="email"
                            validators={{
                                onChange: z
                                    .string()
                                    .regex(/.+@.+\..+/, 'Please enter a valid email address.')
                            }}
                        >
                            {(field) => (
                                <div className="grid gap-2">
                                    <Label htmlFor={field.name}>Email</Label>
                                    <Input
                                        ref={inputRef}
                                        id={field.name}
                                        name={field.name}
                                        type="email"
                                        placeholder="hello@imperial.ac.uk"
                                        value={field.state.value}
                                        onBlur={field.handleBlur}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                    />
                                    {field.state.meta.errors ? (
                                        <em className="text-xs text-red-500">
                                            {field.state.meta.errors
                                                .map((e) => e?.message)
                                                .join(', ')}
                                        </em>
                                    ) : null}
                                </div>
                            )}
                        </form.Field>
                        <Button
                            type="submit"
                            className="w-full"
                            size="lg"
                            disabled={!form.state.isValid}
                        >
                            Continue
                        </Button>

                        <Link to="/">
                            <Button type="button" variant="secondary" className="w-full" size="lg">
                                Cancel
                            </Button>
                        </Link>
                    </div>
                </div>
            </form>

            <VirtualEmailKeyboard onKey={handleVirtualKey} onDelete={handleVirtualDelete} />
        </div>
    );
}

function OtpView({ email, onBack }: { email: string; onBack: () => void }) {
    const [digits, setDigits] = useState('');
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    const { mutate: verifyOtp, isPending } = useMutation({
        mutationFn: async (otp: string) =>
            await authClient.signIn.emailOtp(
                { email, otp },
                {
                    onError: ({ error }) => {
                        toast.error(error.message || 'Invalid or expired code.');
                        setDigits('');
                    },
                    onSuccess: async () => {
                        await queryClient.invalidateQueries(authQueryOptions());
                        await navigate({ to: '/quarry' });
                    }
                }
            )
    });

    const appendDigit = useCallback(
        (d: string) => {
            if (isPending) return;
            setDigits((prev) => {
                if (prev.length >= OTP_LENGTH) return prev;
                return prev + d;
            });
        },
        [isPending]
    );

    const deleteDigit = useCallback(() => {
        if (isPending) return;
        setDigits((prev) => prev.slice(0, -1));
    }, [isPending]);

    // Auto-submit when all digits are entered
    useEffect(() => {
        if (digits.length === OTP_LENGTH && !isPending) {
            verifyOtp(digits);
        }
    }, [digits, isPending, verifyOtp]);

    useEffect(() => {
        const handlePaste = (e: ClipboardEvent) => {
            if (isPending) return;
            const pasted = e.clipboardData?.getData('text');
            if (!pasted) return;

            e.preventDefault();
            const newDigits = pasted.replace(/\D/g, '').slice(0, OTP_LENGTH);
            if (newDigits) {
                setDigits(newDigits);
            }
        };

        document.addEventListener('paste', handlePaste);
        return () => {
            document.removeEventListener('paste', handlePaste);
        };
    }, [isPending]);

    return (
        <div className="flex flex-col items-center gap-4">
            <Link to="/" className="flex flex-col items-center gap-2 font-medium">
                <div className="flex h-12 w-12 items-center justify-center rounded-md">
                    <DiscoBallIcon className="size-12" />
                </div>
            </Link>
            <div className="text-center">
                <h1 className="text-xl font-bold">Enter your code</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    We sent a verification code to <strong>{email}</strong>
                </p>
            </div>

            {/* OTP digit display */}
            <div className="flex gap-2">
                {Array.from({ length: OTP_LENGTH }).map((_, i) => (
                    <div
                        key={i}
                        className="flex h-12 w-10 items-center justify-center rounded-md border text-lg font-semibold"
                    >
                        {digits[i] ?? ''}
                    </div>
                ))}
            </div>

            {isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CircleNotchIcon className="animate-spin" />
                    Verifying...
                </div>
            )}

            <VirtualNumericKeypad
                onDigit={appendDigit}
                onDelete={deleteDigit}
                disabled={isPending}
            />

            <button
                type="button"
                className="text-sm text-muted-foreground underline underline-offset-4"
                onClick={onBack}
            >
                Use a different email
            </button>
        </div>
    );
}
