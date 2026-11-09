import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
import { apiGet, apiSend, apiUpload, downloadFile } from '@/lib/api-client';

function useSend(done: string, after?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => apiSend('post', path, body),
    onSuccess: async () => {
      toast.success(done);
      after?.();
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

function ImportList() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('UN');
  const [format, setFormat] = useState('UN_XML');
  const upload = useMutation({
    mutationFn: (file: File) => apiUpload<Row>('/sanctions/lists/import', file, { source, format }),
    onSuccess: async (list) => {
      toast.success(`Imported ${String(list.entryCount)} entries. Parties are being rechecked.`);
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card className="grid items-end gap-3 md:grid-cols-3">
      <Field label="List name">
        <Input value={source} onChange={(e) => setSource(e.target.value)} />
      </Field>
      <Field label="Format">
        <Select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="UN_XML">UN consolidated list (XML)</option>
          <option value="CSV">CSV: externalId, name, aliases, type</option>
        </Select>
      </Field>
      <Field label="List file">
        <input
          ref={fileInput}
          type="file"
          accept=".xml,.csv"
          className="block w-full text-sm"
          disabled={upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
          }}
        />
      </Field>
    </Card>
  );
}

export function SanctionsPage() {
  const { can } = useAuth();
  const parties = useRefOptions('/parties');
  const [status, setStatus] = useState('OPEN');
  const send = useSend('Decision recorded');
  const lists = useQuery({
    queryKey: ['sanctions-lists'],
    queryFn: () => apiGet<Row[]>('/sanctions/lists'),
  });
  const matches = useQuery({
    queryKey: ['sanctions-matches', status],
    queryFn: () => apiGet<Row[]>('/sanctions/matches', { status }),
  });
  const party = new Map(parties.data?.rows.map((p) => [p.id, p.name as string]));
  const decide = (id: string, decision: string) => {
    const note = window.prompt('Reason for this decision');
    if (note) send.mutate({ path: `/sanctions/matches/${id}/decision`, body: { decision, note } });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Sanctions screening" />
      {lists.data?.length === 0 && (
        <p role="status" className="rounded-md bg-primary/15 p-3 text-sm">
          No list has been imported, so no party has been screened.
        </p>
      )}
      {can('sanctions:import') && <ImportList />}
      <QueryState query={lists} empty={lists.data?.length === 0}>
        <Table
          rows={lists.data ?? []}
          columns={[
            { header: 'List', render: (r) => r.source as string },
            { header: 'Version', render: (r) => r.version as string },
            { header: 'Entries', numeric: true, render: (r) => String(r.entryCount) },
            { header: 'Imported', render: (r) => (r.importedAt as string).slice(0, 10) },
          ]}
        />
      </QueryState>
      <div className="w-56">
        <Field label="Show matches">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['OPEN', 'FALSE_POSITIVE', 'CONFIRMED'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
      </div>
      <QueryState query={matches} empty={matches.data?.length === 0}>
        <Table
          rows={matches.data ?? []}
          columns={[
            { header: 'Party', render: (r) => party.get(r.partyId as string) ?? '—' },
            { header: 'Listed as', render: (r) => r.listedName as string },
            { header: 'Matched on', render: (r) => r.matchedName as string },
            { header: 'Score', numeric: true, render: (r) => (r.score as number).toFixed(2) },
            { header: 'List', render: (r) => `${r.source as string} ${r.externalId as string}` },
            { header: 'Born', render: (r) => (r.dateOfBirth as string) ?? '—' },
            { header: 'Nationality', render: (r) => (r.nationality as string) ?? '—' },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.status === 'OPEN' ? (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => decide(r.id, 'FALSE_POSITIVE')}>
                  Not this person
                </Button>
                <Button variant="outline" onClick={() => decide(r.id, 'CONFIRMED')}>
                  Confirm
                </Button>
              </div>
            ) : null
          }
        />
      </QueryState>
    </div>
  );
}

function NewReport({ onClose }: { onClose: () => void }) {
  const send = useSend('Draft report created', onClose);
  const cases = useQuery({
    queryKey: ['cases'],
    queryFn: () => apiGet<Row[]>('/compliance-cases'),
  });
  const [reportType, setReportType] = useState('DPMSR');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const open = cases.data?.filter((c) => ['OPEN', 'UNDER_REVIEW'].includes(c.status as string));
  return (
    <Modal title="New goAML report" onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Report type">
          <Select value={reportType} onChange={(e) => setReportType(e.target.value)}>
            <option value="DPMSR">DPMSR: dealer in precious metals and stones</option>
            <option value="STR">STR: suspicious transaction</option>
          </Select>
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Action taken (optional)">
          <Input value={action} onChange={(e) => setAction(e.target.value)} />
        </Field>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Cases to include</legend>
          {open?.length === 0 && <p className="text-muted-foreground">No open cases.</p>}
          {open?.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))
                }
              />
              {c.ruleName as string} · {(c.sourceNumber as string) ?? '—'} · {c.amount as string}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!reason || picked.length === 0 || send.isPending}
            onClick={() =>
              send.mutate({
                path: '/goaml-reports',
                body: {
                  reportType,
                  reason,
                  caseIds: picked,
                  indicators: [],
                  ...(action ? { action } : {}),
                },
              })
            }
          >
            Create draft
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function GoamlReportsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const send = useSend('Report updated');
  const query = useQuery({
    queryKey: ['goaml-reports'],
    queryFn: () => apiGet<Row[]>('/goaml-reports'),
  });
  const download = (r: Row) => {
    downloadFile(`/goaml-reports/${r.id}/xml`, `${r.number as string}.xml`).catch((error: Error) =>
      toast.error(error.message),
    );
  };
  return (
    <div className="space-y-4">
      <PageHeader title="goAML reports">
        {can('goaml:prepare') && <Button onClick={() => setCreating(true)}>New report</Button>}
      </PageHeader>
      <p role="status" className="rounded-md bg-primary/15 p-3 text-sm">
        Check each file against the XSD issued by the UAE FIU before filing. This format has not
        been validated against it.
      </p>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Type', render: (r) => r.reportType as string },
            { header: 'Reason', render: (r) => r.reason as string },
            { header: 'To fix', render: (r) => (r.warnings as string[]).join(' ') || '—' },
            { header: 'FIU reference', render: (r) => (r.fiuReference as string) ?? '—' },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) => (
            <div className="flex justify-end gap-2">
              {r.status === 'DRAFT' && can('goaml:approve') && (
                <Button
                  variant="outline"
                  onClick={() => send.mutate({ path: `/goaml-reports/${r.id}/approve` })}
                >
                  Approve
                </Button>
              )}
              {Boolean(r.hasXml) && (
                <Button variant="outline" onClick={() => download(r)}>
                  Download XML
                </Button>
              )}
              {r.status === 'APPROVED' && can('goaml:prepare') && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const fiuReference = window.prompt('FIU reference number');
                    if (fiuReference) {
                      send.mutate({
                        path: `/goaml-reports/${r.id}/submitted`,
                        body: { fiuReference },
                      });
                    }
                  }}
                >
                  Mark as filed
                </Button>
              )}
            </div>
          )}
        />
      </QueryState>
      {creating && <NewReport onClose={() => setCreating(false)} />}
    </div>
  );
}
