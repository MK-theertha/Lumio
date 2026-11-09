import { PERMISSIONS } from '@lumio/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  QueryState,
  Select,
  StatusBadge,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend } from '@/lib/api-client';

function useSend(done: string, after?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      method = 'post',
      path,
      body,
    }: {
      method?: 'post' | 'patch' | 'delete';
      path: string;
      body?: unknown;
    }) => apiSend(method, path, body),
    onSuccess: async () => {
      toast.success(done);
      after?.();
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

export function UsersPage() {
  const { user } = useAuth();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<Row[]>('/roles') });
  const query = useQuery({ queryKey: ['users'], queryFn: () => apiGet<Row[]>('/users') });
  const [open, setOpen] = useState(false);
  const send = useSend('Saved', () => setOpen(false));
  return (
    <div>
      <PageHeader title="Users">
        <Button onClick={() => setOpen(true)}>Invite user</Button>
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Name', render: (r) => r.name as string },
            { header: 'Email', render: (r) => r.email as string },
            { header: 'MFA', render: (r) => (r.mfaEnabled ? 'On' : 'Off') },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.id !== user?.id ? (
              <Button
                variant="outline"
                onClick={() =>
                  send.mutate({
                    method: 'patch',
                    path: `/users/${r.id}`,
                    body: { status: r.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' },
                  })
                }
              >
                {r.status === 'DISABLED' ? 'Activate' : 'Deactivate'}
              </Button>
            ) : null
          }
        />
      </QueryState>
      {open && (
        <Modal title="Invite user" onClose={() => setOpen(false)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const v = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<
                string,
                string
              >;
              send.mutate({
                path: '/users',
                body: {
                  email: v.email,
                  name: v.name,
                  assignments: [{ roleId: v.roleId, branchIds: [] }],
                },
              });
            }}
          >
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" required />
            </Field>
            <Field label="Role">
              <Select name="roleId" required>
                {roles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name as string}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={send.isPending}>
                Send invitation
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<Row[]>('/roles') });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const send = useSend('Role saved', () => setEditing(null));
  const groups = [...new Set(PERMISSIONS.map((p) => p.split(':')[0] as string))];
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <div>
      <PageHeader title="Roles">
        {can('role:create') && <Button onClick={() => setEditing('new')}>New role</Button>}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Name', render: (r) => r.name as string },
            {
              header: 'Permissions',
              numeric: true,
              render: (r) => String((r.permissions as string[]).length),
            },
          ]}
          actions={(r) =>
            can('role:update') ? (
              <Button variant="outline" onClick={() => setEditing(r)}>
                Edit
              </Button>
            ) : null
          }
        />
      </QueryState>
      {editing && (
        <Modal
          title={current ? `Edit ${current.name as string}` : 'New role'}
          onClose={() => setEditing(null)}
          wide
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const body = { name: data.get('name'), permissions: data.getAll('permissions') };
              send.mutate(
                current
                  ? { method: 'patch', path: `/roles/${current.id}`, body }
                  : { path: '/roles', body },
              );
            }}
          >
            <Field label="Name">
              <Input name="name" required defaultValue={(current?.name as string) ?? ''} />
            </Field>
            <div className="grid max-h-96 gap-3 overflow-y-auto md:grid-cols-3">
              {groups.map((group) => (
                <fieldset key={group} className="rounded-md border p-2">
                  <legend className="px-1 text-xs font-medium">{group}</legend>
                  {PERMISSIONS.filter((p) => p.startsWith(`${group}:`)).map((p) => (
                    <label key={p} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        name="permissions"
                        value={p}
                        defaultChecked={(current?.permissions as string[] | undefined)?.includes(p)}
                      />
                      {p.split(':')[1]}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={send.isPending}>
                Save
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function CompanySettingsPage() {
  const query = useQuery({
    queryKey: ['company'],
    queryFn: () => apiGet<Row & { settings: Record<string, unknown> }>('/company'),
  });
  const send = useSend('Settings saved');
  const d = query.data;
  return (
    <div>
      <PageHeader title="Company settings" />
      <QueryState query={query}>
        {d && (
          <Card className="max-w-xl">
            {!(d.settings.pricing as { signedOff?: boolean } | undefined)?.signedOff && (
              <p role="status" className="mb-3 rounded-md bg-primary/15 p-3 text-sm">
                Pricing and rounding rules are proposals and have not been signed off by your
                accountant.
              </p>
            )}
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const v = new FormData(event.currentTarget);
                const opt = (name: string) => {
                  const value = v.get(name) as string;
                  return value ? { [name]: value } : {};
                };
                send.mutate({
                  method: 'patch',
                  path: '/company',
                  body: {
                    legalName: v.get('legalName'),
                    ...opt('taxRegistrationNumber'),
                    ...opt('address'),
                    settings: {
                      allowNegativeStock: v.get('allowNegativeStock') === 'on',
                      rateApprovalRequired: v.get('rateApprovalRequired') === 'on',
                      requireVerifiedTaxCodes: v.get('requireVerifiedTaxCodes') === 'on',
                      numberingScope: v.get('numberingScope'),
                      ...opt('saleApprovalAmount'),
                      ...opt('purchaseApprovalAmount'),
                      ...opt('discountApprovalPercent'),
                    },
                  },
                });
              }}
            >
              <Field label="Legal name">
                <Input name="legalName" defaultValue={d.legalName as string} />
              </Field>
              <Field label="Tax registration number">
                <Input
                  name="taxRegistrationNumber"
                  defaultValue={(d.taxRegistrationNumber as string) ?? ''}
                />
              </Field>
              <Field label="Address">
                <Input name="address" defaultValue={(d.address as string) ?? ''} />
              </Field>
              <Field label="Invoice numbering scope">
                <Select name="numberingScope" defaultValue={d.settings.numberingScope as string}>
                  {['COMPANY', 'COMPANY_FISCAL_YEAR', 'BRANCH', 'BRANCH_FISCAL_YEAR'].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Sale approval at or above">
                <Input
                  name="saleApprovalAmount"
                  defaultValue={(d.settings.saleApprovalAmount as string) ?? ''}
                />
              </Field>
              <Field label="Purchase approval at or above">
                <Input
                  name="purchaseApprovalAmount"
                  defaultValue={(d.settings.purchaseApprovalAmount as string) ?? ''}
                />
              </Field>
              <Field label="Discount approval above %">
                <Input
                  name="discountApprovalPercent"
                  defaultValue={(d.settings.discountApprovalPercent as string) ?? ''}
                />
              </Field>
              {[
                ['allowNegativeStock', 'Allow negative stock'],
                ['rateApprovalRequired', 'Gold rates need approval'],
                ['requireVerifiedTaxCodes', 'Only allow tax codes verified by an adviser'],
              ].map(([name, label]) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={name}
                    defaultChecked={Boolean(d.settings[name as string])}
                  />{' '}
                  {label}
                </label>
              ))}
              <div className="flex justify-end">
                <Button type="submit" disabled={send.isPending}>
                  Save
                </Button>
              </div>
            </form>
          </Card>
        )}
      </QueryState>
    </div>
  );
}

export function AuditLogPage() {
  const query = useQuery({ queryKey: ['audit'], queryFn: () => apiGet<Row[]>('/audit-logs') });
  return (
    <div>
      <PageHeader title="Audit log" />
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'When', render: (r) => new Date(r.at as string).toLocaleString() },
            { header: 'Action', render: (r) => r.action as string },
            {
              header: 'Record',
              render: (r) => `${r.entityType as string} ${r.entityId as string}`,
            },
            { header: 'By', render: (r) => r.actorId as string },
          ]}
        />
      </QueryState>
    </div>
  );
}

export function SecurityPage() {
  const { user, reload } = useAuth();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiGet<Row[]>('/auth/sessions'),
  });
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const revoke = useSend('Session revoked');
  const start = useMutation({
    mutationFn: () => apiSend<{ secret: string; otpauthUrl: string }>('post', '/auth/mfa/enrol'),
    onSuccess: setEnrol,
    onError: (error) => toast.error(error.message),
  });
  const confirm = useMutation({
    mutationFn: () => apiSend<{ recoveryCodes: string[] }>('post', '/auth/mfa/confirm', { code }),
    onSuccess: async (result) => {
      setEnrol(null);
      setRecovery(result.recoveryCodes);
      await reload();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Security" />
      <Card>
        <h2 className="mb-2 text-sm font-medium">Multi-factor authentication</h2>
        {user?.mfaEnabled ? (
          <p className="text-sm">Enabled.</p>
        ) : enrol ? (
          <div className="space-y-2 text-sm">
            <p>Add this key to your authenticator app, then enter a code.</p>
            <code className="block break-all rounded-md bg-muted p-2">{enrol.secret}</code>
            <Input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button onClick={() => confirm.mutate()}>Confirm</Button>
          </div>
        ) : (
          <Button onClick={() => start.mutate()}>Enable MFA</Button>
        )}
        {recovery && (
          <div className="mt-3 text-sm">
            <p className="font-medium">Store these recovery codes safely. They are shown once.</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-xs">
              {recovery.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <QueryState query={sessions} empty={sessions.data?.length === 0}>
        <Table
          rows={sessions.data ?? []}
          columns={[
            { header: 'Device', render: (r) => (r.device as string) ?? '—' },
            { header: 'IP', render: (r) => (r.ip as string) ?? '—' },
            {
              header: 'Last used',
              render: (r) => new Date(r.lastUsedAt as string).toLocaleString(),
            },
            { header: 'This device', render: (r) => (r.current ? 'Yes' : '') },
          ]}
          actions={(r) =>
            !r.current ? (
              <Button
                variant="outline"
                onClick={() => revoke.mutate({ method: 'delete', path: `/auth/sessions/${r.id}` })}
              >
                Revoke
              </Button>
            ) : null
          }
        />
      </QueryState>
    </div>
  );
}

export function ComplianceCasesPage() {
  const parties = useRefOptions('/parties');
  const send = useSend('Case updated');
  const query = useQuery({
    queryKey: ['cases'],
    queryFn: () => apiGet<Row[]>('/compliance-cases'),
  });
  const party = new Map(parties.data?.rows.map((p) => [p.id, p.name as string]));
  const decide = (id: string, status: string) => {
    const decisionNote = window.prompt('Decision note');
    if (decisionNote)
      send.mutate({ path: `/compliance-cases/${id}/decision`, body: { status, decisionNote } });
  };
  return (
    <div>
      <PageHeader title="Compliance cases" />
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Rule', render: (r) => r.ruleName as string },
            { header: 'Party', render: (r) => party.get(r.partyId as string) ?? '—' },
            { header: 'Document', render: (r) => (r.sourceNumber as string) ?? '—' },
            { header: 'Amount', numeric: true, render: (r) => r.amount as string },
            { header: 'Severity', render: (r) => <StatusBadge status={r.severity as string} /> },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            ['OPEN', 'UNDER_REVIEW'].includes(r.status as string) ? (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => decide(r.id, 'CLEARED')}>
                  Clear
                </Button>
                <Button variant="outline" onClick={() => decide(r.id, 'REPORTED')}>
                  Report
                </Button>
              </div>
            ) : null
          }
        />
      </QueryState>
    </div>
  );
}
