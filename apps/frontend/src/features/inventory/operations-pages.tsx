import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import { Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Field,
  formatDecimal,
  grams,
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

const today = () => new Date().toISOString().slice(0, 10);

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

const namesOf = (rows: Row[] | undefined, label: (r: Row) => string) =>
  new Map((rows ?? []).map((r) => [r.id, label(r)]));

function RefSelect({
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

const productText = (r: Row) => `${r.sku as string} ${r.name as string}`;
const named = (r: Row) => r.name as string;
const coded = (r: Row) => `${r.code as string} ${r.name as string}`;

function useLots(productId: string) {
  const lots = useQuery({
    queryKey: ['stock', 'lots'],
    queryFn: () => apiGet<Row[]>('/stock/lots'),
  });
  return useMemo(
    () => (lots.data ?? []).filter((lot) => lot.productId === productId),
    [lots.data, productId],
  );
}

function LotSelect({
  productId,
  value,
  onChange,
}: {
  productId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const lots = useLots(productId);
  return (
    <Field label="Lot">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not lot-tracked</option>
        {lots.map((lot) => (
          <option key={lot.id} value={lot.id}>
            {(lot.lotNo as string) ?? lot.id}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ReservationsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    warehouseId: '',
    productId: '',
    lotId: '',
    netWeight: '',
    reference: '',
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const create = useSend('Stock reserved', () => setOpen(false));
  const release = useSend('Reservation released');
  const query = useQuery({
    queryKey: ['stock', 'reservations'],
    queryFn: () => apiGet<Row[]>('/stock/reservations'),
  });
  return (
    <div>
      <PageHeader title="Stock reservations">
        {can('stock:create') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden /> New
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Reference', render: (r) => r.reference as string },
            { header: 'Net', numeric: true, render: (r) => grams(r.netWeight as string) },
            { header: 'Expires', render: (r) => (r.expiresAt as string)?.slice(0, 10) ?? '—' },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.status === 'ACTIVE' && can('stock:update') ? (
              <Button
                variant="outline"
                onClick={() => release.mutate({ path: `/stock/reservations/${r.id}/release` })}
              >
                Release
              </Button>
            ) : null
          }
        />
      </QueryState>
      {open && (
        <Modal title="Reserve stock" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <RefSelect
              label="Warehouse"
              path="/warehouses"
              value={form.warehouseId}
              onChange={set('warehouseId')}
              text={coded}
            />
            <RefSelect
              label="Product"
              path="/products"
              value={form.productId}
              onChange={set('productId')}
              text={productText}
            />
            <LotSelect productId={form.productId} value={form.lotId} onChange={set('lotId')} />
            <Field label="Net weight (g)">
              <Input
                inputMode="decimal"
                value={form.netWeight}
                onChange={(e) => set('netWeight')(e.target.value)}
              />
            </Field>
            <Field label="Reference">
              <Input value={form.reference} onChange={(e) => set('reference')(e.target.value)} />
            </Field>
            <Button
              disabled={create.isPending}
              onClick={() => {
                const { lotId, ...rest } = form;
                create.mutate({
                  path: '/stock/reservations',
                  body: { ...rest, ...(lotId ? { lotId } : {}) },
                });
              }}
            >
              Reserve
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface CountLine {
  productId: string;
  lotId: string;
  countedNet: string;
}
const BLANK_COUNT: CountLine = { productId: '', lotId: '', countedNet: '' };

export function CountsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [lines, setLines] = useState<CountLine[]>([{ ...BLANK_COUNT }]);
  const products = useRefOptions('/products');
  const create = useSend('Count saved', () => {
    setOpen(false);
    setLines([{ ...BLANK_COUNT }]);
  });
  const approve = useSend('Count approved and booked');
  const query = useQuery({
    queryKey: ['stock', 'counts'],
    queryFn: () => apiGet<Row[]>('/stock/counts'),
  });
  const product = namesOf(products.data?.rows, productText);
  const update = (index: number, patch: Partial<CountLine>) =>
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  type Saved = { productId: string; bookNet: string; countedNet: string; varianceNet: string };
  return (
    <div>
      <PageHeader title="Physical counts">
        {can('stock:create') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden /> New
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Date', render: (r) => (r.createdAt as string).slice(0, 10) },
            {
              header: 'Lines',
              render: (r) =>
                (r.lines as Saved[])
                  .map(
                    (l) => `${product.get(l.productId) ?? '—'}: variance ${grams(l.varianceNet)}`,
                  )
                  .join('; '),
            },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.status === 'PENDING' && can('stock:approve') ? (
              <Button
                variant="outline"
                onClick={() => approve.mutate({ path: `/stock/counts/${r.id}/approve` })}
              >
                Approve
              </Button>
            ) : null
          }
        />
      </QueryState>
      {open && (
        <Modal title="New physical count" onClose={() => setOpen(false)} wide>
          <div className="space-y-3">
            <RefSelect
              label="Warehouse"
              path="/warehouses"
              value={warehouseId}
              onChange={setWarehouseId}
              text={coded}
            />
            {lines.map((line, index) => (
              <div key={index} className="grid items-end gap-2 md:grid-cols-4">
                <RefSelect
                  label="Product"
                  path="/products"
                  value={line.productId}
                  onChange={(productId) => update(index, { productId, lotId: '' })}
                  text={productText}
                />
                <LotSelect
                  productId={line.productId}
                  value={line.lotId}
                  onChange={(lotId) => update(index, { lotId })}
                />
                <Field label="Counted net (g)">
                  <Input
                    inputMode="decimal"
                    value={line.countedNet}
                    onChange={(e) => update(index, { countedNet: e.target.value })}
                  />
                </Field>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((all) => all.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setLines((all) => [...all, { ...BLANK_COUNT }])}
              >
                Add line
              </Button>
              <Button
                disabled={create.isPending}
                onClick={() =>
                  create.mutate({
                    path: '/stock/counts',
                    body: {
                      warehouseId,
                      lines: lines.map(({ lotId, ...line }) => ({
                        ...line,
                        ...(lotId ? { lotId } : {}),
                      })),
                    },
                  })
                }
              >
                Save count
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface OrderLine {
  productId: string;
  expectedWeight: string;
  receivedWeight?: string;
}

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [partyId, setPartyId] = useState('');
  const [productId, setProductId] = useState('');
  const [expectedWeight, setExpectedWeight] = useState('');
  const parties = useRefOptions('/parties');
  const products = useRefOptions('/products');
  const branches = useRefOptions('/branches');
  const create = useSend('Purchase order created', () => setOpen(false));
  const query = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => apiGet<Row[]>('/purchase-orders'),
  });
  const party = namesOf(parties.data?.rows, named);
  const product = namesOf(products.data?.rows, productText);
  return (
    <div>
      <PageHeader title="Purchase orders">
        {can('purchase:create') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden /> New
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Supplier', render: (r) => party.get(r.partyId as string) ?? '—' },
            { header: 'Date', render: (r) => (r.orderDate as string).slice(0, 10) },
            {
              header: 'Lines',
              render: (r) =>
                (r.lines as OrderLine[])
                  .map(
                    (l) =>
                      `${product.get(l.productId) ?? '—'}: ${grams(l.receivedWeight ?? '0')} of ${grams(l.expectedWeight)}`,
                  )
                  .join('; '),
            },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
        />
      </QueryState>
      {open && (
        <Modal title="New purchase order" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <RefSelect
              label="Supplier"
              path="/parties?roles=SUPPLIER"
              value={partyId}
              onChange={setPartyId}
              text={named}
            />
            <RefSelect
              label="Product"
              path="/products"
              value={productId}
              onChange={setProductId}
              text={productText}
            />
            <Field label="Expected weight (g)">
              <Input
                inputMode="decimal"
                value={expectedWeight}
                onChange={(e) => setExpectedWeight(e.target.value)}
              />
            </Field>
            <Button
              disabled={create.isPending}
              onClick={() =>
                create.mutate({
                  path: '/purchase-orders',
                  body: {
                    partyId,
                    branchId: branches.data?.rows[0]?.id,
                    orderDate: today(),
                    lines: [{ productId, expectedWeight }],
                  },
                })
              }
            >
              Create
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function GoodsReceiptsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    partyId: '',
    purchaseOrderId: '',
    warehouseId: '',
    productId: '',
    grossWeight: '',
    expectedWeight: '',
    cost: '',
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const parties = useRefOptions('/parties');
  const branches = useRefOptions('/branches');
  const orders = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => apiGet<Row[]>('/purchase-orders'),
  });
  const create = useSend('Goods received', () => setOpen(false));
  const query = useQuery({
    queryKey: ['goods-receipts'],
    queryFn: () => apiGet<Row[]>('/goods-receipts'),
  });
  const party = namesOf(parties.data?.rows, named);
  const openOrders = orders.data?.filter((o) => o.status === 'OPEN' && o.partyId === form.partyId);
  return (
    <div>
      <PageHeader title="Goods receipts">
        {can('purchase:create') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden /> New
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Supplier', render: (r) => party.get(r.partyId as string) ?? '—' },
            { header: 'Date', render: (r) => (r.receiptDate as string).slice(0, 10) },
            { header: 'Value', numeric: true, render: (r) => formatDecimal(r.total as string) },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
        />
      </QueryState>
      {open && (
        <Modal title="Receive goods" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <RefSelect
              label="Supplier"
              path="/parties?roles=SUPPLIER"
              value={form.partyId}
              onChange={set('partyId')}
              text={named}
            />
            <Field label="Purchase order (optional)">
              <Select
                value={form.purchaseOrderId}
                onChange={(e) => set('purchaseOrderId')(e.target.value)}
              >
                <option value="">None</option>
                {openOrders?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number as string}
                  </option>
                ))}
              </Select>
            </Field>
            <RefSelect
              label="Warehouse"
              path="/warehouses"
              value={form.warehouseId}
              onChange={set('warehouseId')}
              text={coded}
            />
            <RefSelect
              label="Product"
              path="/products"
              value={form.productId}
              onChange={set('productId')}
              text={productText}
            />
            <Field label="Gross weight received (g)">
              <Input
                inputMode="decimal"
                value={form.grossWeight}
                onChange={(e) => set('grossWeight')(e.target.value)}
              />
            </Field>
            <Field label="Expected weight (g, optional)">
              <Input
                inputMode="decimal"
                value={form.expectedWeight}
                onChange={(e) => set('expectedWeight')(e.target.value)}
              />
            </Field>
            <Field label="Estimated cost">
              <Input
                inputMode="decimal"
                value={form.cost}
                onChange={(e) => set('cost')(e.target.value)}
              />
            </Field>
            <Button
              disabled={create.isPending}
              onClick={() =>
                create.mutate({
                  path: '/goods-receipts',
                  body: {
                    partyId: form.partyId,
                    branchId: branches.data?.rows[0]?.id,
                    receiptDate: today(),
                    ...(form.purchaseOrderId ? { purchaseOrderId: form.purchaseOrderId } : {}),
                    lines: [
                      {
                        productId: form.productId,
                        warehouseId: form.warehouseId,
                        grossWeight: form.grossWeight,
                        cost: form.cost,
                        ...(form.expectedWeight ? { expectedWeight: form.expectedWeight } : {}),
                      },
                    ],
                  },
                })
              }
            >
              Receive
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Barcode({ value }: { value: string }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (svg.current) {
      JsBarcode(svg.current, value, { format: 'CODE128', height: 40, width: 1.4, fontSize: 12 });
    }
  }, [value]);
  return <svg ref={svg} aria-label={`Barcode ${value}`} />;
}

export function LabelsPage() {
  const products = useRefOptions('/products');
  const query = useQuery({
    queryKey: ['stock', 'items', 'IN_STOCK'],
    queryFn: () => apiGet<Row[]>('/stock/items', { status: 'IN_STOCK' }),
  });
  const product = namesOf(products.data?.rows, productText);
  return (
    <div>
      <PageHeader title="Barcode labels">
        <span className="print:hidden">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print
          </Button>
        </span>
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-3">
          {query.data?.map((item) => (
            <div
              key={item.id}
              className="break-inside-avoid rounded-md border bg-white p-2 text-center text-xs text-black"
            >
              <p className="truncate">{product.get(item.productId as string) ?? ''}</p>
              <Barcode value={item.tag as string} />
              <p>{grams(item.gross as string)} g</p>
            </div>
          ))}
        </div>
      </QueryState>
    </div>
  );
}
