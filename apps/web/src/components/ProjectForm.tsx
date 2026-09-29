import {
    ImageIcon,
    LightningIcon,
    LightningSlashIcon,
    PuzzlePieceIcon,
    TrashIcon
} from '@phosphor-icons/react';
import type { Collaborator, ProjectVisibility } from '@repo/db/schema';

interface CreateProjectInput {
    name: string;
    authorOrganisation: string;
    description: string;
    tags: string[];
    visibility: ProjectVisibility;
    heroImages: string[];
    customControlUrl?: string;
    customRenderUrl?: string;
    customRenderCompat: boolean;
    customRenderProxy: boolean;
    collaborators: Collaborator[];
}
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
import { ProjectImage } from '@repo/ui/components/project-image';
import { TagInput } from '@repo/ui/components/tag-input';
import { Textarea } from '@repo/ui/components/textarea';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AssetLibrary } from '~/components/AssetLibrary';
import { AssetPreviewPortal, isVideoAsset } from '~/components/AssetPreviewOverlay';
import { assetPickerFilename } from '~/lib/mediaUtils';
import { z } from '~/lib/zod';
import {
    projectAssetsQueryOptions,
    projectTagSuggestionsQueryOptions
} from '~/server/projects.queries';

interface ProjectFormProps {
    projectId?: string;
    defaultValues?: Partial<CreateProjectInput>;
    onSubmit: (data: CreateProjectInput) => void;
    isSubmitting?: boolean;
    submitLabel?: string;
    autoSave?: boolean;
    autoSaveDelayMs?: number;
}

function isValidHttpUrl(value: string): boolean {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function isOptionalHttpUrl(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true;
    return isValidHttpUrl(trimmed);
}

export function ProjectForm({
    projectId,
    defaultValues,
    onSubmit,
    isSubmitting,
    submitLabel = 'Create project',
    autoSave = false,
    autoSaveDelayMs = 1200
}: ProjectFormProps) {
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [heroSelectionDraft, setHeroSelectionDraft] = useState<string[] | null>(null);
    const [heroPreview, setHeroPreview] = useState<{
        src: string;
        name: string;
        isVideo: boolean;
        blurhash?: string;
        sizes?: number[];
    } | null>(null);
    const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSubmittedSignatureRef = useRef('');
    const { data: tagSuggestions = [] } = useQuery(projectTagSuggestionsQueryOptions());
    const { data: projectAssets = [] } = useQuery({
        ...projectAssetsQueryOptions(projectId || ''),
        enabled: Boolean(projectId)
    });

    const form = useForm({
        defaultValues: {
            name: '',
            authorOrganisation: '',
            description: '',
            tags: [],
            visibility: 'public' as const,
            heroImages: [],
            customControlUrl: '',
            customRenderUrl: '',
            customRenderCompat: false,
            customRenderProxy: false,
            collaborators: [],
            ...defaultValues
        },
        onSubmit: ({ value }) => {
            onSubmit(value);
        }
    });

    const getPayload = useCallback(
        (): CreateProjectInput => ({
            name: form.getFieldValue('name'),
            authorOrganisation: form.getFieldValue('authorOrganisation'),
            description: form.getFieldValue('description'),
            tags: form.getFieldValue('tags'),
            visibility: form.getFieldValue('visibility'),
            heroImages: form.getFieldValue('heroImages'),
            customControlUrl: form.getFieldValue('customControlUrl') || undefined,
            customRenderUrl: form.getFieldValue('customRenderUrl') || undefined,
            customRenderCompat: form.getFieldValue('customRenderCompat'),
            customRenderProxy: form.getFieldValue('customRenderProxy'),
            collaborators: form.getFieldValue('collaborators')
        }),
        [form]
    );

    const submitNow = useCallback(() => {
        const payload = getPayload();
        const signature = JSON.stringify(payload);
        if (signature === lastSubmittedSignatureRef.current) return;
        lastSubmittedSignatureRef.current = signature;
        onSubmit(payload);
    }, [getPayload, onSubmit]);

    const flushAutoSave = useCallback(() => {
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }
    }, []);

    const scheduleAutoSave = useCallback(() => {
        if (!autoSave) return;
        flushAutoSave();
        autoSaveTimerRef.current = setTimeout(() => {
            if (isSubmitting) return;
            submitNow();
        }, autoSaveDelayMs);
    }, [autoSave, autoSaveDelayMs, flushAutoSave, isSubmitting, submitNow]);

    useEffect(() => {
        lastSubmittedSignatureRef.current = JSON.stringify(getPayload());
    }, [getPayload]);

    useEffect(() => {
        return () => {
            flushAutoSave();
        };
    }, [flushAutoSave]);

    const normalizeHero = useCallback((value: string) => value.replace(/^\/api\/assets\//, ''), []);
    const toAssetSrc = useCallback((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return '';
        return trimmed.startsWith('/api/assets/') ? trimmed : `/api/assets/${trimmed}`;
    }, []);
    const findAssetByUrl = useCallback(
        (value: string) => {
            const normalized = normalizeHero(value);
            return projectAssets.find((asset) => normalizeHero(asset.url) === normalized);
        },
        [normalizeHero, projectAssets]
    );
    const getNormalizedHeroSelection = useCallback(
        () => form.getFieldValue('heroImages').map(normalizeHero),
        [form, normalizeHero]
    );

    const removeImage = (index: number) => {
        form.setFieldValue(
            'heroImages',
            form.getFieldValue('heroImages').filter((_, i) => i !== index)
        );
        scheduleAutoSave();
    };

    const toggleHeroImage = (assetUrl: string) => {
        const normalized = normalizeHero(assetUrl);
        const current = heroSelectionDraft ?? getNormalizedHeroSelection();
        const exists = current.includes(normalized);
        const next = exists ? current.filter((u) => u !== normalized) : [...current, normalized];
        setHeroSelectionDraft(next);
        form.setFieldValue('heroImages', next);
        scheduleAutoSave();
    };

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                flushAutoSave();
                form.handleSubmit();
            }}
            className="flex flex-col gap-6"
        >
            <div className="grid gap-6 lg:grid-cols-12">
                <div className="grid gap-4 lg:col-span-8">
                    <form.Field
                        name="name"
                        validators={{
                            onChange: z.string().min(1, 'Project name is required.')
                        }}
                    >
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Name / Full Title *</Label>
                                <Input
                                    id={field.name}
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                        scheduleAutoSave();
                                    }}
                                    placeholder="My Video Wall Project"
                                />
                                {field.state.meta.errors ? (
                                    <em className="text-xs text-red-500">
                                        {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                    </em>
                                ) : null}
                            </div>
                        )}
                    </form.Field>

                    <form.Field
                        name="authorOrganisation"
                        validators={{
                            onChange: z.string().min(1, 'Author/Organisation is required.')
                        }}
                    >
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Author / Organisation *</Label>
                                <Input
                                    id={field.name}
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                        scheduleAutoSave();
                                    }}
                                    placeholder="Dept. of Physics"
                                />
                                {field.state.meta.errors ? (
                                    <em className="text-xs text-red-500">
                                        {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                    </em>
                                ) : null}
                            </div>
                        )}
                    </form.Field>

                    <form.Field
                        name="description"
                        validators={{
                            onChange: z.string().min(1, 'Description is required.')
                        }}
                    >
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Description *</Label>
                                <Textarea
                                    id={field.name}
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                        scheduleAutoSave();
                                    }}
                                    placeholder="Describe your project..."
                                    rows={4}
                                />
                                {field.state.meta.errors ? (
                                    <em className="text-xs text-red-500">
                                        {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                    </em>
                                ) : null}
                            </div>
                        )}
                    </form.Field>

                    <form.Field name="tags">
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Tags</Label>
                                <TagInput
                                    value={field.state.value}
                                    onValueChange={(next) => {
                                        field.handleChange(next);
                                        scheduleAutoSave();
                                    }}
                                    placeholder="Type a tag and press Enter"
                                    suggestions={tagSuggestions}
                                />
                            </div>
                        )}
                    </form.Field>

                    <form.Field name="visibility">
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Visibility</Label>
                                <select
                                    id={field.name}
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(
                                            e.target.value === 'public' ? 'public' : 'private'
                                        );
                                        scheduleAutoSave();
                                    }}
                                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                >
                                    <option value="private">Private</option>
                                    <option value="public">Public</option>
                                </select>
                            </div>
                        )}
                    </form.Field>

                    <form.Field
                        name="customControlUrl"
                        validators={{
                            onChange: z
                                .string()
                                .refine(
                                    isOptionalHttpUrl,
                                    'Enter a valid URL starting with http:// or https://.'
                                )
                        }}
                    >
                        {(field) => (
                            <div className="grid gap-2">
                                <Label htmlFor={field.name}>Custom Control URL</Label>
                                <Input
                                    id={field.name}
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                        scheduleAutoSave();
                                    }}
                                />
                                {field.state.meta.errors ? (
                                    <em className="text-xs text-red-500">
                                        {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                    </em>
                                ) : null}
                            </div>
                        )}
                    </form.Field>

                    <form.Field
                        name="customRenderUrl"
                        validators={{
                            onChange: z
                                .string()
                                .refine(
                                    isOptionalHttpUrl,
                                    'Enter a valid URL starting with http:// or https://.'
                                )
                        }}
                    >
                        {(field) => {
                            const hasValidRenderUrl = isValidHttpUrl(field.state.value.trim());
                            return (
                                <div className="grid gap-2">
                                    <Label htmlFor={field.name}>Custom Render URL</Label>
                                    <div className="flex items-center gap-2">
                                        <Input
                                            id={field.name}
                                            value={field.state.value}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                                scheduleAutoSave();
                                            }}
                                            className="flex-1"
                                        />
                                        {hasValidRenderUrl ? (
                                            <>
                                                <form.Field name="customRenderProxy">
                                                    {(proxyField) => (
                                                        <Button
                                                            type="button"
                                                            size="icon-sm"
                                                            variant={
                                                                proxyField.state.value
                                                                    ? 'outline'
                                                                    : 'ghost'
                                                            }
                                                            title={
                                                                proxyField.state.value
                                                                    ? 'Disable custom render proxy'
                                                                    : 'Enable custom render proxy'
                                                            }
                                                            onClick={() => {
                                                                proxyField.handleChange(
                                                                    !proxyField.state.value
                                                                );
                                                                scheduleAutoSave();
                                                            }}
                                                        >
                                                            {proxyField.state.value ? (
                                                                <LightningIcon />
                                                            ) : (
                                                                <LightningSlashIcon />
                                                            )}
                                                        </Button>
                                                    )}
                                                </form.Field>
                                                <form.Field name="customRenderCompat">
                                                    {(compatField) => (
                                                        <Button
                                                            type="button"
                                                            size="icon-sm"
                                                            variant={
                                                                compatField.state.value
                                                                    ? 'outline'
                                                                    : 'ghost'
                                                            }
                                                            title={
                                                                compatField.state.value
                                                                    ? 'Disable custom render compatibility mode'
                                                                    : 'Enable custom render compatibility mode'
                                                            }
                                                            onClick={() => {
                                                                compatField.handleChange(
                                                                    !compatField.state.value
                                                                );
                                                                scheduleAutoSave();
                                                            }}
                                                        >
                                                            <PuzzlePieceIcon
                                                                weight={
                                                                    compatField.state.value
                                                                        ? 'fill'
                                                                        : 'regular'
                                                                }
                                                            />
                                                        </Button>
                                                    )}
                                                </form.Field>
                                            </>
                                        ) : null}
                                    </div>
                                    {field.state.meta.errors ? (
                                        <em className="text-xs text-red-500">
                                            {field.state.meta.errors
                                                .map((e) => e?.message)
                                                .join(', ')}
                                        </em>
                                    ) : null}
                                </div>
                            );
                        }}
                    </form.Field>
                </div>

                <div className="flex flex-col gap-4 lg:col-span-4">
                    <div className="flex flex-col justify-between gap-4">
                        <Label>Hero Images</Label>
                        <div className="flex items-center justify-between gap-4">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setAssetPickerOpen(true)}
                                disabled={!projectId}
                            >
                                <ImageIcon />
                                Choose from library
                            </Button>
                        </div>
                    </div>
                    <form.Field name="heroImages">
                        {(field) =>
                            field.state.value.length > 0 && (
                                <div className="mt-3 grid grid-cols-3 gap-2">
                                    {field.state.value.map((url, i) => (
                                        <div key={url} className="group relative">
                                            <ProjectImage
                                                src={url}
                                                alt={`Hero ${i + 1}`}
                                                className="h-24 w-full rounded-lg"
                                                imgClassName="object-cover"
                                                onClick={() => {
                                                    const asset = findAssetByUrl(url);
                                                    const src = toAssetSrc(asset?.url ?? url);

                                                    setHeroPreview({
                                                        src,
                                                        name: asset?.name ?? normalizeHero(url),
                                                        isVideo: asset
                                                            ? isVideoAsset({
                                                                  name: asset.name,
                                                                  mimeType:
                                                                      asset.mimeType ?? undefined
                                                              })
                                                            : false,
                                                        blurhash: asset?.blurhash ?? undefined,
                                                        sizes: asset?.sizes ?? undefined
                                                    });
                                                }}
                                            />
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeImage(i);
                                                }}
                                                className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100"
                                            >
                                                <TrashIcon className="size-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )
                        }
                    </form.Field>
                    {!projectId ? (
                        <p className="mt-3 text-xs text-muted-foreground">
                            Save the project first to access its asset library.
                        </p>
                    ) : null}
                </div>
            </div>

            <Dialog
                open={assetPickerOpen}
                onOpenChange={(nextOpen) => {
                    setAssetPickerOpen(nextOpen);
                    if (nextOpen) setHeroSelectionDraft(getNormalizedHeroSelection());
                    else setHeroSelectionDraft(null);
                }}
            >
                <DialogContent className="max-w-5xl overflow-hidden p-0">
                    <div className="border-b border-border px-5 py-4">
                        <DialogTitle>Select Hero Images</DialogTitle>
                        <DialogDescription className="mt-1">
                            Click images to add or remove them from the Hero Images list.
                        </DialogDescription>
                    </div>
                    <div className="bg-muted/20 px-5 py-4">
                        {projectId ? (
                            <div className="h-[68vh] max-h-[68vh] overflow-hidden rounded-2xl border border-border bg-background">
                                <AssetLibrary
                                    projectId={projectId}
                                    mode="picker"
                                    pickerFilter="image"
                                    selectedAssetUrls={
                                        heroSelectionDraft ?? getNormalizedHeroSelection()
                                    }
                                    includeSelectedSoftDeletedInPicker={true}
                                    onSelectAsset={(asset) =>
                                        toggleHeroImage(assetPickerFilename(asset))
                                    }
                                />
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                Save the project first to access its asset library.
                            </p>
                        )}
                    </div>
                    <div className="flex justify-end border-t border-border px-5 py-3">
                        <DialogClose render={<Button type="button">Done</Button>} />
                    </div>
                </DialogContent>
            </Dialog>
            <AssetPreviewPortal preview={heroPreview} onClose={() => setHeroPreview(null)} />

            <div className="flex justify-start">
                <Button type="submit" disabled={isSubmitting || !form.state.isValid}>
                    {isSubmitting ? 'Saving...' : submitLabel}
                </Button>
            </div>
        </form>
    );
}
