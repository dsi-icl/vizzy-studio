import { PlusIcon, SlideshowIcon } from '@phosphor-icons/react';
import type { StageLayout } from '@repo/db/schema';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { WallPresetPicker } from '~/components/WallPresetPicker';
import { $createSignageSlideshow } from '~/server/signage.fns';
import { signageSlideshowsQueryOptions } from '~/server/signage.queries';

export const Route = createFileRoute('/admin/signage/')({
    loader: ({ context }) => context.queryClient.ensureQueryData(signageSlideshowsQueryOptions()),
    component: SignageIndex,
    head: () => ({ meta: [{ title: 'Digital Signage · Vizzy Studio' }] })
});

function SignageIndex() {
    const { data: slideshows } = useSuspenseQuery(signageSlideshowsQueryOptions());
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [layout, setLayout] = useState<StageLayout | null>(null);

    const createMutation = useMutation({
        mutationFn: () =>
            $createSignageSlideshow({
                data: {
                    name: name.trim(),
                    layout: layout!,
                    defaultDisplayDurationMs: 10_000,
                    defaultGapDurationMs: 0,
                    gapMode: 'hold'
                }
            }),
        onSuccess: async (created) => {
            await queryClient.invalidateQueries({ queryKey: ['signage', 'slideshows'] });
            navigate({
                to: '/admin/signage/$slideshowId',
                params: { slideshowId: created.id }
            });
        },
        onError: (error: Error) => toast.error(error.message)
    });

    return (
        <div className="space-y-6">
            <section className="space-y-3 rounded-lg border border-border p-4">
                <div className="flex items-center gap-2 font-medium">
                    <PlusIcon size={16} /> New slideshow
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                        <Label htmlFor="signage-name">Name</Label>
                        <Input
                            id="signage-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Lobby loop"
                        />
                    </div>
                    <WallPresetPicker
                        idPrefix="signage-new"
                        value={layout}
                        onChange={(nextLayout) => setLayout(nextLayout)}
                    />
                </div>
                <Button
                    disabled={!name.trim() || !layout || createMutation.isPending}
                    onClick={() => createMutation.mutate()}
                >
                    Create slideshow
                </Button>
            </section>

            {slideshows.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No signage slideshows yet.
                </div>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {slideshows.map((slideshow) => (
                        <Link
                            key={slideshow.id}
                            to="/admin/signage/$slideshowId"
                            params={{ slideshowId: slideshow.id }}
                            className="rounded-lg border border-border p-4 transition-colors hover:bg-muted/30"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <div className="flex items-center gap-2 font-medium">
                                        <SlideshowIcon size={16} />
                                        {slideshow.name}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {slideshow.layout.columns}×{slideshow.layout.rows} ·{' '}
                                        {slideshow.layout.screenWidth}×
                                        {slideshow.layout.screenHeight}px panels
                                    </p>
                                </div>
                                <span
                                    className={
                                        slideshow.enabled
                                            ? 'text-xs text-green-600'
                                            : 'text-xs text-muted-foreground'
                                    }
                                >
                                    {slideshow.enabled ? 'Enabled' : 'Disabled'}
                                </span>
                            </div>
                            <p className="mt-3 text-xs text-muted-foreground">
                                {slideshow.entries.length} entries ·{' '}
                                {slideshow.targetWallIds.length} walls
                            </p>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
