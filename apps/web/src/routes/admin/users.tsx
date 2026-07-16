import {
    ChatCenteredSlashIcon,
    ChatCenteredTextIcon,
    DotsThreeVerticalIcon,
    GearIcon,
    PersonSimpleRunIcon,
    ProhibitIcon,
    ShieldCheckIcon,
    UserIcon
} from '@phosphor-icons/react';
import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@repo/ui/components/dropdown-menu';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger
} from '@repo/ui/components/select';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';

import {
    $adminImpersonateUser,
    $adminSetUserBanStatus,
    $adminSetUserRole,
    $adminSetUserTrustedPublisher
} from '~/server/admin.fns';
import { adminUsersQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/users')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminUsersQueryOptions());
    },
    component: AdminUsers,
    head: () => ({
        meta: [{ title: 'Users · Admin · Vizzy Studio' }]
    })
});

function AdminUsers() {
    const { data: users } = useSuspenseQuery(adminUsersQueryOptions());
    const { data: currentUser } = useSuspenseQuery(authQueryOptions());
    const isAdminActor = currentUser?.role === 'admin';
    const queryClient = useQueryClient();
    const router = useRouter();
    const navigate = useNavigate();

    const banMutation = useMutation({
        mutationFn: async ({ userId, banned }: { userId: string; banned: boolean }) => {
            await $adminSetUserBanStatus({ data: { userId, banned } });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            toast.success('User updated');
        },
        onError: (e: any) => toast.error(e.message)
    });

    const roleMutation = useMutation({
        mutationFn: async ({
            userId,
            userEmail,
            role
        }: {
            userId?: string;
            userEmail: string;
            role: 'admin' | 'operator' | 'user';
        }) => {
            await $adminSetUserRole({ data: { userId, userEmail, role } });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            toast.success('User role updated');
        },
        onError: (e: any) => toast.error(e.message)
    });

    const trustedPublisherMutation = useMutation({
        mutationFn: async ({
            userId,
            trustedPublisher
        }: {
            userId: string;
            trustedPublisher: boolean;
        }) => {
            await $adminSetUserTrustedPublisher({ data: { userId, trustedPublisher } });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            toast.success('Trusted publisher status updated');
        },
        onError: (e: any) => toast.error(e.message)
    });

    const impersonateMutation = useMutation({
        mutationFn: async ({ userId }: { userId: string }) => {
            await $adminImpersonateUser({ data: { userId } });
        },
        onSuccess: async () => {
            await queryClient.cancelQueries();
            queryClient.clear();
            await router.invalidate();
            if (typeof window !== 'undefined') {
                window.location.assign('/');
                return;
            }
            navigate({ to: '/' });
        },
        onError: (e: any) => toast.error(e.message ?? 'Could not start impersonation')
    });

    const getRoleView = (
        role: unknown
    ): { value: 'admin' | 'operator' | 'user'; label: string } => {
        if (role === 'admin') return { value: 'admin', label: 'Admin' };
        if (role === 'operator') return { value: 'operator', label: 'Operator' };
        return { value: 'user', label: 'User' };
    };

    const roleIcon = (role: 'admin' | 'operator' | 'user') => {
        if (role === 'admin') return <ShieldCheckIcon size={10} />;
        if (role === 'operator') return <GearIcon size={10} />;
        return <UserIcon size={10} />;
    };

    const roleOptions: Array<{ value: 'admin' | 'operator' | 'user'; label: string }> = [
        { value: 'user', label: 'User' },
        { value: 'operator', label: 'Operator' },
        { value: 'admin', label: 'Admin' }
    ];

    const getPublishingView = (
        trustedPublisher: unknown
    ): { value: 'trusted' | 'blocked'; label: string } => {
        if (trustedPublisher === true) return { value: 'trusted', label: 'Trusted' };
        return { value: 'blocked', label: 'Blocked' };
    };

    const publishingIcon = (value: 'trusted' | 'blocked') => {
        if (value === 'trusted') return <ChatCenteredTextIcon size={10} />;
        return <ChatCenteredSlashIcon size={10} />;
    };

    const publishingOptions: Array<{ value: 'trusted' | 'blocked'; label: string }> = [
        { value: 'blocked', label: 'Blocked' },
        { value: 'trusted', label: 'Trusted' }
    ];

    return (
        <div>
            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                            <th className="px-4 py-3 text-left font-medium">Email</th>
                            <th className="px-4 py-3 text-left font-medium">Role</th>
                            <th className="px-4 py-3 text-left font-medium">Publishing</th>
                            <th className="px-4 py-3 text-left font-medium">Created</th>
                            <th className="px-4 py-3 text-left font-medium">Last seen</th>
                            <th className="px-4 py-3 text-left font-medium">Status</th>
                            <th className="px-4 py-3 text-left font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {users.map((user: any) => {
                            const roleView = getRoleView(user.role);
                            const publishingView = getPublishingView(user.trustedPublisher);
                            const isCurrentUser =
                                typeof user?.id === 'string' &&
                                typeof currentUser?.id === 'string' &&
                                user.id === currentUser.id;
                            return (
                                <tr key={user.id} className="hover:bg-muted/30">
                                    <td className="px-4 py-3 font-mono text-xs">{user.email}</td>
                                    <td className="px-4 py-3">
                                        {isAdminActor ? (
                                            <Select
                                                value={roleView.value}
                                                onValueChange={(value) =>
                                                    roleMutation.mutate({
                                                        userId: user.id,
                                                        userEmail: user.email,
                                                        role: value as 'admin' | 'operator' | 'user'
                                                    })
                                                }
                                                disabled={
                                                    roleMutation.isPending ||
                                                    trustedPublisherMutation.isPending ||
                                                    banMutation.isPending ||
                                                    isCurrentUser
                                                }
                                            >
                                                <SelectTrigger
                                                    className={`h-7 min-w-24 rounded-full border-0 px-2 py-0.5 text-xs font-medium ${user.role === `admin` ? `bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400` : `bg-muted text-muted-foreground`}`}
                                                >
                                                    <span className="inline-flex items-center gap-1">
                                                        {roleIcon(roleView.value)}
                                                        {roleView.label}
                                                    </span>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectGroup>
                                                        <SelectLabel>Role</SelectLabel>
                                                        {roleOptions.map((option) => (
                                                            <SelectItem
                                                                key={option.value}
                                                                value={option.value}
                                                            >
                                                                <span className="inline-flex items-center gap-1">
                                                                    {roleIcon(option.value)}
                                                                    {option.label}
                                                                </span>
                                                            </SelectItem>
                                                        ))}
                                                    </SelectGroup>
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <span className="inline-flex h-7 min-w-24 items-center justify-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                                {roleIcon(roleView.value)}
                                                {roleView.label}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Select
                                            value={publishingView.value}
                                            onValueChange={(value) =>
                                                trustedPublisherMutation.mutate({
                                                    userId: user.id,
                                                    trustedPublisher: value === 'trusted'
                                                })
                                            }
                                        >
                                            <SelectTrigger className="h-7 min-w-28 rounded-full border-0 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                                <span className="inline-flex items-center gap-1">
                                                    {publishingIcon(publishingView.value)}
                                                    {publishingView.label}
                                                </span>
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectGroup>
                                                    <SelectLabel>Publishing</SelectLabel>
                                                    {publishingOptions.map((option) => (
                                                        <SelectItem
                                                            key={option.value}
                                                            value={option.value}
                                                        >
                                                            <span className="inline-flex items-center gap-1">
                                                                {publishingIcon(option.value)}
                                                                {option.label}
                                                            </span>
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            </SelectContent>
                                        </Select>
                                    </td>
                                    <td className="px-4 py-3 text-muted-foreground">
                                        <DateDisplay value={user.createdAt} />
                                    </td>
                                    <td className="px-4 py-3 text-muted-foreground">
                                        <DateDisplay value={user.lastSeen} fallback="Never" />
                                    </td>
                                    <td className="px-4 py-3">
                                        {user.banned ? (
                                            <span className="text-xs text-destructive">Banned</span>
                                        ) : (
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-green-600 dark:text-green-400">
                                                    Active
                                                </span>
                                                {user.isActiveSession && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                        Session live
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        {isAdminActor ? (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger
                                                    className="rounded-lg p-1 hover:bg-muted"
                                                    disabled={
                                                        banMutation.isPending ||
                                                        trustedPublisherMutation.isPending ||
                                                        roleMutation.isPending ||
                                                        impersonateMutation.isPending
                                                    }
                                                >
                                                    <DotsThreeVerticalIcon className="size-4" />
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem
                                                        onClick={() =>
                                                            banMutation.mutate({
                                                                userId: user.id,
                                                                banned: !user.banned
                                                            })
                                                        }
                                                        disabled={isCurrentUser}
                                                        variant={
                                                            user.banned ? 'default' : 'destructive'
                                                        }
                                                    >
                                                        <ProhibitIcon size={14} />
                                                        {user.banned ? 'Unban' : 'Ban'}
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        onClick={() =>
                                                            impersonateMutation.mutate({
                                                                userId: user.id
                                                            })
                                                        }
                                                        disabled={
                                                            isCurrentUser ||
                                                            roleView.value === 'admin' ||
                                                            user.banned
                                                        }
                                                    >
                                                        <PersonSimpleRunIcon size={14} />
                                                        Impersonate
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">-</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
