import {
  goldRateSchema,
  stockAdjustmentSchema,
  stockIssueSchema,
  stockReceiptSchema,
} from '@lumio/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
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
  StatusBadge,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend } from '@/lib/api-client';

const nameMap = (rows: Row[] | undefined, label: (r: Row) => string) =>
  new Map((rows ?? []).map((r) => [r.id, label(r)]));

function useLookups() {
  const products = useRefOptions('/products');
  const warehouses = useRefOptions('/warehouses');
  return useMemo(
    () => ({
      products: products.data?.rows ?? [],
      warehouses: warehouses.data?.rows ?? [],
      product: nameMap(products.data?.rows, (r) => `${r.sku as string} ${r.name as string}`),
      warehouse: nameMap(warehouses.data?.rows, (r) => r.name as string),
    }),
    [products.data, warehouses.data],
  );
}

type Lookups = ReturnType<typeof useLookups>;

function Choice({
  label,
  name,
  rows,
  display,
}: {
  label: string;
  name: string;
  rows: Row[];
  display: (r: Row) => string;
}) {
  return (
    <Field label={label}>
      <Select name={name} required defaultValue="">
        <option value="" disabled>
          Select…
        </option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {display(r)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A form posted to one stock endpoint, validated with the same schema the API enforces. */
function StockForm({
  title,
  path,
  schema,
  extra,
  lookups,
  onClose,
}: {
  title: string;
  path: string;
  schema: z.ZodType;
  extra: { name: string; label: string; options?: string[] }[];
  lookups: Lookups;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: unknown) => apiSend('post', path, body),
    onSuccess: async () => {
      toast.success('Saved');
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(
      [...new FormData(event.currentTarget).entries()].filter(([, v]) => v !== ''),
    );
    const parsed = schema.safeParse(
      values.pieces ? { ...values, pieces: Number(values.pieces) } : values,
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    mutation.mutate(parsed.data);
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <Choice
          label="Warehouse"
          name="warehouseId"
          rows={lookups.warehouses}
          display={(r) => r.name as string}
        />
        <Choice
          label="Product"
          name="productId"
          rows={lookups.products}
          display={(r) => `${r.sku as string} ${r.name as string}`}
        />
        {extra.map((f) => (
          <Field key={f.name} label={f.label}>
            {f.options ? (
              <Select name={f.name}>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input name={f.name} />
            )}
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const weights = [
  { name: 'pieces', label: 'Pieces' },
  { name: 'grossWeight', label: 'Gross weight (g)' },
  { name: 'stoneWeight', label: 'Stone weight (g)' },
];

export function StockPage() {
  const { can } = useAuth();
  const lookups = useLookups();
  const [form, setForm] = useState<'receive' | 'issue' | 'adjust' | null>(null);
  const query = useQuery({
    queryKey: ['stock', 'balances'],
    queryFn: () => apiGet<Row[]>('/stock/balances'),
  });
  const seeCost = can('financials:view_cost');
  return (
    <div>
      <PageHeader title="Stock on hand">
        {can('stock:create') && (
          <>
            <Button variant="outline" onClick={() => setForm('receive')}>
              Receive
            </Button>
            <Button variant="outline" onClick={() => setForm('issue')}>
              Issue
            </Button>
            <Button variant="outline" onClick={() => setForm('adjust')}>
              Adjust
            </Button>
          </>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Product', render: (r) => lookups.product.get(r.productId as string) ?? '—' },
            {
              header: 'Warehouse',
              render: (r) => lookups.warehouse.get(r.warehouseId as string) ?? '—',
            },
            { header: 'Location', render: (r) => r.location as string },
            { header: 'Pieces', numeric: true, render: (r) => String(r.pieces) },
            { header: 'Gross', numeric: true, render: (r) => grams(r.gross as string) },
            { header: 'Net', numeric: true, render: (r) => grams(r.net as string) },
            { header: 'Available', numeric: true, render: (r) => grams(r.availableNet as string) },
            { header: 'Fine', numeric: true, render: (r) => grams(r.fine as string, 4) },
            ...(seeCost
              ? [
                  {
                    header: 'Value',
                    numeric: true,
                    render: (r: Row) => formatDecimal(r.cost as string),
                  },
                ]
              : []),
          ]}
        />
      </QueryState>
      {form === 'receive' && (
        <StockForm
          title="Receive stock"
          path="/stock/receipts"
          schema={stockReceiptSchema}
          lookups={lookups}
          onClose={() => setForm(null)}
          extra={[
            ...weights,
            { name: 'totalCost', label: 'Total cost' },
            { name: 'tag', label: 'Tag (pieces)' },
            { name: 'lotNo', label: 'Lot number' },
            { name: 'reason', label: 'Reason' },
          ]}
        />
      )}
      {form === 'issue' && (
        <StockForm
          title="Issue stock"
          path="/stock/issues"
          schema={stockIssueSchema}
          lookups={lookups}
          onClose={() => setForm(null)}
          extra={[...weights, { name: 'reason', label: 'Reason' }]}
        />
      )}
      {form === 'adjust' && (
        <StockForm
          title="Request adjustment"
          path="/stock/adjustments"
          schema={stockAdjustmentSchema}
          lookups={lookups}
          onClose={() => setForm(null)}
          extra={[
            { name: 'direction', label: 'Direction', options: ['LOSS', 'GAIN'] },
            ...weights,
            { name: 'unitCostValue', label: 'Value of a gain' },
            { name: 'reason', label: 'Reason' },
          ]}
        />
      )}
    </div>
  );
}

function useDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => apiSend('post', path),
    onSuccess: async () => {
      toast.success('Done');
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

export function AdjustmentsPage() {
  const { can } = useAuth();
  const lookups = useLookups();
  const decide = useDecision();
  const query = useQuery({
    queryKey: ['stock', 'adjustments'],
    queryFn: () => apiGet<Row[]>('/stock/adjustments'),
  });
  type Payload = { productId: string; direction: string; grossWeight: string; reason: string };
  return (
    <div>
      <PageHeader title="Stock adjustments" />
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            {
              header: 'Product',
              render: (r) => lookups.product.get((r.payload as Payload).productId) ?? '—',
            },
            { header: 'Direction', render: (r) => (r.payload as Payload).direction },
            {
              header: 'Gross',
              numeric: true,
              render: (r) => grams((r.payload as Payload).grossWeight),
            },
            { header: 'Reason', render: (r) => (r.payload as Payload).reason },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.status === 'PENDING' ? (
              <div className="flex justify-end gap-2">
                {can('stock:approve') && (
                  <Button
                    variant="outline"
                    onClick={() => decide.mutate(`/stock/adjustments/${r.id}/approve`)}
                  >
                    Approve
                  </Button>
                )}
                {can('stock:reject') && (
                  <Button
                    variant="outline"
                    onClick={() => decide.mutate(`/stock/adjustments/${r.id}/reject`)}
                  >
                    Reject
                  </Button>
                )}
              </div>
            ) : null
          }
        />
      </QueryState>
    </div>
  );
}

export function TransfersPage() {
  const { can } = useAuth();
  const lookups = useLookups();
  const decide = useDecision();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['stock', 'transfers'],
    queryFn: () => apiGet<Row[]>('/stock/transfers'),
  });
  const create = useMutation({
    mutationFn: (body: unknown) => apiSend('post', '/stock/transfers', body),
    onSuccess: async () => {
      toast.success('Transfer requested');
      setOpen(false);
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div>
      <PageHeader title="Transfers">
        {can('stock:create') && <Button onClick={() => setOpen(true)}>New transfer</Button>}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            {
              header: 'From',
              render: (r) => lookups.warehouse.get(r.fromWarehouseId as string) ?? '—',
            },
            {
              header: 'To',
              render: (r) => lookups.warehouse.get(r.toWarehouseId as string) ?? '—',
            },
            {
              header: 'Lines',
              numeric: true,
              render: (r) => String((r.lines as unknown[]).length),
            },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) => (
            <div className="flex justify-end gap-2">
              {r.status === 'REQUESTED' && can('stock:approve') && (
                <Button
                  variant="outline"
                  onClick={() => decide.mutate(`/stock/transfers/${r.id}/dispatch`)}
                >
                  Dispatch
                </Button>
              )}
              {r.status === 'IN_TRANSIT' && can('stock:update') && (
                <Button
                  variant="outline"
                  onClick={() => decide.mutate(`/stock/transfers/${r.id}/receive`)}
                >
                  Receive
                </Button>
              )}
            </div>
          )}
        />
      </QueryState>
      {open && (
        <Modal title="New transfer" onClose={() => setOpen(false)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const v = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<
                string,
                string
              >;
              create.mutate({
                fromWarehouseId: v.from,
                toWarehouseId: v.to,
                lines: [
                  {
                    productId: v.productId,
                    ...(v.lotId ? { lotId: v.lotId } : {}),
                    grossWeight: v.grossWeight,
                  },
                ],
              });
            }}
          >
            <Choice
              label="From"
              name="from"
              rows={lookups.warehouses}
              display={(r) => r.name as string}
            />
            <Choice
              label="To"
              name="to"
              rows={lookups.warehouses}
              display={(r) => r.name as string}
            />
            <Choice
              label="Product"
              name="productId"
              rows={lookups.products}
              display={(r) => r.name as string}
            />
            <Field label="Lot id">
              <Input name="lotId" />
            </Field>
            <Field label="Gross weight (g)">
              <Input name="grossWeight" required />
            </Field>
            <div className="flex justify-end">
              <Button type="submit">Request</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function MovementsPage() {
  const lookups = useLookups();
  const query = useQuery({
    queryKey: ['stock', 'movements'],
    queryFn: () => apiGet<Row[]>('/stock/movements'),
  });
  return (
    <div>
      <PageHeader title="Stock movements" />
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'When', render: (r) => new Date(r.at as string).toLocaleString() },
            { header: 'Type', render: (r) => r.type as string },
            { header: 'Product', render: (r) => lookups.product.get(r.productId as string) ?? '—' },
            { header: 'Location', render: (r) => r.location as string },
            { header: 'Net', numeric: true, render: (r) => grams(r.net as string) },
            { header: 'Fine', numeric: true, render: (r) => grams(r.fine as string, 4) },
          ]}
        />
      </QueryState>
    </div>
  );
}

export function GoldRatesPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const decide = useDecision();
  const purities = useRefOptions('/purities');
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['gold-rates'], queryFn: () => apiGet<Row[]>('/gold-rates') });
  const pending = useQuery({
    queryKey: ['gold-rates', 'requests'],
    queryFn: () => apiGet<Row[]>('/gold-rates/requests'),
  });
  const create = useMutation({
    mutationFn: (body: unknown) => apiSend('post', '/gold-rates', body),
    onSuccess: async () => {
      toast.success('Rate submitted');
      setOpen(false);
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
  const purity = nameMap(purities.data?.rows, (r) => r.label as string);
  return (
    <div className="space-y-4">
      <PageHeader title="Gold rates">
        {can('gold_rate:create') && <Button onClick={() => setOpen(true)}>Enter rate</Button>}
      </PageHeader>
      {pending.data && pending.data.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Awaiting approval</h2>
          <ul className="space-y-2 text-sm">
            {pending.data.map((r) => {
              const p = r.payload as { value: string; currency: string; unit: string };
              return (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span>
                    {p.currency} {p.value} per {p.unit}
                  </span>
                  <span className="flex gap-2">
                    {can('gold_rate:approve') && (
                      <Button
                        variant="outline"
                        onClick={() => decide.mutate(`/gold-rates/requests/${r.id}/approve`)}
                      >
                        Approve
                      </Button>
                    )}
                    {can('gold_rate:reject') && (
                      <Button
                        variant="outline"
                        onClick={() => decide.mutate(`/gold-rates/requests/${r.id}/reject`)}
                      >
                        Reject
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            {
              header: 'Effective',
              render: (r) => new Date(r.effectiveAt as string).toLocaleString(),
            },
            {
              header: 'Purity',
              render: (r) => (r.purityId ? (purity.get(r.purityId as string) ?? '—') : 'Fine gold'),
            },
            { header: 'Basis', render: (r) => r.basis as string },
            {
              header: 'Per gram',
              numeric: true,
              render: (r) =>
                `${r.currency as string} ${formatDecimal(r.valuePerGram as string, 4)}`,
            },
            { header: 'Source', render: (r) => r.source as string },
          ]}
        />
      </QueryState>
      {open && (
        <Modal title="Enter gold rate" onClose={() => setOpen(false)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const values = Object.fromEntries(
                [...new FormData(event.currentTarget).entries()].filter(([, v]) => v !== ''),
              );
              const parsed = goldRateSchema.safeParse(values);
              if (!parsed.success) {
                toast.error(parsed.error.issues[0]?.message ?? 'Invalid rate');
                return;
              }
              create.mutate(parsed.data);
            }}
          >
            <Field label="Purity (blank for a fine-gold rate)">
              <Select name="purityId" defaultValue="">
                <option value="">Fine gold</option>
                {purities.data?.rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label as string}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rate is quoted per">
              <Select name="basis">
                <option value="FINE_GRAM">Gram of pure gold</option>
                <option value="PURITY_GRAM">Gram of metal at this purity</option>
              </Select>
            </Field>
            <Field label="Value">
              <Input name="value" inputMode="decimal" required />
            </Field>
            <Field label="Unit">
              <Select name="unit">
                <option value="G">Gram</option>
                <option value="KG">Kilogram</option>
                <option value="TOZ">Troy ounce</option>
                <option value="TOLA">Tola</option>
              </Select>
            </Field>
            <Field label="Currency">
              <Input name="currency" defaultValue="AED" maxLength={3} />
            </Field>
            <Field label="Source">
              <Input name="source" defaultValue="MANUAL" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={create.isPending}>
                Save
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
