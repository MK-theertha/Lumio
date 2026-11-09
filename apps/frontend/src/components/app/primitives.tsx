import { X } from 'lucide-react';
import { forwardRef, useEffect, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const fieldClass =
  'h-9 w-full rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(fieldClass, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(fieldClass, className)} {...props} />;
});

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-md border bg-card p-4', className)} {...props} />;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('w-full rounded-md border bg-card p-5', wide ? 'max-w-4xl' : 'max-w-lg')}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  good: 'bg-success/15 text-success',
  bad: 'bg-destructive/15 text-destructive',
  warn: 'bg-primary/15 text-primary',
  plain: 'bg-muted text-muted-foreground',
};

const STATUS_TONE: Record<string, string> = {
  POSTED: 'good',
  APPROVED: 'good',
  ACTIVE: 'good',
  OPEN: 'good',
  VERIFIED: 'good',
  RECEIVED: 'good',
  CLEARED: 'good',
  SETTLED: 'good',
  CLEAN: 'good',
  PASSED: 'good',
  INFO: 'plain',
  WARNING: 'warn',
  CRITICAL: 'bad',
  CLEAR: 'good',
  ACCEPTED: 'good',
  MATCHED: 'good',
  ADJUSTED: 'good',
  COMPLETED: 'good',
  SUBMITTED: 'good',
  FALSE_POSITIVE: 'good',
  PENDING_APPROVAL: 'warn',
  PENDING: 'warn',
  REQUESTED: 'warn',
  IN_TRANSIT: 'warn',
  CLOSING: 'warn',
  INVITED: 'warn',
  UNDER_REVIEW: 'warn',
  PARTIALLY_RETURNED: 'warn',
  SCAN_SKIPPED: 'warn',
  NOT_SCREENED: 'warn',
  UNMATCHED: 'warn',
  POTENTIAL_MATCH: 'bad',
  CONFIRMED_MATCH: 'bad',
  CONFIRMED: 'bad',
  INFECTED: 'bad',
  FAILED: 'bad',
  REJECTED: 'bad',
  REVERSED: 'bad',
  DISABLED: 'bad',
  RETURNED: 'bad',
  REPORTED: 'bad',
  HIGH: 'bad',
  VOID: 'plain',
  DRAFT: 'plain',
  CLOSED: 'plain',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        TONES[STATUS_TONE[status] ?? 'plain'],
      )}
    >
      {status.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function QueryState({
  query,
  empty,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null };
  empty?: boolean | undefined;
  children: ReactNode;
}) {
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading" className="space-y-2">
        <div className="h-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
        {query.error?.message ?? 'Something went wrong.'}
      </div>
    );
  }
  if (empty) {
    return (
      <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        Nothing here yet.
      </p>
    );
  }
  return <>{children}</>;
}

export interface Column<T> {
  header: string;
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

export function Table<T extends { id?: string }>({
  columns,
  rows,
  actions,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  actions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted text-start text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                className={cn(
                  'whitespace-nowrap px-3 py-2 font-medium',
                  column.numeric ? 'text-end' : 'text-start',
                )}
              >
                {column.header}
              </th>
            ))}
            {actions && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, index) => (
            <tr
              key={row.id ?? index}
              className={cn(onRowClick && 'cursor-pointer hover:bg-muted/60')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={cn(
                    'whitespace-nowrap px-3 py-2',
                    column.numeric && 'text-end tabular-nums',
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
              {actions && (
                <td className="px-3 py-2 text-end" onClick={(event) => event.stopPropagation()}>
                  {actions(row)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Formats a decimal string without ever converting it to a floating-point number. */
export function formatDecimal(value: string | undefined | null, scale = 2): string {
  if (value === undefined || value === null || value === '') return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const padded = fraction.padEnd(scale, '0').slice(0, scale);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${scale ? `.${padded}` : ''}`;
}

export const grams = (value?: string | null, scale = 3) =>
  value === undefined || value === null ? '—' : `${formatDecimal(value, scale)} g`;
