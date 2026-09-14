import { Button } from '@repo/ui/components/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
    $adminDeleteWall,
    $adminUpdateWallLayoutTemplate,
    $adminUpdateWallMetadata
} from '~/server/admin.fns';
import { adminWallQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/walls/$wallId/')({
    loader: async ({ context, params }) => {
        const wall = await context.queryClient.ensureQueryData(
            adminWallQueryOptions(params.wallId)
        );
        return {
            wallName: wall?.name || wall?.wallId || 'Wall'
        };
    },
    head: ({ loaderData }) => ({
        meta: [{ title: `Wall Info · ${loaderData?.wallName ?? 'Wall'} · Admin · Vizzy Studio` }]
    }),
    component: WallInfoTab
});

function WallInfoTab() {
    const { wallId } = Route.useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { data: wall } = useSuspenseQuery(adminWallQueryOptions(wallId));
    const wallSlug = useMemo(() => String(wall.wallId ?? ''), [wall.wallId]);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [layout, setLayout] = useState(
        wall.layoutTemplate
            ? {
                  columns: wall.layoutTemplate.columns,
                  rows: wall.layoutTemplate.rows,
                  screenWidth: wall.layoutTemplate.screenWidth,
                  screenHeight: wall.layoutTemplate.screenHeight
              }
            : {
                  columns: wall.observedLayout?.columns ?? 1,
                  rows: wall.observedLayout?.rows ?? 1,
                  screenWidth: 1920,
                  screenHeight: 1080
              }
    );

    const metadataMutation = useMutation({
        mutationFn: async (name: string) =>
            $adminUpdateWallMetadata({
                data: {
                    wallId,
                    name
                }
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: adminWallQueryOptions(wallId).queryKey });
            queryClient.invalidateQueries({ queryKey: ['admin', 'walls'] });
            toast.success('Wall metadata updated');
        },
        onError: (e: any) => toast.error(e.message ?? 'Failed to update metadata')
    });

    const form = useForm({
        defaultValues: {
            name: wall.name ?? wall.wallId
        },
        onSubmit: async ({ value }) => {
            await metadataMutation.mutateAsync(value.name);
        }
    });

    const deleteMutation = useMutation({
        mutationFn: async () => $adminDeleteWall({ data: { wallId } }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'walls'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'devices'] });
            toast.success('Wall deleted');
            navigate({ to: '/admin/walls' });
        },
        onError: (e: any) => toast.error(e.message ?? 'Failed to delete wall')
    });

    const templateMutation = useMutation({
        mutationFn: (nextLayout: typeof layout | null) =>
            $adminUpdateWallLayoutTemplate({
                data: { wallId, layout: nextLayout }
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: adminWallQueryOptions(wallId).queryKey
            });
            toast.success('Wall layout template updated');
        },
        onError: (error: Error) => toast.error(error.message)
    });

    return (
        <div className="flex flex-col gap-4">
            <div className="space-y-1">
                <form.Field name="name">
                    {(field) => (
                        <>
                            <Label htmlFor={field.name}>Display Name</Label>
                            <Input
                                id={field.name}
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                            />
                        </>
                    )}
                </form.Field>
            </div>
            <div className="space-y-1">
                <Label htmlFor="wall-slug">Slug</Label>
                <Input id="wall-slug" value={wallSlug} readOnly />
            </div>
            <div className="space-y-3 rounded-lg border p-4">
                <div>
                    <h3 className="font-medium">Stage layout template</h3>
                    <p className="text-xs text-muted-foreground">
                        Prefills stage creation; it does not link this wall to a stage.
                    </p>
                    {wall.observedLayout && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            Currently observed: {wall.observedLayout.columns}×
                            {wall.observedLayout.rows} from {wall.observedLayout.connectedNodes}{' '}
                            connected nodes.
                        </p>
                    )}
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                    {(
                        [
                            ['columns', 'Columns'],
                            ['rows', 'Rows'],
                            ['screenWidth', 'Screen width'],
                            ['screenHeight', 'Screen height']
                        ] as const
                    ).map(([key, label]) => (
                        <div key={key} className="space-y-1">
                            <Label htmlFor={`wall-template-${key}`}>{label}</Label>
                            <Input
                                id={`wall-template-${key}`}
                                type="number"
                                min={1}
                                value={layout[key]}
                                onChange={(event) =>
                                    setLayout((current) => ({
                                        ...current,
                                        [key]: Math.max(
                                            1,
                                            Number.parseInt(event.target.value, 10) || 1
                                        )
                                    }))
                                }
                            />
                        </div>
                    ))}
                </div>
                <div className="flex flex-wrap gap-2">
                    {wall.observedLayout && (
                        <Button
                            variant="outline"
                            onClick={() =>
                                setLayout((current) => ({
                                    ...current,
                                    columns: wall.observedLayout!.columns,
                                    rows: wall.observedLayout!.rows
                                }))
                            }
                        >
                            Use observed grid
                        </Button>
                    )}
                    <Button
                        disabled={templateMutation.isPending}
                        onClick={() => templateMutation.mutate(layout)}
                    >
                        Save template
                    </Button>
                    {wall.layoutTemplate && (
                        <Button
                            variant="ghost"
                            disabled={templateMutation.isPending}
                            onClick={() => templateMutation.mutate(null)}
                        >
                            Clear template
                        </Button>
                    )}
                </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
                <Button disabled={metadataMutation.isPending} onClick={() => form.handleSubmit()}>
                    Save
                </Button>
                <Button
                    variant="destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() => setDeleteDialogOpen(true)}
                >
                    Delete Wall
                </Button>
            </div>

            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogContent className="w-80 p-5">
                    <DialogTitle>Delete wall</DialogTitle>
                    <DialogDescription className="mt-1">
                        {`Delete wall "${wallSlug || wallId}" and unassign all its devices?`}
                    </DialogDescription>
                    <div className="mt-4 flex justify-end gap-2">
                        <DialogClose>
                            <Button variant="outline" size="sm">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleteMutation.isPending}
                            onClick={() => {
                                deleteMutation.mutate();
                            }}
                        >
                            {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
