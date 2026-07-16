import { YinYangIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/web-corsissue')({
    head: () => ({
        meta: [{ title: 'CORS Issue · Vizzy Studio' }]
    }),
    component: WebNoNet
});

function WebNoNet() {
    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 text-neutral-400">
            <YinYangIcon size={64} weight="thin" />
            <p className="text-lg">Your target URL is actively rejecting CORS requests</p>
        </div>
    );
}
