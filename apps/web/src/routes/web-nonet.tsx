import { NetworkXIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/web-nonet')({
    head: () => ({
        meta: [{ title: 'Network Error · Vizzy Studio' }]
    }),
    component: WebNoNet
});

function WebNoNet() {
    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 text-neutral-400">
            <NetworkXIcon size={64} weight="thin" />
            <p className="text-lg">An error occured fetch your content</p>
        </div>
    );
}
