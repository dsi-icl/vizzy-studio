import { PlusIcon, XIcon } from '@phosphor-icons/react';
import type { Collaborator, CollaboratorRole } from '@repo/db/schema';
import { Button } from '@repo/ui/components/button';
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
import { useState } from 'react';
import { toast } from 'sonner';

import { $updateProject } from '~/server/projects.fns';
import { projectQueryOptions } from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/projects/$projectId/permissions')({
    loader: async ({ context, params }) => {
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    head: ({ loaderData }) => ({
        meta: [{ title: `Permissions · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    }),
    component: PermissionsTab
});

function PermissionsTab() {
    const { projectId } = Route.useParams();
    const queryClient = useQueryClient();
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
    const [collaborators, setCollaborators] = useState<Collaborator[]>(project.collaborators);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<CollaboratorRole>('viewer');

    const mutation = useMutation({
        mutationFn: (newCollaborators: Collaborator[]) =>
            $updateProject({ data: { id: projectId, collaborators: newCollaborators } }),
        onSuccess: () => {
            toast.success('Permissions updated');
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        },
        onError: (e) => toast.error(e.message)
    });

    const addCollaborator = () => {
        const trimmed = email.trim().toLowerCase();
        if (!trimmed || collaborators.some((c) => c.email === trimmed)) return;
        const updated = [...collaborators, { email: trimmed, role }];
        setCollaborators(updated);
        mutation.mutate(updated);
        setEmail('');
    };

    const removeCollaborator = (emailToRemove: string) => {
        const updated = collaborators.filter((c) => c.email !== emailToRemove);
        setCollaborators(updated);
        mutation.mutate(updated);
    };

    const changeRole = (emailToChange: string, newRole: CollaboratorRole) => {
        const updated = collaborators.map((c) =>
            c.email === emailToChange ? { ...c, role: newRole } : c
        );
        setCollaborators(updated);
        mutation.mutate(updated);
    };

    const items = [
        { label: 'Viewer', value: 'viewer' },
        { label: 'Editor', value: 'editor' },
        { label: 'Owner', value: 'owner' }
    ];
    return (
        <div className="flex flex-col gap-6">
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
                    items={items}
                    value={role}
                    onValueChange={(value) => setRole(value as CollaboratorRole)}
                >
                    <SelectTrigger className="w-full max-w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectLabel>Permission</SelectLabel>
                            {items.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                    {item.label}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="sm" onClick={addCollaborator}>
                    <PlusIcon />
                    Add
                </Button>
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
                        {collaborators.map((c) => (
                            <TableRow key={c.email}>
                                <TableCell>{c.email}</TableCell>
                                <TableCell>
                                    <Select
                                        items={items}
                                        value={c.role}
                                        onValueChange={(value) =>
                                            changeRole(c.email, value as CollaboratorRole)
                                        }
                                        disabled={
                                            c.role === 'owner' &&
                                            collaborators.filter((x) => x.role === 'owner')
                                                .length <= 1
                                        }
                                    >
                                        <SelectTrigger className="w-full max-w-48">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                <SelectLabel>Permission</SelectLabel>
                                                {items.map((item) => (
                                                    <SelectItem key={item.value} value={item.value}>
                                                        {item.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                </TableCell>
                                <TableCell>
                                    {!(
                                        c.role === 'owner' &&
                                        collaborators.filter((x) => x.role === 'owner').length <= 1
                                    ) && (
                                        <button
                                            type="button"
                                            onClick={() => removeCollaborator(c.email)}
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
    );
}
