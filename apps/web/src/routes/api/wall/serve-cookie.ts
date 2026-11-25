import { createFileRoute } from '@tanstack/react-router';

/** Old same-origin cookie bootstrap. Demo sessions now launch on a dedicated origin. */
export const Route = createFileRoute('/api/wall/serve-cookie')({
    server: {
        handlers: {
            POST: () => new Response('Use a demo launch URL', { status: 410 })
        }
    }
});
