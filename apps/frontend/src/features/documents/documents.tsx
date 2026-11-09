import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  Field,
  Input,
  PageHeader,
  QueryState,
  Select,
  StatusBadge,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiList, apiSend, apiUpload, downloadFile } from '@/lib/api-client';

const CATEGORIES = [
  'EMIRATES_ID',
  'PASSPORT',
  'TRADE_LICENCE',
  'ASSAY_CERTIFICATE',
  'CONTRACT',
  'BANK_PROOF',
  'OTHER',
];
const DOWNLOADABLE = ['CLEAN', 'SCAN_SKIPPED'];
const MAX_BYTES = 10 * 1024 * 1024;

function DocumentTable({
  query,
}: {
  query: { rows: Row[]; canDelete: boolean; remove: (id: string) => void };
}) {
  return (
    <Table
      rows={query.rows}
      columns={[
        { header: 'File', render: (r) => r.fileName as string },
        { header: 'Category', render: (r) => r.category as string },
        { header: 'Version', numeric: true, render: (r) => String(r.version) },
        { header: 'Expires', render: (r) => (r.expiresAt as string)?.slice(0, 10) ?? '—' },
        { header: 'Scan', render: (r) => <StatusBadge status={r.scanStatus as string} /> },
      ]}
      actions={(r) => (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!DOWNLOADABLE.includes(r.scanStatus as string)}
            onClick={() => {
              downloadFile(`/documents/${r.id}/content`, r.fileName as string).catch(
                (error: Error) => toast.error(error.message),
              );
            }}
          >
            Download
          </Button>
          {query.canDelete && (
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm('Archive this document?')) query.remove(r.id);
              }}
            >
              Archive
            </Button>
          )}
        </div>
      )}
    />
  );
}

/** Upload form and file list for one record. */
export function DocumentsPanel({ ownerType, ownerId }: { ownerType: string; ownerId: string }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('OTHER');
  const [expiresAt, setExpiresAt] = useState('');
  const query = useQuery({
    queryKey: ['documents', ownerType, ownerId],
    queryFn: () => apiList<Row>('/documents', { ownerType, ownerId }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['documents'] });
  const upload = useMutation({
    mutationFn: (file: File) =>
      apiUpload('/documents', file, {
        ownerType,
        ownerId,
        category,
        fileName: file.name,
        ...(expiresAt ? { expiresAt } : {}),
      }),
    onSuccess: async () => {
      toast.success('Document uploaded');
      setExpiresAt('');
      if (fileInput.current) fileInput.current.value = '';
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const archive = useMutation({
    mutationFn: (id: string) => apiSend('delete', `/documents/${id}`),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">Documents</h2>
      {can('document:create') && (
        <div className="grid items-end gap-3 md:grid-cols-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Expiry date (optional)">
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
          <Field label="File (PDF, PNG or JPEG, up to 10 MB)">
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              className="block w-full text-sm"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > MAX_BYTES) toast.error('The file is larger than 10 MB.');
                else upload.mutate(file);
              }}
            />
          </Field>
        </div>
      )}
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <DocumentTable
          query={{
            rows: query.data?.rows ?? [],
            canDelete: can('document:delete'),
            remove: (id) => archive.mutate(id),
          }}
        />
      </QueryState>
    </Card>
  );
}

const OWNERS: Record<string, { path: string; label: (row: Row) => string; permission: string }> = {
  PARTY: {
    path: '/parties',
    label: (r) => `${r.code as string} ${r.name as string}`,
    permission: 'party:read',
  },
  KYC: {
    path: '/kyc-records',
    label: (r) => `${r.documentType as string} ending ${r.documentNumberLast4 as string}`,
    permission: 'kyc:read',
  },
};

export function DocumentsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const available = Object.keys(OWNERS).filter((key) => can(OWNERS[key]?.permission as string));
  const [ownerType, setOwnerType] = useState(available[0] ?? 'PARTY');
  const [ownerId, setOwnerId] = useState('');
  const owner = OWNERS[ownerType];
  const owners = useRefOptions(owner?.path);
  const expiring = useQuery({
    queryKey: ['documents', 'expiring'],
    queryFn: () => apiList<Row>('/documents', { expiringWithinDays: 30 }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => apiSend('delete', `/documents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Documents" />
      <Card className="grid gap-3 md:grid-cols-2">
        <Field label="Belongs to">
          <Select
            value={ownerType}
            onChange={(e) => {
              setOwnerType(e.target.value);
              setOwnerId('');
            }}
          >
            {available.map((key) => (
              <option key={key}>{key}</option>
            ))}
          </Select>
        </Field>
        <Field label="Record">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Select…</option>
            {owners.data?.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {owner?.label(row)}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {ownerId && <DocumentsPanel ownerType={ownerType} ownerId={ownerId} />}
      <Card className="space-y-3">
        <h2 className="text-sm font-semibold">Expired or expiring within 30 days</h2>
        <QueryState query={expiring} empty={expiring.data?.rows.length === 0}>
          <DocumentTable
            query={{
              rows: expiring.data?.rows ?? [],
              canDelete: can('document:delete'),
              remove: (id) => archive.mutate(id),
            }}
          />
        </QueryState>
      </Card>
    </div>
  );
}
