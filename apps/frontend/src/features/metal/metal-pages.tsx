import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  Field,
  formatDecimal,
  grams,
  Input,
  Modal,
  PageHeader,
  QueryState,
  Select,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend } from '@/lib/api-client';

const today = () => new Date().toISOString().slice(0, 10);

function useSend(done: string, after?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => apiSend('post', path, body),
    onSuccess: async () => {
      toast.success(done);
      after?.();
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

function Choice({
  label,
  path,
  value,
  onChange,
  text,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  text: (row: Row) => string;
}) {
  const options = useRefOptions(path);
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {options.data?.rows.map((row) => (
          <option key={row.id} value={row.id}>
            {text(row)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const partyText = (r: Row) => `${r.code as string} ${r.name as string}`;
const productText = (r: Row) => `${r.sku as string} ${r.name as string}`;

function MoveDialog({ kind, onClose }: { kind: 'receipts' | 'issues'; onClose: () => void }) {
  const send = useSend(kind === 'receipts' ? 'Metal received' : 'Metal issued', onClose);
  const [form, setForm] = useState({
    partyId: '',
    warehouseId: '',
    productId: '',
    grossWeight: '',
    provisionalRate: '',
    date: today(),
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const { provisionalRate, ...common } = form;
  return (
    <Modal
      title={kind === 'receipts' ? 'Receive unfixed metal' : 'Issue unfixed metal'}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Choice
          label="Party"
          path="/parties"
          value={form.partyId}
          onChange={set('partyId')}
          text={partyText}
        />
        <Choice
          label="Warehouse"
          path="/warehouses"
          value={form.warehouseId}
          onChange={set('warehouseId')}
          text={partyText}
        />
        <Choice
          label="Product"
          path="/products"
          value={form.productId}
          onChange={set('productId')}
          text={productText}
        />
        <Field label="Gross weight (g)">
          <Input
            inputMode="decimal"
            value={form.grossWeight}
            onChange={(e) => set('grossWeight')(e.target.value)}
          />
        </Field>
        {kind === 'receipts' && (
          <Field label="Provisional rate per fine gram">
            <Input
              inputMode="decimal"
              value={provisionalRate}
              onChange={(e) => set('provisionalRate')(e.target.value)}
            />
          </Field>
        )}
        <Button
          disabled={send.isPending}
          onClick={() =>
            send.mutate({
              path: `/metal-accounts/${kind}`,
              body: kind === 'receipts' ? form : common,
            })
          }
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

function FixDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const branches = useRefOptions('/branches');
  const send = useSend('Price fixed', onClose);
  const balance = Number(row.fineGrams);
  const [fineGrams, setFineGrams] = useState(Math.abs(balance).toFixed(4));
  const [rate, setRate] = useState('');
  const [productKind, setProductKind] = useState('BAR');
  const [fineness, setFineness] = useState('0.9999');
  const amount = Number(fineGrams) * Number(rate);
  return (
    <Modal
      title={`${balance > 0 ? 'Buy from' : 'Sell to'} ${row.party as string}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field label="Fine grams to fix">
          <Input
            inputMode="decimal"
            value={fineGrams}
            onChange={(e) => setFineGrams(e.target.value)}
          />
        </Field>
        <Field label="Rate per fine gram">
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Metal type, for VAT">
          <Select value={productKind} onChange={(e) => setProductKind(e.target.value)}>
            {['BAR', 'BULLION', 'COIN', 'JEWELLERY', 'SCRAP', 'RAW_GOLD'].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </Select>
        </Field>
        <Field label="Fineness, for VAT">
          <Input
            inputMode="decimal"
            value={fineness}
            onChange={(e) => setFineness(e.target.value)}
          />
        </Field>
        <p className="text-sm text-muted-foreground">
          Value before VAT: {formatDecimal(Number.isFinite(amount) ? amount.toFixed(2) : '0')}
        </p>
        <Button
          disabled={send.isPending || !rate}
          onClick={() =>
            send.mutate({
              path: '/metal-accounts/fixes',
              body: {
                partyId: row.partyId,
                branchId: branches.data?.rows[0]?.id,
                fineGrams,
                ratePerFineGram: rate,
                productKind,
                fineness,
                date: today(),
              },
            })
          }
        >
          Fix price
        </Button>
      </div>
    </Modal>
  );
}

function Statement({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['metal-statement', partyId],
    queryFn: () => apiGet<{ party: string; rows: Row[] }>(`/metal-accounts/${partyId}/statement`),
  });
  return (
    <Modal title={`Metal statement: ${query.data?.party ?? ''}`} onClose={onClose} wide>
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <Table
          rows={query.data?.rows ?? []}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Type', render: (r) => r.type as string },
            { header: 'Date', render: (r) => (r.date as string).slice(0, 10) },
            { header: 'Fine (g)', numeric: true, render: (r) => grams(r.fineGrams as string, 4) },
            {
              header: 'Rate',
              numeric: true,
              render: (r) =>
                r.type === 'FIX' ? formatDecimal(r.ratePerFineGram as string, 4) : '',
            },
            { header: 'Balance', numeric: true, render: (r) => grams(r.balance as string, 4) },
          ]}
        />
      </QueryState>
    </Modal>
  );
}

export function MetalAccountsPage() {
  const { can } = useAuth();
  const [moving, setMoving] = useState<'receipts' | 'issues' | null>(null);
  const [fixing, setFixing] = useState<Row | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['metal-accounts'],
    queryFn: () => apiGet<{ netFineOwedToParties: string; rows: Row[] }>('/metal-accounts'),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Metal accounts">
        {can('metal:create') && (
          <>
            <Button variant="outline" onClick={() => setMoving('receipts')}>
              Receive metal
            </Button>
            <Button variant="outline" onClick={() => setMoving('issues')}>
              Issue metal
            </Button>
          </>
        )}
      </PageHeader>
      <p className="text-sm text-muted-foreground">
        Gold held or lent with no price agreed yet. A positive balance is metal the company owes the
        party. Net owed to parties: {grams(query.data?.netFineOwedToParties, 4)} g fine.
      </p>
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <Table
          rows={query.data?.rows ?? []}
          onRowClick={(r) => setViewing(r.partyId as string)}
          columns={[
            { header: 'Party', render: (r) => r.party as string },
            { header: 'Fine (g)', numeric: true, render: (r) => grams(r.fineGrams as string, 4) },
            {
              header: 'Carried at',
              numeric: true,
              render: (r) => formatDecimal(r.carryingValue as string),
            },
          ]}
          actions={(r) =>
            can('metal:fix') ? (
              <Button variant="outline" onClick={() => setFixing(r)}>
                Fix price
              </Button>
            ) : null
          }
        />
      </QueryState>
      {moving && <MoveDialog kind={moving} onClose={() => setMoving(null)} />}
      {fixing && <FixDialog row={fixing} onClose={() => setFixing(null)} />}
      {viewing && <Statement partyId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

interface BoardRow extends Row {
  purity: string;
  fineness: string;
  perGram: string;
  perTola: string;
}

export function RateBoardPage() {
  const { can } = useAuth();
  const [usdPerOz, setUsdPerOz] = useState('');
  const [usdAed, setUsdAed] = useState('3.6725');
  const [premiumPerGram, setPremium] = useState('0');
  const send = useSend('Rate published');
  const query = useQuery({
    queryKey: ['rate-board'],
    queryFn: () =>
      apiGet<{ effectiveAt: string | null; currency: string; tolaGrams: string; rows: BoardRow[] }>(
        '/gold-rates/board',
      ),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Rate board" />
      {can('gold_rate:create') && (
        <Card className="grid items-end gap-3 md:grid-cols-4">
          <Field label="Spot USD per troy ounce">
            <Input
              inputMode="decimal"
              value={usdPerOz}
              onChange={(e) => setUsdPerOz(e.target.value)}
            />
          </Field>
          <Field label="USD to AED">
            <Input inputMode="decimal" value={usdAed} onChange={(e) => setUsdAed(e.target.value)} />
          </Field>
          <Field label="Premium per fine gram">
            <Input
              inputMode="decimal"
              value={premiumPerGram}
              onChange={(e) => setPremium(e.target.value)}
            />
          </Field>
          <Button
            disabled={!usdPerOz || send.isPending}
            onClick={() =>
              send.mutate({ path: '/gold-rates/spot', body: { usdPerOz, usdAed, premiumPerGram } })
            }
          >
            Publish rate
          </Button>
        </Card>
      )}
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <p className="text-sm text-muted-foreground">
          {query.data?.effectiveAt?.replace('T', ' ').slice(0, 16)} UTC, 1 tola ={' '}
          {query.data?.tolaGrams} g
        </p>
        <Table
          rows={query.data?.rows ?? []}
          columns={[
            { header: 'Purity', render: (r) => r.purity },
            { header: 'Fineness', numeric: true, render: (r) => r.fineness },
            {
              header: `${query.data?.currency ?? ''} per gram`,
              numeric: true,
              render: (r) => formatDecimal(r.perGram),
            },
            {
              header: `${query.data?.currency ?? ''} per tola`,
              numeric: true,
              render: (r) => formatDecimal(r.perTola),
            },
          ]}
        />
      </QueryState>
    </div>
  );
}
