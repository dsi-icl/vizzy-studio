import { Button } from '@repo/ui/components/button';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/legal/privacy')({
    head: () => ({
        meta: [{ title: 'Privacy Notice · Vizzy Studio' }]
    }),
    component: PrivacyNoticePage
});

function PrivacyNoticePage() {
    return (
        <div className="flex h-full flex-col overflow-hidden pt-14 pb-14">
            <div className="mx-auto w-full max-w-5xl shrink-0 px-6 pt-4">
                <div className="mb-6">
                    <Button
                        variant="outline"
                        onClick={() => {
                            if (window.history.length > 1) {
                                window.history.back();
                                return;
                            }
                            window.location.href = '/';
                        }}
                    >
                        Back
                    </Button>
                </div>

                <h1 className="text-3xl font-semibold tracking-tight">Privacy Notice</h1>
                <p className="mt-3 text-sm text-muted-foreground">Last updated: April 17, 2026</p>
            </div>

            <div className="relative mx-auto min-h-0 w-full max-w-5xl flex-1">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent" />
                <div className="h-full scrollbar-none overflow-y-auto px-6 pt-8 pb-6">
                    <div className="space-y-6 text-sm leading-relaxed">
                        <section className="rounded-lg border p-4">
                            <h2 className="text-lg font-medium">What this app collects</h2>
                            <p className="mt-2 text-muted-foreground">
                                Vizzy Studio stores account and project information needed to run
                                the service. This may include your account identifier (such as
                                email), project metadata, collaborators, uploaded assets, and
                                editing activity.
                            </p>
                        </section>

                        <section className="rounded-lg border p-4">
                            <h2 className="text-lg font-medium">Cookies and session use</h2>
                            <p className="mt-2 text-muted-foreground">
                                This application uses essential cookies to keep you signed in and to
                                maintain secure user sessions. These cookies are required for
                                authentication and core functionality and are not used for
                                advertising.
                            </p>
                        </section>

                        <section className="rounded-lg border p-4">
                            <h2 className="text-lg font-medium">Uploaded assets</h2>
                            <p className="mt-2 text-muted-foreground">
                                Files you upload (for example images, videos, fonts, and related
                                metadata) are stored so projects can be edited and rendered. If
                                assets are removed in the app, they may be soft-deleted first as
                                part of normal project and administration workflows.
                            </p>
                        </section>

                        <section className="rounded-lg border p-4">
                            <h2 className="text-lg font-medium">How data is used</h2>
                            <p className="mt-2 text-muted-foreground">
                                Collected data is used to provide access control, project
                                collaboration, content management, auditing, and service
                                reliability.
                            </p>
                        </section>

                        <section className="rounded-lg border p-4">
                            <h2 className="text-lg font-medium">Contact</h2>
                            <p className="mt-2 text-muted-foreground">
                                For questions about privacy or data handling, contact{' '}
                                <a className="underline" href="mailto:f.guitton@imperial.ac.uk">
                                    f.guitton@imperial.ac.uk
                                </a>
                                .
                            </p>
                        </section>
                    </div>
                </div>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t from-background to-transparent" />
            </div>
        </div>
    );
}
