import { FloppyDiskIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { $adminSendSmtpTest, $adminSetConfig } from '~/server/admin.fns';
import { adminConfigQueryOptions } from '~/server/admin.queries';

export const Route = createFileRoute('/admin/config')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminConfigQueryOptions());
    },
    component: AdminConfig,
    head: () => ({
        meta: [{ title: 'Configuration · Admin · Vizzy Studio' }]
    })
});

function stringifyValue(value: unknown, type: string): string {
    if (value === null || value === undefined) return '';
    if (type === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function AdminConfig() {
    const queryClient = useQueryClient();
    const { data: fields } = useSuspenseQuery(adminConfigQueryOptions());

    const initialValues = useMemo(() => {
        const out: Record<string, string> = {};
        for (const field of fields) {
            out[field.key] = stringifyValue(field.value, field.type);
        }
        return out;
    }, [fields]);

    const [values, setValues] = useState<Record<string, string>>(initialValues);
    const [smtpTestTo, setSmtpTestTo] = useState('');

    useEffect(() => {
        setValues(initialValues);
    }, [initialValues]);

    const saveMutation = useMutation({
        mutationFn: async ({ key, value }: { key: string; value: string }) =>
            $adminSetConfig({ data: { key, value } }),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['admin', 'config'] });
            toast.success('Configuration updated');
        },
        onError: (e: any) => toast.error(e.message || 'Failed to update configuration')
    });

    const testMutation = useMutation({
        mutationFn: async () => $adminSendSmtpTest({ data: { to: smtpTestTo } }),
        onSuccess: () => toast.success('SMTP test email sent'),
        onError: (e: any) => toast.error(e.message || 'SMTP test failed')
    });

    return (
        <div className="space-y-6">
            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                            <th className="px-4 py-3 text-left font-medium">Key</th>
                            <th className="px-4 py-3 text-left font-medium">Value</th>
                            <th className="px-4 py-3 text-left font-medium">Status</th>
                            <th className="px-4 py-3 text-left font-medium">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {fields.map((field) => {
                            const current = values[field.key] ?? '';
                            const isBoolean = field.type === 'boolean';
                            const inputType = field.type === 'secret' ? 'password' : 'text';

                            return (
                                <tr key={field.key} className="hover:bg-muted/20">
                                    <td className="px-4 py-3 align-top">
                                        <div className="font-mono text-xs">{field.key}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {field.label}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        {isBoolean ? (
                                            <select
                                                className="h-9 w-48 rounded-md border border-border bg-background px-3 text-sm"
                                                value={current || 'false'}
                                                onChange={(e) =>
                                                    setValues((prev) => ({
                                                        ...prev,
                                                        [field.key]: e.target.value
                                                    }))
                                                }
                                            >
                                                <option value="false">false</option>
                                                <option value="true">true</option>
                                            </select>
                                        ) : (
                                            <Input
                                                type={inputType}
                                                value={current}
                                                placeholder={field.placeholder ?? ''}
                                                onChange={(e) =>
                                                    setValues((prev) => ({
                                                        ...prev,
                                                        [field.key]: e.target.value
                                                    }))
                                                }
                                                className="h-9 min-w-72"
                                            />
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">
                                        {field.isSet ? 'Configured' : 'Unset'}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <Button
                                            size="sm"
                                            onClick={() =>
                                                saveMutation.mutate({
                                                    key: field.key,
                                                    value: current
                                                })
                                            }
                                            disabled={saveMutation.isPending}
                                        >
                                            <FloppyDiskIcon size={14} /> Save
                                        </Button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="rounded-lg border border-border p-4">
                <h2 className="mb-2 text-sm font-medium">SMTP Test</h2>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        type="email"
                        placeholder="recipient@example.com"
                        value={smtpTestTo}
                        onChange={(e) => setSmtpTestTo(e.target.value)}
                        className="h-9 min-w-80"
                    />
                    <Button
                        onClick={() => testMutation.mutate()}
                        disabled={!smtpTestTo || testMutation.isPending}
                    >
                        <PaperPlaneTiltIcon size={14} /> Send test email
                    </Button>
                </div>
            </div>
        </div>
    );
}
