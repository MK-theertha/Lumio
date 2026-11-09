import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  formatDecimal,
  grams,
  Input,
  PageHeader,
  QueryState,
} from '@/components/app/primitives';
import { useAuth } from '@/contexts/auth-context';
import { apiGet } from '@/lib/api-client';

interface Dashboard {
  stock: { fineWeight: string; netWeight: string; valuation?: string };
  sales: { total: string; count: number };
  purchases: { total: string; count: number };
  cashBalance: string;
  bankBalance: string;
  receivable: string;
  payable: string;
  grossProfit: string | null;
  lowStock: { sku: string; name: string; available: string; reorderLevel: string }[];
  pendingApprovals: Record<string, number>;
  salesTrend: { date: string; total: string }[];
  purchaseTrend: { date: string; total: string }[];
  recentActivity: { id: string; action: string; at: string }[];
  rates: {
    id: string;
    basis: string;
    valuePerGram: string;
    currency: string;
    effectiveAt: string;
  }[];
}

const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <Card>
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
  </Card>
);

export function DashboardPage() {
  const { user } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useQuery({
    queryKey: ['dashboard', from, to],
    queryFn: () =>
      apiGet<Dashboard>('/dashboard', { from: from || undefined, to: to || undefined }),
    refetchInterval: 60_000,
  });
  const data = query.data;
  const currency = 'AED';
  const dates = [
    ...new Set([...(data?.salesTrend ?? []), ...(data?.purchaseTrend ?? [])].map((p) => p.date)),
  ].sort();
  const chart = dates.map((date) => ({
    date: date.slice(5),
    // Recharts can only plot numbers; these values are for the drawing alone and are never recalculated.
    sales: Number(data?.salesTrend.find((p) => p.date === date)?.total ?? 0),
    purchases: Number(data?.purchaseTrend.find((p) => p.date === date)?.total ?? 0),
  }));
  const pending = Object.values(data?.pendingApprovals ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader title={`Dashboard${user?.companyName ? ` — ${user.companyName}` : ''}`}>
        <Input
          aria-label="From date"
          type="date"
          className="w-40"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          aria-label="To date"
          type="date"
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </PageHeader>
      <QueryState query={query}>
        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Fine gold in stock" value={grams(data.stock.fineWeight, 4)} />
              {data.stock.valuation && (
                <Stat
                  label="Stock valuation"
                  value={`${currency} ${formatDecimal(data.stock.valuation)}`}
                />
              )}
              <Stat
                label={`Sales (${data.sales.count})`}
                value={`${currency} ${formatDecimal(data.sales.total)}`}
              />
              <Stat
                label={`Purchases (${data.purchases.count})`}
                value={`${currency} ${formatDecimal(data.purchases.total)}`}
              />
              <Stat label="Cash balance" value={`${currency} ${formatDecimal(data.cashBalance)}`} />
              <Stat label="Bank balance" value={`${currency} ${formatDecimal(data.bankBalance)}`} />
              <Stat label="Receivable" value={`${currency} ${formatDecimal(data.receivable)}`} />
              <Stat label="Payable" value={`${currency} ${formatDecimal(data.payable)}`} />
              {data.grossProfit !== null && (
                <Stat label="Profit" value={`${currency} ${formatDecimal(data.grossProfit)}`} />
              )}
              <Stat label="Pending approvals" value={pending} />
            </div>

            <Card>
              <h2 className="mb-3 text-sm font-medium">Sales and purchases, last 30 days</h2>
              {chart.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No posted transactions yet.
                </p>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart}>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" fontSize={12} />
                      <YAxis fontSize={12} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="sales"
                        stroke="var(--primary)"
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="purchases"
                        stroke="var(--muted-foreground)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <div className="grid gap-3 lg:grid-cols-3">
              <Card>
                <h2 className="mb-2 text-sm font-medium">Low stock</h2>
                {data.lowStock.length === 0 && (
                  <p className="text-sm text-muted-foreground">No alerts.</p>
                )}
                <ul className="space-y-1 text-sm">
                  {data.lowStock.map((item) => (
                    <li key={item.sku} className="flex justify-between gap-2">
                      <span>{item.name}</span>
                      <span className="tabular-nums text-destructive">
                        {grams(item.available)} / {grams(item.reorderLevel)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <h2 className="mb-2 text-sm font-medium">Gold rates</h2>
                {data.rates.length === 0 && (
                  <p className="text-sm text-muted-foreground">No rates entered.</p>
                )}
                <ul className="space-y-1 text-sm">
                  {data.rates.map((rate) => (
                    <li key={rate.id} className="flex justify-between gap-2">
                      <span>{rate.basis === 'FINE_GRAM' ? 'Fine gold' : 'Purity rate'}</span>
                      <span className="tabular-nums">
                        {rate.currency} {formatDecimal(rate.valuePerGram, 4)}/g
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <h2 className="mb-2 text-sm font-medium">Recent activity</h2>
                <ul className="space-y-1 text-sm">
                  {data.recentActivity.map((row) => (
                    <li key={row.id} className="flex justify-between gap-2">
                      <span>{row.action}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(row.at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
