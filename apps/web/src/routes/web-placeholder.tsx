import { GlobeSimpleIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/web-placeholder')({
    head: () => ({
        meta: [{ title: 'Web Placeholder · Vizzy Studio' }]
    }),
    component: WebPlaceholder
});

function WebPlaceholder() {
    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 text-neutral-400">
            <GlobeSimpleIcon size={64} weight="thin" />
            <p className="text-lg">No URL configured</p>
        </div>
    );
}
