import { createFileRoute } from '@tanstack/react-router';

import { guardPlaygroundDevOnly } from '~/lib/playgroundGuard';

export const Route = createFileRoute('/playground/noop')({
    beforeLoad: guardPlaygroundDevOnly,
    head: () => ({
        meta: [{ title: 'Disconnected · Playground · Vizzy Studio' }]
    }),
    component: NoopPage
});

function NoopPage() {
    // `/noop` is used as a deliberate "disconnected placeholder" target for iframes.
    // In the simulator this lets developers toggle a screen/control panel offline
    // without tearing down the surrounding dashboard UI.
    return (
        <main className="flex h-screen w-screen items-center justify-center bg-[var(--background)] text-[var(--muted-foreground)]">
            <p className="text-3xl">Disconnected</p>
        </main>
    );
}
