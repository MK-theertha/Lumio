import { provisionCompanySchema } from '@lumio/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, Field, Input, PageHeader, QueryState, Table } from '@/components/app/primitives';
import type { Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { apiGet, apiSend } from '@/lib/api-client';

const FIELDS = [
  ['code', 'Company code'],
  ['legalName', 'Legal name'],
  ['baseCurrency', 'Base currency'],
  ['branchName', 'First branch'],
  ['adminName', 'Administrator name'],
  ['adminEmail', 'Administrator email'],
] as const;

export function PlatformCompaniesPage() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({ baseCurrency: 'AED' });
  const query = useQuery({
    queryKey: ['platform-companies'],
    queryFn: () => apiGet<Row[]>('/platform/companies'),
  });
  const create = useMutation({
    mutationFn: (body: unknown) => apiSend('post', '/platform/companies', body),
    onSuccess: async () => {
      toast.success('Company created. The administrator has been emailed an invitation.');
      setValues({ baseCurrency: 'AED' });
      await queryClient.invalidateQueries({ queryKey: ['platform-companies'] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Companies" />
      <Card>
        <form
          className="grid items-end gap-3 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = provisionCompanySchema.safeParse(values);
            if (parsed.success) create.mutate(parsed.data);
            else toast.error(parsed.error.issues[0]?.message ?? 'Check the details entered.');
          }}
        >
          {FIELDS.map(([name, label]) => (
            <Field key={name} label={label}>
              <Input
                value={values[name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              />
            </Field>
          ))}
          <Button type="submit" disabled={create.isPending}>
            Create company
          </Button>
        </form>
      </Card>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Code', render: (r) => r.code as string },
            { header: 'Legal name', render: (r) => r.legalName as string },
            { header: 'Currency', render: (r) => r.baseCurrency as string },
            { header: 'Status', render: (r) => r.status as string },
          ]}
        />
      </QueryState>
    </div>
  );
}
