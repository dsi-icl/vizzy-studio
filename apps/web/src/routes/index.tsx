import { authQueryOptions } from '@repo/auth/tanstack/queries';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';

import { publishedProjectsQueryOptions } from '~/server/projects.queries';

const LandingHero = lazy(() => import('~/components/LandingHero'));

export const Route = createFileRoute('/')({
    beforeLoad: async ({ context, search }) => {
        const { w } = search as { w?: string };
        if (w) {
            const user = await context.queryClient.ensureQueryData(authQueryOptions());
            if (!user) {
                throw redirect({ to: '/gallery', search: { w } });
            }
        }
    },
    component: HomePage,
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(publishedProjectsQueryOptions());
    },
    head: () => ({
        meta: [{ title: 'Home · Vizzy Studio' }]
    })
});

function HomePage() {
    const { data: projects } = useSuspenseQuery(publishedProjectsQueryOptions());
    const navigate = useNavigate();

    const heroImages = useMemo(
        () =>
            projects.flatMap((p) => {
                const images = Array.isArray(p.heroImages) ? p.heroImages : [];
                const metaBySrc = new Map(
                    (
                        (
                            p as {
                                heroImageMeta?: Array<{ src: string; sizes?: number[] }>;
                            }
                        ).heroImageMeta ?? []
                    ).map((entry) => [entry.src, entry])
                );
                return images.map((src) => ({
                    src,
                    sizes: metaBySrc.get(src)?.sizes
                }));
            }),
        [projects]
    );

    return (
        <div className="relative h-screen w-screen overflow-hidden">
            <Suspense
                fallback={<div className="h-full w-full" style={{ backgroundColor: '#111' }} />}
            >
                <LandingHero
                    heroImages={heroImages}
                    onActivate={() => navigate({ to: '/gallery' })}
                />
            </Suspense>
        </div>
    );
}
