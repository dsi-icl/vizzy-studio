import { ArchiveIcon, MagnifyingGlassIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import type { Collaborator, CollaboratorRole } from '@repo/db/schema';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue
} from '@repo/ui/components/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@repo/ui/components/table';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { $adminUpdateProjectCollaborators } from '~/server/admin.fns';
import { adminProjectsQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/projects')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminProjectsQueryOptions());
    },
    component: AdminProjects,
    head: () => ({
        meta: [{ title: 'Projects · Admin · Vizzy Studio' }]
    })
});

function AdminProjects() {
    const { data: projects } = useSuspenseQuery(adminProjectsQueryOptions());
    const queryClient = useQueryClient();
    const [editingProject, setEditingProject] = useState<{
        id: string;
        name: string;
        createdBy: string;
    } | null>(null);
    const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<CollaboratorRole>('viewer');
    const [projectFilter, setProjectFilter] = useState('');
    const [showArchived, setShowArchived] = useState(true);

    const roleItems = [
        { label: 'Viewer', value: 'viewer' },
        { label: 'Editor', value: 'editor' },
        { label: 'Owner', value: 'owner' }
    ];

    const ownerCount = useMemo(
        () => collaborators.filter((entry) => entry.role === 'owner').length,
        [collaborators]
    );
    const filteredProjects = useMemo(() => {
        const search = projectFilter.trim().toLowerCase();
        return projects.filter((project: any) => {
            if (!showArchived && project?.deletedAt) return false;
            const name = String(project?.name ?? '').toLowerCase();
            const owner = String(project?.createdBy ?? '').toLowerCase();
            const organisation = String(project?.authorOrganisation ?? '').toLowerCase();
            const tags = Array.isArray(project?.tags)
                ? project.tags.some((tag: unknown) => String(tag).toLowerCase().includes(search))
                : false;
            if (!search) return true;
            return (
                name.includes(search) ||
                owner.includes(search) ||
                organisation.includes(search) ||
                tags
            );
        });
    }, [projects, projectFilter, showArchived]);

    const mutation = useMutation({
        mutationFn: async (nextCollaborators: Collaborator[]) => {
            if (!editingProject) return;
            await $adminUpdateProjectCollaborators({
                data: {
                    projectId: editingProject.id,
                    collaborators: nextCollaborators
                }
            });
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: adminProjectsQueryOptions().queryKey });
            toast.success('Collaborators updated');
        },
        onError: (error) => toast.error(error.message)
    });

    const persist = (nextCollaborators: Collaborator[]) => {
        setCollaborators(nextCollaborators);
        mutation.mutate(nextCollaborators);
    };

    const openEditor = (project: {
        id: string;
        name: string;
        createdBy: string;
        collaborators?: Collaborator[];
    }) => {
        setEditingProject({
            id: project.id,
            name: project.name,
            createdBy: project.createdBy
        });
        setCollaborators(Array.isArray(project.collaborators) ? project.collaborators : []);
        setEmail('');
        setRole('viewer');
    };

    const closeEditor = () => {
        setEditingProject(null);
        setCollaborators([]);
        setEmail('');
        setRole('viewer');
    };

    const addCollaborator = () => {
        const trimmed = email.trim().toLowerCase();
        if (!trimmed) return;
        if (collaborators.some((entry) => entry.email === trimmed)) return;
        persist([...collaborators, { email: trimmed, role }]);
        setEmail('');
    };

    const removeCollaborator = (emailToRemove: string) => {
        const target = collaborators.find((entry) => entry.email === emailToRemove);
        if (!target) return;
        if (target.role === 'owner' && ownerCount <= 1) return;
        persist(collaborators.filter((entry) => entry.email !== emailToRemove));
    };

    const changeRole = (emailToChange: string, newRole: CollaboratorRole) => {
        const target = collaborators.find((entry) => entry.email === emailToChange);
        if (!target) return;
        if (target.role === 'owner' && newRole !== 'owner' && ownerCount <= 1) return;
        persist(
            collaborators.map((entry) =>
                entry.email === emailToChange ? { ...entry, role: newRole } : entry
            )
        );
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <MagnifyingGlassIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder="Search projects..."
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                        className="pl-9"
                    />
                </div>
                <Button
                    variant={showArchived ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setShowArchived((prev) => !prev)}
                >
                    <ArchiveIcon />
                    {showArchived ? 'Hide archived' : 'Show archived'}
                </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                            <th className="px-4 py-3 text-left font-medium">Name</th>
                            <th className="px-4 py-3 text-left font-medium">Owner</th>
                            <th className="px-4 py-3 text-left font-medium">Collaborators</th>
                            <th className="px-4 py-3 text-left font-medium">Created</th>
                            <th className="px-4 py-3 text-left font-medium">Updated</th>
                            <th className="px-4 py-3 text-left font-medium">Status</th>
                            <th className="px-4 py-3 text-right font-medium">Access</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {filteredProjects.map((project: any) => (
                            <tr key={project.id} className="hover:bg-muted/30">
                                <td className="px-4 py-3 font-medium">{project.name}</td>
                                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                    {project.createdBy}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                    <Badge variant="outline">
                                        {Array.isArray(project.collaborators)
                                            ? project.collaborators.length
                                            : 0}
                                    </Badge>
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                    <DateDisplay value={project.createdAt} />
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                    <DateDisplay value={project.updatedAt} />
                                </td>
                                <td className="px-4 py-3">
                                    {project.deletedAt ? (
                                        <span className="text-xs text-muted-foreground">
                                            Archived
                                        </span>
                                    ) : (
                                        <span className="text-xs text-green-600 dark:text-green-400">
                                            Active
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => openEditor(project)}
                                    >
                                        Edit collaborators
                                    </Button>
                                </td>
                            </tr>
                        ))}
                        {filteredProjects.length === 0 && (
                            <tr>
                                <td
                                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                                    colSpan={7}
                                >
                                    No projects found
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <Dialog
                open={Boolean(editingProject)}
                onOpenChange={(open) => {
                    if (!open) closeEditor();
                }}
            >
                <DialogContent className="max-w-4xl">
                    <DialogTitle>Collaborator Access</DialogTitle>
                    <DialogDescription className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                            {editingProject?.name ?? 'Project'}
                        </span>
                        <Badge variant="outline">{editingProject?.createdBy ?? ''}</Badge>
                    </DialogDescription>

                    <div className="mt-2 grid gap-4">
                        <div className="rounded-xl border bg-muted/20 p-3">
                            <div className="flex items-center gap-2">
                                <Input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            addCollaborator();
                                        }
                                    }}
                                    placeholder="collaborator@example.com"
                                    className="flex-1"
                                />
                                <Select
                                    items={roleItems}
                                    value={role}
                                    onValueChange={(value) => setRole(value as CollaboratorRole)}
                                >
                                    <SelectTrigger className="w-full max-w-48">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectGroup>
                                            <SelectLabel>Permission</SelectLabel>
                                            {roleItems.map((item) => (
                                                <SelectItem key={item.value} value={item.value}>
                                                    {item.label}
                                                </SelectItem>
                                            ))}
                                        </SelectGroup>
                                    </SelectContent>
                                </Select>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={addCollaborator}
                                >
                                    <PlusIcon />
                                    Add
                                </Button>
                            </div>
                        </div>

                        <div className="overflow-hidden rounded-2xl border">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Email</TableHead>
                                        <TableHead>Role</TableHead>
                                        <TableHead className="w-12" />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {collaborators.map((entry) => (
                                        <TableRow key={entry.email}>
                                            <TableCell>{entry.email}</TableCell>
                                            <TableCell>
                                                <Select
                                                    items={roleItems}
                                                    value={entry.role}
                                                    onValueChange={(value) =>
                                                        changeRole(
                                                            entry.email,
                                                            value as CollaboratorRole
                                                        )
                                                    }
                                                    disabled={
                                                        entry.role === 'owner' && ownerCount <= 1
                                                    }
                                                >
                                                    <SelectTrigger className="w-full max-w-48">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectGroup>
                                                            <SelectLabel>Permission</SelectLabel>
                                                            {roleItems.map((item) => (
                                                                <SelectItem
                                                                    key={item.value}
                                                                    value={item.value}
                                                                >
                                                                    {item.label}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectGroup>
                                                    </SelectContent>
                                                </Select>
                                            </TableCell>
                                            <TableCell>
                                                {!(entry.role === 'owner' && ownerCount <= 1) && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            removeCollaborator(entry.email)
                                                        }
                                                        className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                    >
                                                        <XIcon className="size-3" />
                                                    </button>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
