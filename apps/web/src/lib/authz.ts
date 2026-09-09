type RoleHolder = {
    role?: string | null;
};

type PublisherRoleHolder = RoleHolder & {
    trustedPublisher?: boolean | null;
    canManageSignage?: boolean | null;
};

export function isAdmin(role: string | null | undefined): boolean {
    return role === 'admin';
}

export function isOperator(role: string | null | undefined): boolean {
    return role === 'operator';
}

export function canViewProjectAudits(actor: RoleHolder | null | undefined): boolean {
    return isAdmin(actor?.role) || isOperator(actor?.role);
}

export function canPublishProject(actor: PublisherRoleHolder | null | undefined): boolean {
    if (isAdmin(actor?.role)) return true;
    if (isOperator(actor?.role)) return true;
    if (actor?.canManageSignage === true) return true;
    return actor?.trustedPublisher === true;
}
