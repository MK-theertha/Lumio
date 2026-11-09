import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, Plus, Printer, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Card,
  Field,
  formatDecimal,
  grams,
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
import { DocumentsPanel } from '@/features/documents/documents';
import { apiCommand, apiGet, apiList, apiSend, downloadFile } from '@/lib/api-client';
import { EInvoiceStatus } from './e-invoices-page';

export type Mode = 'sale' | 'purchase';
const CONFIG = {
  sale: {
    path: '/sales-invoices',
    route: '/sales',
    title: 'Sales invoices',
    partyRole: 'CUSTOMER',
    partyLabel: 'Customer',
    permission: 'sale',
  },
  purchase: {
    path: '/purchase-invoices',
    route: '/purchases',
    title: 'Purchase invoices',
    partyRole: 'SUPPLIER',
    partyLabel: 'Supplier',
    permission: 'purchase',
  },
} as const;

interface TradeDoc extends Row {
  number?: string;
  status: string;
  docDate: string;
  currency: string;
  partySnapshot: { name: string; taxRegistrationNumber?: string; billingAddress?: string };
  taxableTotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  lines: TradeLine[];
}
interface TradeLine {
  lineId: string;
  productName: string;
  sku: string;
  purityLabel: string;
  tag?: string;
  pieces: number;
  grossWeight: string;
  netWeight: string;
  fineWeight: string;
  goldValue: string;
  makingCharge: string;
  discount: string;
  taxableValue: string;
  taxAmount: string;
  lineTotal: string;
  taxCode: string;
  taxTreatment: string;
  returned: boolean;
}

export function TradeListPage({ mode }: { mode: Mode }) {
  const config = CONFIG[mode];
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [config.path, status, page],
    queryFn: () => apiList<TradeDoc>(config.path, { status: status || undefined, page, limit: 25 }),
  });
  return (
    <div>
      <PageHeader title={config.title}>
        <Select
          aria-label="Status"
          className="w-44"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {[
            'DRAFT',
            'PENDING_APPROVAL',
            'APPROVED',
            'POSTED',
            'PARTIALLY_RETURNED',
            'RETURNED',
            'VOID',
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        {can(`${config.permission}:create`) && (
          <Button onClick={() => void navigate(`${config.route}/new`)}>
            <Plus className="size-4" aria-hidden /> New invoice
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <Table
          rows={query.data?.rows ?? []}
          onRowClick={(row) => void navigate(`${config.route}/${row.id}`)}
          columns={[
            { header: 'Number', render: (r) => r.number ?? 'Unposted' },
            { header: 'Date', render: (r) => r.docDate.slice(0, 10) },
            { header: config.partyLabel, render: (r) => r.partySnapshot.name },
            { header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            {
              header: 'Total',
              numeric: true,
              render: (r) => `${r.currency} ${formatDecimal(r.grandTotal)}`,
            },
          ]}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={page * 25 >= (query.data?.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </QueryState>
    </div>
  );
}

interface LineDraft {
  key: string;
  productId: string;
  warehouseId: string;
  stockItemId: string;
  pieces: string;
  grossWeight: string;
  stoneWeight: string;
  makingMode: string;
  makingValue: string;
  discountPercent: string;
  taxInclusive: boolean;
}
const newLine = (): LineDraft => ({
  key: crypto.randomUUID(),
  productId: '',
  warehouseId: '',
  stockItemId: '',
  pieces: '1',
  grossWeight: '',
  stoneWeight: '',
  makingMode: '',
  makingValue: '',
  discountPercent: '',
  taxInclusive: false,
});

function LineRow({
  mode,
  line,
  products,
  warehouses,
  onChange,
  onRemove,
}: {
  mode: Mode;
  line: LineDraft;
  products: Row[];
  warehouses: Row[];
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
}) {
  const product = products.find((p) => p.id === line.productId);
  const needsPiece = mode === 'sale' && product?.tracking === 'PIECE';
  const items = useQuery({
    queryKey: ['stock-items', line.productId],
    queryFn: () => apiGet<Row[]>('/stock/items', { productId: line.productId, status: 'IN_STOCK' }),
    enabled: needsPiece,
  });
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border p-3 md:grid-cols-6">
      <Field label="Product">
        <Select
          value={line.productId}
          onChange={(e) => onChange({ productId: e.target.value, stockItemId: '' })}
        >
          <option value="">Select…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{`${p.sku as string} ${p.name as string}`}</option>
          ))}
        </Select>
      </Field>
      <Field label="Warehouse">
        <Select
          value={line.warehouseId}
          onChange={(e) => onChange({ warehouseId: e.target.value })}
        >
          <option value="">Select…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name as string}
            </option>
          ))}
        </Select>
      </Field>
      {needsPiece ? (
        <Field label="Tagged piece">
          <Select
            value={line.stockItemId}
            onChange={(e) => {
              const item = items.data?.find((i) => i.id === e.target.value);
              onChange({
                stockItemId: e.target.value,
                grossWeight: (item?.gross as string) ?? '',
                warehouseId: (item?.warehouseId as string) ?? line.warehouseId,
              });
            }}
          >
            <option value="">Select…</option>
            {items.data?.map((i) => (
              <option
                key={i.id}
                value={i.id}
              >{`${i.tag as string} (${i.gross as string} g)`}</option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label="Pieces">
          <Input
            inputMode="numeric"
            value={line.pieces}
            onChange={(e) => onChange({ pieces: e.target.value })}
          />
        </Field>
      )}
      <Field label="Gross g">
        <Input
          inputMode="decimal"
          value={line.grossWeight}
          disabled={needsPiece}
          onChange={(e) => onChange({ grossWeight: e.target.value })}
        />
      </Field>
      <Field label="Stone g">
        <Input
          inputMode="decimal"
          value={line.stoneWeight}
          disabled={needsPiece}
          onChange={(e) => onChange({ stoneWeight: e.target.value })}
        />
      </Field>
      <Field label="Making mode">
        <Select value={line.makingMode} onChange={(e) => onChange({ makingMode: e.target.value })}>
          <option value="">Default</option>
          {[
            'NONE',
            'PER_GRAM_NET',
            'PER_GRAM_GROSS',
            'PER_PIECE',
            'PERCENT_OF_GOLD_VALUE',
            'FIXED',
          ].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
      </Field>
      <Field label="Making value">
        <Input
          inputMode="decimal"
          value={line.makingValue}
          onChange={(e) => onChange({ makingValue: e.target.value })}
        />
      </Field>
      <Field label="Discount %">
        <Input
          inputMode="decimal"
          value={line.discountPercent}
          onChange={(e) => onChange({ discountPercent: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input
          type="checkbox"
          checked={line.taxInclusive}
          onChange={(e) => onChange({ taxInclusive: e.target.checked })}
        />{' '}
        Price includes VAT
      </label>
      <div className="flex items-end justify-end">
        <Button variant="ghost" size="icon" aria-label="Remove line" onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function toPayload(lines: LineDraft[]) {
  return lines.map((line) => ({
    productId: line.productId,
    warehouseId: line.warehouseId,
    ...(line.stockItemId ? { stockItemId: line.stockItemId } : {}),
    pieces: Number(line.pieces || '1'),
    grossWeight: line.grossWeight,
    ...(line.stoneWeight ? { stoneWeight: line.stoneWeight } : {}),
    ...(line.makingMode
      ? { making: { mode: line.makingMode, value: line.makingValue || '0' } }
      : {}),
    ...(line.discountPercent
      ? { discount: { kind: 'PERCENT', target: 'LINE', value: line.discountPercent } }
      : {}),
    taxInclusive: line.taxInclusive,
  }));
}

export function TradeEditorPage({ mode }: { mode: Mode }) {
  const config = CONFIG[mode];
  const navigate = useNavigate();
  const parties = useQuery({
    queryKey: ['parties', config.partyRole],
    queryFn: () => apiList<Row>('/parties', { roles: config.partyRole, limit: 200 }),
  });
  const products = useRefOptions('/products');
  const warehouses = useRefOptions('/warehouses');
  const branches = useRefOptions('/branches');
  const accounts = useRefOptions('/financial-accounts');
  const methods = useRefOptions('/payment-methods');

  const [partyId, setPartyId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState('AED');
  const [exchangeRate, setExchangeRate] = useState('');
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [goodsReceiptId, setGoodsReceiptId] = useState('');
  const receipts = useQuery({
    queryKey: ['goods-receipts', 'RECEIVED'],
    queryFn: () => apiGet<Row[]>('/goods-receipts', { status: 'RECEIVED' }),
    enabled: mode === 'purchase',
  });
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [payAmount, setPayAmount] = useState('');
  const [payAccount, setPayAccount] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [quote, setQuote] = useState<TradeDoc | null>(null);

  const payload = useMemo(
    () => ({
      partyId,
      branchId: branchId || (branches.data?.rows[0]?.id ?? ''),
      docDate,
      currency,
      ...(exchangeRate ? { exchangeRate } : {}),
      ...(supplierInvoiceNo ? { supplierInvoiceNo } : {}),
      ...(goodsReceiptId ? { goodsReceiptId } : {}),
      lines: toPayload(lines),
      payments:
        payAmount && payAccount && payMethod
          ? [{ financialAccountId: payAccount, methodId: payMethod, amount: payAmount }]
          : [],
    }),
    [
      partyId,
      branchId,
      branches.data,
      docDate,
      currency,
      supplierInvoiceNo,
      goodsReceiptId,
      exchangeRate,
      lines,
      payAmount,
      payAccount,
      payMethod,
    ],
  );

  const calculate = useMutation({
    mutationFn: () => apiSend<TradeDoc>('post', `${config.path}/quote`, payload),
    onSuccess: setQuote,
    onError: (error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: () => apiSend<TradeDoc>('post', config.path, payload),
    onSuccess: (doc) => void navigate(`${config.route}/${doc.id}`),
    onError: (error) => toast.error(error.message),
  });

  const update = (key: string, patch: Partial<LineDraft>) => {
    setQuote(null);
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  return (
    <div className="space-y-4">
      <PageHeader title={`New ${mode === 'sale' ? 'sales' : 'purchase'} invoice`} />
      <Card className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label={config.partyLabel}>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Select…</option>
            {parties.data?.rows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Branch">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.data?.rows.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date">
          <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
        </Field>
        <Field label="Currency">
          <Input
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
        {mode === 'purchase' && (
          <Field label="Supplier invoice no.">
            <Input
              value={supplierInvoiceNo}
              onChange={(e) => setSupplierInvoiceNo(e.target.value)}
            />
          </Field>
        )}
        {currency !== 'AED' && (
          <Field label="Rate to AED">
            <Input
              inputMode="decimal"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(e.target.value)}
            />
          </Field>
        )}
        {mode === 'purchase' && (receipts.data?.length ?? 0) > 0 && (
          <Field label="Goods receipt (optional)">
            <Select value={goodsReceiptId} onChange={(e) => setGoodsReceiptId(e.target.value)}>
              <option value="">None</option>
              {receipts.data?.map((receipt) => (
                <option key={receipt.id} value={receipt.id}>
                  {receipt.number as string}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      {lines.map((line) => (
        <LineRow
          key={line.key}
          mode={mode}
          line={line}
          products={products.data?.rows ?? []}
          warehouses={warehouses.data?.rows ?? []}
          onChange={(patch) => update(line.key, patch)}
          onRemove={() => setLines((all) => all.filter((l) => l.key !== line.key))}
        />
      ))}
      <Button variant="outline" onClick={() => setLines((all) => [...all, newLine()])}>
        <Plus className="size-4" aria-hidden /> Add line
      </Button>

      <Card className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Amount paid now">
          <Input
            inputMode="decimal"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
          />
        </Field>
        <Field label="Into / from account">
          <Select value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
            <option value="">Select…</option>
            {accounts.data?.rows.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Method">
          <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
            <option value="">Select…</option>
            {methods.data?.rows.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name as string}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      {quote && (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Server calculation</h2>
          <Totals doc={quote} />
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={calculate.isPending} onClick={() => calculate.mutate()}>
          Calculate
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          Save draft
        </Button>
      </div>
    </div>
  );
}

function Totals({
  doc,
}: {
  doc: Pick<TradeDoc, 'currency' | 'taxableTotal' | 'taxTotal' | 'discountTotal' | 'grandTotal'>;
}) {
  const row = (label: string, value: string, strong?: boolean) => (
    <div className={`flex justify-between gap-8 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">
        {doc.currency} {formatDecimal(value)}
      </span>
    </div>
  );
  return (
    <div className="ms-auto max-w-xs space-y-1 text-sm">
      {row('Discount', doc.discountTotal)}
      {row('Taxable value', doc.taxableTotal)}
      {row('VAT', doc.taxTotal)}
      {row('Total', doc.grandTotal, true)}
    </div>
  );
}

export function TradeDetailPage({ mode }: { mode: Mode }) {
  const config = CONFIG[mode];
  const { id = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({
    queryKey: [config.path, id],
    queryFn: () => apiGet<TradeDoc>(`${config.path}/${id}`),
  });

  const act = useMutation({
    mutationFn: ({ path, command, body }: { path: string; command?: boolean; body?: unknown }) =>
      command
        ? apiCommand(`${config.path}/${id}/${path}`, body)
        : apiSend('post', `${config.path}/${id}/${path}`, body),
    onSuccess: async () => {
      toast.success('Done');
      setSelected([]);
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });

  const doc = query.data;
  const creditNotes = useQuery({
    queryKey: [config.path, id, 'credit-notes'],
    queryFn: () => apiGet<Row[]>(`${config.path}/${id}/credit-notes`),
    enabled: Boolean(doc?.number),
  });
  const perm = (action: string) => can(`${config.permission}:${action}`);
  const button = (
    label: string,
    path: string,
    show: boolean,
    command = false,
    variant: 'primary' | 'outline' = 'outline',
  ) =>
    show ? (
      <Button
        key={label}
        variant={variant}
        disabled={act.isPending}
        onClick={() => act.mutate({ path, command })}
      >
        {label}
      </Button>
    ) : null;

  return (
    <QueryState query={query}>
      {doc && (
        <div className="space-y-4">
          <PageHeader
            title={doc.number ?? `Draft ${mode === 'sale' ? 'sales' : 'purchase'} invoice`}
          >
            <StatusBadge status={doc.status} />
            <span className="print:hidden flex flex-wrap gap-2">
              {button('Submit', 'submit', doc.status === 'DRAFT' && perm('update'))}
              {button('Approve', 'approve', doc.status === 'PENDING_APPROVAL' && perm('approve'))}
              {button('Reject', 'reject', doc.status === 'PENDING_APPROVAL' && perm('reject'))}
              {button('Void', 'void', doc.status === 'DRAFT' && perm('update'))}
              {(doc.status === 'DRAFT' || doc.status === 'APPROVED') && perm('post') && (
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Posting cannot be undone. It updates stock, the ledger and tax. Continue?',
                      )
                    ) {
                      act.mutate({ path: 'post', command: true });
                    }
                  }}
                >
                  Post
                </Button>
              )}
              {doc.number && perm('export') && (
                <Button
                  variant="outline"
                  disabled={act.isPending}
                  onClick={() => {
                    const to = window.prompt('Send to (leave empty for the address on file)', '');
                    if (to !== null) {
                      act.mutate({ path: 'email', body: to ? { to } : {} });
                    }
                  }}
                >
                  Email
                </Button>
              )}
              {doc.number && (
                <Button
                  variant="outline"
                  onClick={() => {
                    downloadFile(`${config.path}/${id}/pdf`, `${doc.number}.pdf`).catch(
                      (error: Error) => toast.error(error.message),
                    );
                  }}
                >
                  <FileDown className="size-4" aria-hidden /> PDF
                </Button>
              )}
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden /> Print
              </Button>
            </span>
          </PageHeader>

          <Card className="grid gap-2 text-sm md:grid-cols-3">
            <div>
              <span className="text-muted-foreground">{config.partyLabel}: </span>
              {doc.partySnapshot.name}
            </div>
            <div>
              <span className="text-muted-foreground">Date: </span>
              {doc.docDate.slice(0, 10)}
            </div>
            <div>
              <span className="text-muted-foreground">TRN: </span>
              {doc.partySnapshot.taxRegistrationNumber ?? '—'}
            </div>
          </Card>

          <Table
            rows={doc.lines.map((l) => ({ ...l, id: l.lineId }))}
            columns={[
              {
                header: '',
                render: (l) =>
                  ['POSTED', 'PARTIALLY_RETURNED'].includes(doc.status) &&
                  !l.returned &&
                  perm('reverse') ? (
                    <input
                      aria-label={`Select line ${l.lineId}`}
                      type="checkbox"
                      checked={selected.includes(l.lineId)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, l.lineId] : s.filter((x) => x !== l.lineId),
                        )
                      }
                    />
                  ) : null,
              },
              {
                header: 'Item',
                render: (l) => `${l.sku} ${l.productName}${l.tag ? ` (${l.tag})` : ''}`,
              },
              { header: 'Purity', render: (l) => l.purityLabel },
              { header: 'Gross', numeric: true, render: (l) => grams(l.grossWeight) },
              { header: 'Net', numeric: true, render: (l) => grams(l.netWeight) },
              { header: 'Fine', numeric: true, render: (l) => grams(l.fineWeight, 4) },
              { header: 'Gold value', numeric: true, render: (l) => formatDecimal(l.goldValue) },
              { header: 'Making', numeric: true, render: (l) => formatDecimal(l.makingCharge) },
              { header: 'Discount', numeric: true, render: (l) => formatDecimal(l.discount) },
              {
                header: 'VAT',
                numeric: true,
                render: (l) => `${formatDecimal(l.taxAmount)} (${l.taxTreatment.toLowerCase()})`,
              },
              { header: 'Total', numeric: true, render: (l) => formatDecimal(l.lineTotal) },
              { header: 'Returned', render: (l) => (l.returned ? 'Yes' : '') },
              {
                header: '',
                render: (l) =>
                  ['POSTED', 'PARTIALLY_RETURNED'].includes(doc.status) &&
                  !l.returned &&
                  !l.tag &&
                  perm('reverse') ? (
                    <Button
                      variant="ghost"
                      className="print:hidden"
                      onClick={() => {
                        const grossWeight = window.prompt('Gross weight to return (g)');
                        const reason = grossWeight && window.prompt('Reason for the return');
                        if (grossWeight && reason) {
                          act.mutate({
                            path: 'returns',
                            command: true,
                            body: {
                              partial: [{ lineId: l.lineId, grossWeight }],
                              reason,
                              docDate: new Date().toISOString().slice(0, 10),
                            },
                          });
                        }
                      }}
                    >
                      Return part
                    </Button>
                  ) : null,
              },
            ]}
          />

          {selected.length > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                const reason = window.prompt('Reason for the return');
                if (reason) {
                  act.mutate({
                    path: 'returns',
                    command: true,
                    body: {
                      lineIds: selected,
                      reason,
                      docDate: new Date().toISOString().slice(0, 10),
                    },
                  });
                }
              }}
            >
              Return selected lines
            </Button>
          )}
          <Card>
            <Totals doc={doc} />
          </Card>
          <div className="print:hidden space-y-4">
            {creditNotes.data && creditNotes.data.length > 0 && (
              <Table
                rows={creditNotes.data}
                columns={[
                  { header: 'Credit note', render: (n) => n.number as string },
                  { header: 'Date', render: (n) => (n.docDate as string).slice(0, 10) },
                  { header: 'Reason', render: (n) => n.reason as string },
                  {
                    header: 'Total',
                    numeric: true,
                    render: (n) => formatDecimal(n.total as string),
                  },
                ]}
                actions={(n) => (
                  <Button
                    variant="outline"
                    onClick={() => {
                      downloadFile(
                        `${config.path}/${id}/credit-notes/${n.id}/pdf`,
                        `${n.number as string}.pdf`,
                      ).catch((error: Error) => toast.error(error.message));
                    }}
                  >
                    PDF
                  </Button>
                )}
              />
            )}
            {mode === 'sale' && doc.number && can('einvoice:read') && (
              <EInvoiceStatus saleId={id} number={doc.number} />
            )}
            {can('document:read') && (
              <DocumentsPanel ownerType={mode === 'sale' ? 'SALE' : 'PURCHASE'} ownerId={id} />
            )}
          </div>
        </div>
      )}
    </QueryState>
  );
}
