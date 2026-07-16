import {
    ArrowClockwiseIcon,
    ArrowsInIcon,
    ArrowsOutSimpleIcon,
    BookOpenUserIcon,
    CastleTurretIcon,
    CircleNotchIcon,
    KanbanIcon,
    SignOutIcon,
    UserIcon
} from '@phosphor-icons/react';
import authClient from '@repo/auth/auth-client';
import { useAuthSuspense } from '@repo/auth/tanstack/hooks';
import { authQueryOptions, authSessionQueryOptions } from '@repo/auth/tanstack/queries';
import { Button } from '@repo/ui/components/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { $adminStopImpersonation } from '~/server/admin.fns';

import { KeyboardToggle } from './KeyboardToggle';
import { ThemeToggle } from './ThemeToggle';

const actionLabelClass =
    'hidden xl:inline overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ml-0 max-w-0 opacity-0 last-touch:ml-1 last-touch:max-w-36 last-touch:opacity-100 group-hover/button:ml-1 group-hover/button:max-w-36 group-hover/button:opacity-100 group-focus-visible/button:ml-1 group-focus-visible/button:max-w-36 group-focus-visible/button:opacity-100';
const actionButtonClass =
    'px-2 xl:px-3 gap-0 last-touch:gap-1.5 group-hover/button:gap-1.5 group-focus-visible/button:gap-1.5';

function FullscreenToggle() {
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
        sync();
        document.addEventListener('fullscreenchange', sync);
        return () => document.removeEventListener('fullscreenchange', sync);
    }, []);

    const toggleFullscreen = useCallback(async () => {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        if (!document.fullscreenElement) {
            if (root.requestFullscreen) {
                await root.requestFullscreen();
            }
            return;
        }
        if (document.exitFullscreen) {
            await document.exitFullscreen();
        }
    }, []);

    return (
        <Button
            variant="outline"
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className={actionButtonClass}
        >
            {isFullscreen ? (
                <ArrowsInIcon className="h-[1.2rem] w-[1.2rem]" />
            ) : (
                <ArrowsOutSimpleIcon className="h-[1.2rem] w-[1.2rem]" />
            )}
            <span className={actionLabelClass}>{isFullscreen ? 'Windowed' : 'Fullscreen'}</span>
        </Button>
    );
}

function RefreshPageButton() {
    const reloadPage = useCallback(() => {
        if (typeof window === 'undefined') return;
        window.location.reload();
    }, []);

    return (
        <Button
            variant="outline"
            onClick={reloadPage}
            title="Refresh page"
            aria-label="Refresh page"
            className={actionButtonClass}
        >
            <ArrowClockwiseIcon className="h-[1.2rem] w-[1.2rem]" />
            <span className={actionLabelClass}>Refresh</span>
        </Button>
    );
}

function HeaderAuthSection() {
    const { user } = useAuthSuspense();
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const queryClient = useQueryClient();
    const router = useRouter();
    const navigate = useNavigate();
    const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
    const [isSigningOut, setIsSigningOut] = useState(false);
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;

    const handleSignOut = async () => {
        setIsSigningOut(true);
        if (isImpersonating) {
            try {
                await $adminStopImpersonation();
                await queryClient.cancelQueries();
                queryClient.clear();
                await router.invalidate();
                if (typeof window !== 'undefined') {
                    window.location.assign('/admin/users');
                    return;
                }
                navigate({ to: '/admin/users' });
                return;
            } catch (e: any) {
                toast.error(e?.message ?? 'Could not end impersonation');
                setIsSigningOut(false);
                return;
            }
        }
        await authClient.signOut({
            fetchOptions: {
                onSuccess: async () => {
                    setSignOutDialogOpen(false);
                    queryClient.setQueryData(authQueryOptions().queryKey, null);
                    await router.invalidate();
                    navigate({ to: '/' });
                },
                onError: async (ctx) => {
                    const err =
                        ctx && typeof ctx === 'object'
                            ? (ctx as Record<string, unknown>).error
                            : null;
                    const errObj =
                        err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
                    const message =
                        (typeof errObj?.message === 'string' ? errObj.message : null) ||
                        (typeof errObj?.statusText === 'string' ? errObj.statusText : null) ||
                        'Sign out failed';
                    toast.error(message);
                    queryClient.setQueryData(authQueryOptions().queryKey, null);
                    await router.invalidate();
                    setIsSigningOut(false);
                }
            }
        });
    };

    if (!user) {
        return (
            <Link to="/login">
                <Button variant="outline" className={actionButtonClass}>
                    <UserIcon className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all" />
                    <span className={actionLabelClass}>Log in</span>
                </Button>
            </Link>
        );
    }

    return (
        <>
            <Link to="/gallery">
                <Button variant="outline" className={actionButtonClass}>
                    <KanbanIcon className="h-[1.2rem] w-[1.2rem]" />
                    <span className={actionLabelClass}>Gallery</span>
                </Button>
            </Link>
            <Link to="/quarry">
                <Button variant="outline" className={actionButtonClass}>
                    <BookOpenUserIcon className="h-[1.2rem] w-[1.2rem]" />
                    <span className={actionLabelClass}>Projects</span>
                </Button>
            </Link>
            {(user.role === 'admin' || user.role === 'operator') && (
                <Link to="/admin">
                    <Button variant="outline" title="Administration" className={actionButtonClass}>
                        <CastleTurretIcon className="h-[1.2rem] w-[1.2rem]" />
                        <span className={actionLabelClass}>Admin</span>
                    </Button>
                </Link>
            )}
            <Button
                variant="outline"
                onClick={() => setSignOutDialogOpen(true)}
                className="px-2 xl:px-3"
                title={`${isImpersonating ? 'End impersonation' : 'Log out'} (${user.email})`}
            >
                <SignOutIcon className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all" />
                <span className="hidden xl:inline">
                    {isImpersonating ? 'End impersonation' : 'Log out'}
                </span>
                <span className="ml-1 hidden max-w-48 truncate text-xs text-muted-foreground xl:inline">
                    {user.email}
                </span>
            </Button>
            <Dialog open={signOutDialogOpen} onOpenChange={setSignOutDialogOpen}>
                <DialogContent className="w-80 p-5">
                    <DialogTitle>{isImpersonating ? 'End impersonation' : 'Log out'}</DialogTitle>
                    <DialogDescription className="mt-1">
                        {isImpersonating
                            ? 'Are you sure you want to end impersonation and return to your account?'
                            : 'Are you sure you want to log out of this account?'}
                    </DialogDescription>
                    <div className="mt-4 flex justify-end gap-2">
                        <DialogClose>
                            <Button variant="outline" size="sm" disabled={isSigningOut}>
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleSignOut}
                            disabled={isSigningOut}
                        >
                            {isSigningOut
                                ? isImpersonating
                                    ? 'Ending...'
                                    : 'Logging out...'
                                : isImpersonating
                                  ? 'End impersonation'
                                  : 'Log out'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

export function Header() {
    const { data: sessionData } = useQuery(authSessionQueryOptions());
    const searchStr = useLocation({
        select: (location) => location.searchStr
    });

    const mountLocation = useMemo(() => {
        const params = new URLSearchParams(searchStr);
        return params.get('l');
    }, [searchStr]);
    const impersonatedBy =
        sessionData?.session && typeof sessionData.session === 'object'
            ? (sessionData.session as { impersonatedBy?: unknown }).impersonatedBy
            : null;
    const isImpersonating = typeof impersonatedBy === 'string' && impersonatedBy.length > 0;

    if (mountLocation === 'gallery' || mountLocation === 'wall') return null;

    return (
        <header
            className={`absolute left-0 flex w-full items-center justify-end gap-2 p-4 ${isImpersonating ? 'top-10' : 'top-0'}`}
        >
            <Link to="/" className="flex flex-row gap-3 font-mono">
                Vizzy Studio
            </Link>
            <span className="grow" />
            <KeyboardToggle />
            <RefreshPageButton />
            <FullscreenToggle />
            <ThemeToggle />
            <Suspense
                fallback={
                    <CircleNotchIcon className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 animate-spin transition-all" />
                }
            >
                <HeaderAuthSection />
            </Suspense>
        </header>
    );
}
