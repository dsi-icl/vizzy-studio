import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';

import { ProjectForm } from '~/components/ProjectForm';
import { $updateProject } from '~/server/projects.fns';
import { projectQueryOptions } from '~/server/projects.queries';

export const Route = createFileRoute('/_auth/quarry/projects/$projectId/')({
    loader: async ({ context, params }) => {
        const project = await context.queryClient.ensureQueryData(
            projectQueryOptions(params.projectId)
        );
        return {
            projectName: project?.name ?? 'Project'
        };
    },
    head: ({ loaderData }) => ({
        meta: [{ title: `Project Info · ${loaderData?.projectName ?? 'Project'} · Vizzy Studio` }]
    }),
    component: InfoTab
});

function InfoTab() {
    const { projectId } = Route.useParams();
    const queryClient = useQueryClient();
    const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));

    const mutation = useMutation({
        mutationFn: (data: Parameters<typeof $updateProject>[0]['data']) =>
            $updateProject({ data }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        },
        onError: (e) => toast.error(e.message)
    });

    return (
        <div className="flex flex-col gap-6">
            <ProjectForm
                projectId={projectId}
                defaultValues={{
                    name: project.name,
                    authorOrganisation: project.authorOrganisation,
                    description: project.description,
                    tags: project.tags,
                    visibility: project.visibility,
                    heroImages: project.heroImages,
                    customControlUrl: project.customControlUrl ?? '',
                    customRenderUrl: project.customRenderUrl ?? '',
                    customRenderCompat: project.customRenderCompat ?? false,
                    customRenderProxy: project.customRenderProxy ?? false,
                    collaborators: project.collaborators
                }}
                onSubmit={(data) => mutation.mutate({ ...data, id: projectId })}
                isSubmitting={mutation.isPending}
                submitLabel="Save changes"
                autoSave
                autoSaveDelayMs={1200}
            />
        </div>
    );
}
