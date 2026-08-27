export function isGlobalManager(user: { role?: string | null } | null | undefined): boolean {
    return user?.role === 'admin' || user?.role === 'operator';
}

export function canAccessSignage(
    user: { role?: string | null; canManageSignage?: boolean | null } | null | undefined
): boolean {
    if (!user) return false;
    return isGlobalManager(user) || user.canManageSignage === true;
}

export function canBindWall(
    user: { role?: string | null; canManageSignage?: boolean | null } | null | undefined,
    wall: { openToEditors?: boolean | null } | null | undefined
): boolean {
    return wall?.openToEditors === true || canAccessSignage(user);
}
