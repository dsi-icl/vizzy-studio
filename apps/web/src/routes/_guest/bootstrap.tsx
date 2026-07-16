import { CircleNotchIcon, DiscoBallIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { VirtualNumericKeypad } from '@repo/ui/components/virtual-numeric-keypad';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
    $bootstrapStatus,
    $requestBootstrapSetupCodeDisplay,
    $submitBootstrapAdminAndSmtp,
    $verifyBootstrapOtpAndFinalize,
    $verifyBootstrapSetupCode
} from '~/server/bootstrap.fns';

const OTP_LENGTH = 6;
const VIEW_ORDER = {
    welcome: 0,
    terminal: 1,
    code: 2,
    details: 3,
    otp: 4
} as const;
type View = keyof typeof VIEW_ORDER;

const SLIDE_OFFSET = 40;
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

export const Route = createFileRoute('/_guest/bootstrap')({
    loader: async () => {
        const status = await $bootstrapStatus();
        if (!status.requiresBootstrap) {
            throw redirect({ to: '/login' });
        }
        return status;
    },
    head: () => ({
        meta: [{ title: 'Bootstrap Setup · Vizzy Studio' }]
    }),
    component: BootstrapPage
});

function getInitialView(phase: string): View {
    if (phase === 'code_requested') return 'terminal';
    if (phase === 'code_verified') return 'details';
    if (phase === 'smtp_pending_verification') return 'otp';
    return 'welcome';
}

function BootstrapPage() {
    const status = Route.useLoaderData();
    const navigate = useNavigate();
    const [view, setView] = useState<View>(getInitialView(status.phase));
    const [direction, setDirection] = useState(1);

    const [setupCode, setSetupCode] = useState('');
    const [otp, setOtp] = useState('');

    const [adminEmail, setAdminEmail] = useState(status.claimedEmail ?? '');
    const [smtpHost, setSmtpHost] = useState('');
    const [smtpPort, setSmtpPort] = useState('587');
    const [smtpSecure, setSmtpSecure] = useState(false);
    const [smtpRequireTLS, setSmtpRequireTLS] = useState(false);
    const [smtpIgnoreTLS, setSmtpIgnoreTLS] = useState(false);
    const [smtpTlsRejectUnauthorized, setSmtpTlsRejectUnauthorized] = useState(true);
    const [smtpTlsServername, setSmtpTlsServername] = useState('');
    const [smtpConnectionTimeoutMs, setSmtpConnectionTimeoutMs] = useState('10000');
    const [smtpUser, setSmtpUser] = useState('');
    const [smtpPass, setSmtpPass] = useState('');
    const [smtpFrom, setSmtpFrom] = useState('');

    const goTo = (next: View) => {
        setDirection(VIEW_ORDER[next] >= VIEW_ORDER[view] ? 1 : -1);
        setView(next);
    };

    const requestCode = useMutation({
        mutationFn: async () => $requestBootstrapSetupCodeDisplay(),
        onSuccess: () => {
            toast.success('Setup code printed in the server terminal.');
            goTo('terminal');
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Unable to request setup code.');
        }
    });

    const verifyCode = useMutation({
        mutationFn: async () => $verifyBootstrapSetupCode({ data: { code: setupCode } }),
        onSuccess: () => {
            toast.success('Setup code verified.');
            goTo('details');
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Invalid setup code.');
        }
    });

    const submitDetails = useMutation({
        mutationFn: async () =>
            $submitBootstrapAdminAndSmtp({
                data: {
                    adminEmail,
                    smtp: {
                        host: smtpHost,
                        port: Number(smtpPort),
                        secure: smtpSecure,
                        requireTLS: smtpRequireTLS,
                        ignoreTLS: smtpIgnoreTLS,
                        tlsRejectUnauthorized: smtpTlsRejectUnauthorized,
                        tlsServername: smtpTlsServername,
                        connectionTimeoutMs: Number(smtpConnectionTimeoutMs),
                        user: smtpUser,
                        pass: smtpPass,
                        from: smtpFrom
                    }
                }
            }),
        onSuccess: () => {
            setOtp('');
            toast.success('Verification code sent. Check your inbox.');
            goTo('otp');
        },
        onError: (err) => {
            toast.error(
                err instanceof Error ? err.message : 'SMTP validation failed. Check your details.'
            );
        }
    });

    const { mutate: verifyOtpMutate, isPending: isVerifyOtpPending } = useMutation({
        mutationFn: async (code: string) => $verifyBootstrapOtpAndFinalize({ data: { otp: code } }),
        onSuccess: async () => {
            toast.success('Bootstrap complete. You can now sign in.');
            await navigate({ to: '/login' });
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Invalid verification code.');
            setOtp('');
        }
    });

    useEffect(() => {
        if (otp.length === OTP_LENGTH && !isVerifyOtpPending) {
            verifyOtpMutate(otp);
        }
    }, [otp, isVerifyOtpPending, verifyOtpMutate]);

    useEffect(() => {
        if (view !== 'otp') return;

        const handlePaste = (e: ClipboardEvent) => {
            if (isVerifyOtpPending) return;
            const pasted = e.clipboardData?.getData('text');
            if (!pasted) return;

            e.preventDefault();
            const newDigits = pasted.replace(/\D/g, '').slice(0, OTP_LENGTH);
            if (newDigits) {
                setOtp(newDigits);
            }
        };

        document.addEventListener('paste', handlePaste);
        return () => {
            document.removeEventListener('paste', handlePaste);
        };
    }, [view, isVerifyOtpPending]);

    const detailsDisabled = useMemo(
        () =>
            !adminEmail.trim() ||
            !smtpHost.trim() ||
            !smtpPort.trim() ||
            !smtpConnectionTimeoutMs.trim() ||
            !smtpUser.trim() ||
            !smtpPass.trim() ||
            !smtpFrom.trim() ||
            submitDetails.isPending,
        [
            adminEmail,
            smtpHost,
            smtpPort,
            smtpConnectionTimeoutMs,
            smtpUser,
            smtpPass,
            smtpFrom,
            submitDetails.isPending
        ]
    );

    return (
        <div className="grid h-[75vh] px-1">
            <AnimatePresence mode="sync" custom={direction}>
                {view === 'welcome' && (
                    <SlidePanel key="welcome" direction={direction}>
                        <div className="flex flex-col items-center gap-4 text-center">
                            <Link to="/" className="flex flex-col items-center gap-2 font-medium">
                                <div className="flex h-12 w-12 items-center justify-center rounded-md">
                                    <DiscoBallIcon className="size-12" />
                                </div>
                            </Link>
                            <h1 className="text-xl font-bold">Welcome to Onboarding</h1>
                            <p className="text-sm text-muted-foreground">
                                This guided bootstrap will configure your first admin and email
                                delivery.
                            </p>
                            <div className="rounded-lg border border-border bg-muted/30 p-3 text-left text-sm text-muted-foreground">
                                <p className="flex items-center gap-2 font-medium text-foreground">
                                    <ShieldCheckIcon size={16} />
                                    Security model
                                </p>
                                <p className="mt-1">
                                    A one-time setup code is printed only after you continue to the
                                    next step.
                                </p>
                            </div>
                            <Button
                                className="w-full"
                                size="lg"
                                disabled={requestCode.isPending}
                                onClick={() => requestCode.mutate()}
                            >
                                {requestCode.isPending ? (
                                    <CircleNotchIcon className="animate-spin" />
                                ) : null}
                                Continue
                            </Button>
                        </div>
                    </SlidePanel>
                )}

                {view === 'terminal' && (
                    <SlidePanel key="terminal" direction={direction}>
                        <div className="flex flex-col items-center gap-4 text-center">
                            <h1 className="text-xl font-bold">Check Server Terminal</h1>
                            <p className="text-sm text-muted-foreground">
                                The setup code has been printed in server logs. Copy it, then
                                continue.
                            </p>
                            <div className="flex w-full flex-col gap-3">
                                <Button size="lg" onClick={() => goTo('code')}>
                                    I have the code
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    disabled={requestCode.isPending}
                                    onClick={() => requestCode.mutate()}
                                >
                                    {requestCode.isPending ? (
                                        <CircleNotchIcon className="animate-spin" />
                                    ) : null}
                                    Print new code
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => goTo('welcome')}
                                >
                                    Back
                                </Button>
                            </div>
                        </div>
                    </SlidePanel>
                )}

                {view === 'code' && (
                    <SlidePanel key="code" direction={direction}>
                        <div className="flex flex-col gap-4">
                            <h1 className="text-center text-xl font-bold">Enter Setup Code</h1>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-code">Setup code</Label>
                                <Input
                                    id="bootstrap-code"
                                    value={setupCode}
                                    onChange={(e) => setSetupCode(e.target.value.toUpperCase())}
                                    placeholder="ABC12345"
                                    autoComplete="off"
                                />
                            </div>
                            <Button
                                size="lg"
                                disabled={verifyCode.isPending || !setupCode.trim()}
                                onClick={() => verifyCode.mutate()}
                            >
                                {verifyCode.isPending ? (
                                    <CircleNotchIcon className="animate-spin" />
                                ) : null}
                                Validate code
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => goTo('terminal')}>
                                Back
                            </Button>
                        </div>
                    </SlidePanel>
                )}

                {view === 'details' && (
                    <SlidePanel key="details" direction={direction}>
                        <div className="flex flex-col gap-3">
                            <h1 className="text-center text-xl font-bold">Admin + SMTP Details</h1>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-admin-email">Admin email</Label>
                                <Input
                                    id="bootstrap-admin-email"
                                    type="email"
                                    value={adminEmail}
                                    onChange={(e) => setAdminEmail(e.target.value)}
                                    placeholder="admin@example.com"
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-smtp-host">SMTP host</Label>
                                <Input
                                    id="bootstrap-smtp-host"
                                    value={smtpHost}
                                    onChange={(e) => setSmtpHost(e.target.value)}
                                    placeholder="smtp.example.com"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="grid gap-2">
                                    <Label htmlFor="bootstrap-smtp-port">SMTP port</Label>
                                    <Input
                                        id="bootstrap-smtp-port"
                                        inputMode="numeric"
                                        value={smtpPort}
                                        onChange={(e) => setSmtpPort(e.target.value)}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor="bootstrap-smtp-timeout">Timeout (ms)</Label>
                                    <Input
                                        id="bootstrap-smtp-timeout"
                                        inputMode="numeric"
                                        value={smtpConnectionTimeoutMs}
                                        onChange={(e) => setSmtpConnectionTimeoutMs(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-smtp-user">SMTP user</Label>
                                <Input
                                    id="bootstrap-smtp-user"
                                    value={smtpUser}
                                    onChange={(e) => setSmtpUser(e.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-smtp-pass">SMTP password</Label>
                                <Input
                                    id="bootstrap-smtp-pass"
                                    type="password"
                                    value={smtpPass}
                                    onChange={(e) => setSmtpPass(e.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-smtp-from">SMTP from</Label>
                                <Input
                                    id="bootstrap-smtp-from"
                                    type="email"
                                    value={smtpFrom}
                                    onChange={(e) => setSmtpFrom(e.target.value)}
                                    placeholder="noreply@example.com"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={smtpSecure}
                                        onChange={(e) => setSmtpSecure(e.target.checked)}
                                    />
                                    Secure (SMTPS)
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={smtpRequireTLS}
                                        onChange={(e) => setSmtpRequireTLS(e.target.checked)}
                                    />
                                    Require TLS
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={smtpIgnoreTLS}
                                        onChange={(e) => setSmtpIgnoreTLS(e.target.checked)}
                                    />
                                    Ignore TLS
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={smtpTlsRejectUnauthorized}
                                        onChange={(e) =>
                                            setSmtpTlsRejectUnauthorized(e.target.checked)
                                        }
                                    />
                                    Reject bad certs
                                </label>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bootstrap-smtp-servername">TLS server name</Label>
                                <Input
                                    id="bootstrap-smtp-servername"
                                    value={smtpTlsServername}
                                    onChange={(e) => setSmtpTlsServername(e.target.value)}
                                    placeholder="smtp.example.com"
                                />
                            </div>

                            <Button
                                size="lg"
                                disabled={detailsDisabled}
                                onClick={() => submitDetails.mutate()}
                            >
                                {submitDetails.isPending ? (
                                    <CircleNotchIcon className="animate-spin" />
                                ) : null}
                                Save details and send OTP
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => goTo('code')}>
                                Back
                            </Button>
                        </div>
                    </SlidePanel>
                )}

                {view === 'otp' && (
                    <SlidePanel key="otp" direction={direction}>
                        <div className="flex flex-col items-center gap-4">
                            <h1 className="text-center text-xl font-bold">
                                Enter Verification OTP
                            </h1>
                            <p className="text-center text-sm text-muted-foreground">
                                Enter the code received at <strong>{adminEmail}</strong>.
                            </p>

                            <div className="flex gap-2">
                                {Array.from({ length: OTP_LENGTH }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="flex h-12 w-10 items-center justify-center rounded-md border text-lg font-semibold"
                                    >
                                        {otp[i] ?? ''}
                                    </div>
                                ))}
                            </div>

                            {isVerifyOtpPending ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <CircleNotchIcon className="animate-spin" />
                                    Verifying...
                                </div>
                            ) : null}

                            <VirtualNumericKeypad
                                onDigit={(digit) => {
                                    if (isVerifyOtpPending) return;
                                    setOtp((prev) =>
                                        prev.length >= OTP_LENGTH ? prev : `${prev}${digit}`
                                    );
                                }}
                                onDelete={() => {
                                    if (isVerifyOtpPending) return;
                                    setOtp((prev) => prev.slice(0, -1));
                                }}
                                disabled={isVerifyOtpPending}
                            />

                            <Button type="button" variant="ghost" onClick={() => goTo('details')}>
                                Back to details
                            </Button>
                        </div>
                    </SlidePanel>
                )}
            </AnimatePresence>
        </div>
    );
}

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
