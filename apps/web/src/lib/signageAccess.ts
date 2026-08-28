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

export function canEditSlideshow(
    user:
        | { email: string; role?: string | null; canManageSignage?: boolean | null }
        | null
        | undefined,
    slideshow: {
        createdBy: string;
        collaborators: readonly { email: string; role: 'viewer' | 'editor' }[];
    }
): boolean {
    if (!user) return false;
    if (isGlobalManager(user)) return true;
    if (user.canManageSignage !== true) return false;
    if (slideshow.createdBy === user.email) return true;
    return slideshow.collaborators.some(
        ({ email, role }) => email === user.email && role === 'editor'
    );
}
