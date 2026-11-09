import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm, type FieldValues, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiList, apiSend, ApiClientError } from '@/lib/api-client';
import {
  Field,
  Input,
  Modal,
  PageHeader,
  QueryState,
  Select,
  Table,
  type Column,
} from './primitives';

export type Row = Record<string, unknown> & { id: string };

export interface FieldSpec {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'decimal'
    | 'number'
    | 'checkbox'
    | 'select'
    | 'multiselect'
    | 'ref'
    | 'list';
  options?: string[];
  ref?: { path: string; label: (row: Row) => string };
}

export function useRefOptions(path: string | undefined) {
  return useQuery({
    queryKey: ['ref', path],
    queryFn: () => apiList<Row>(path as string, { limit: 200 }),
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}

function RefSelect({ spec, register }: { spec: FieldSpec; register: object }) {
  const options = useRefOptions(spec.ref?.path);
  return (
    <Select {...register}>
      <option value="">Select…</option>
      {options.data?.rows.map((row) => (
        <option key={row.id} value={row.id}>
          {spec.ref?.label(row)}
        </option>
      ))}
    </Select>
  );
}

/** Empty optional inputs are removed so they validate as "not provided". */
function clean(values: FieldValues, fields: FieldSpec[], prefix = ''): FieldValues {
  const output: FieldValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = clean(value as FieldValues, fields, `${prefix}${key}.`);
      if (Object.keys(nested).length > 0) output[key] = nested;
      continue;
    }
    const spec = fields.find((f) => f.name === `${prefix}${key}`);
    if (spec?.type === 'list' && typeof value === 'string') {
      const items = value
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0) output[key] = items;
      continue;
    }
    output[key] = spec?.type === 'number' ? Number(value) : value;
  }
  return output;
}

/** Keeps only editable fields; server-managed ones like ids would fail strict validation. */
function editableValues(row: Row, fields: FieldSpec[]): FieldValues {
  const output: FieldValues = {};
  for (const field of fields) {
    const top = field.name.split('.')[0] as string;
    if (row[top] !== undefined) output[top] = row[top];
  }
  return output;
}

function ResourceForm({
  title,
  fields,
  schema,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: FieldSpec[];
  schema: z.ZodType;
  initial: FieldValues;
  onSubmit: (values: FieldValues) => Promise<unknown>;
  onClose: () => void;
}) {
  const form = useForm<FieldValues>({
    defaultValues: initial,
    resolver: async (values, context, options) => {
      const resolver = zodResolver(schema as never) as unknown as Resolver<FieldValues>;
      return resolver(clean(values, fields), context, options);
    },
  });
  const errors = form.formState.errors;

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await onSubmit(values);
            onClose();
          } catch (error) {
            toast.error(error instanceof ApiClientError ? error.message : 'The request failed.');
          }
        })}
      >
        {fields.map((spec) => {
          const register = form.register(spec.name);
          const message = errors[spec.name]?.message as string | undefined;
          if (spec.type === 'checkbox') {
            return (
              <label key={spec.name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register} /> {spec.label}
              </label>
            );
          }
          if (spec.type === 'multiselect') {
            return (
              <Field key={spec.name} label={spec.label} error={message}>
                <div className="flex flex-wrap gap-3">
                  {spec.options?.map((option) => (
                    <label key={option} className="flex items-center gap-1 text-sm">
                      <input type="checkbox" value={option} {...register} /> {option}
                    </label>
                  ))}
                </div>
              </Field>
            );
          }
          return (
            <Field key={spec.name} label={spec.label} error={message}>
              {spec.type === 'ref' ? (
                <RefSelect spec={spec} register={register} />
              ) : spec.type === 'select' ? (
                <Select {...register}>
                  <option value="">Select…</option>
                  {spec.options?.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={
                    spec.type === 'email' ? 'email' : spec.type === 'number' ? 'number' : 'text'
                  }
                  inputMode={spec.type === 'decimal' ? 'decimal' : undefined}
                  {...register}
                />
              )}
            </Field>
          );
        })}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export interface ResourceConfig {
  title: string;
  singular: string;
  path: string;
  permission: string;
  schema: z.ZodType;
  fields: FieldSpec[];
  columns: Column<Row>[];
  params?: Record<string, string>;
  defaults?: FieldValues;
  searchable?: boolean;
  /** Set on records that must not be archived from a list. */
  noDelete?: boolean;
  onRowClick?: (row: Row) => void;
}

const PAGE_SIZE = 25;

/** Complete list, search, create, edit and archive screen for one master record. */
export function ResourcePage(config: ResourceConfig) {
  const { title, singular, path, permission, schema, fields, columns, params, defaults } = config;
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Row | 'new' | null>(null);

  const query = useQuery({
    queryKey: [path, params, page, search],
    queryFn: () =>
      apiList<Row>(path, { ...params, page, limit: PAGE_SIZE, q: search || undefined }),
  });

  const refresh = () => queryClient.invalidateQueries();
  const save = useMutation({
    mutationFn: (values: FieldValues) => {
      const body = clean(values, fields);
      return editing === 'new'
        ? apiSend('post', path, body)
        : apiSend('patch', `${path}/${(editing as Row).id}`, body);
    },
    onSuccess: async () => {
      toast.success(`${singular} saved`);
      await refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => apiSend('delete', `${path}/${id}`),
    onSuccess: async () => {
      toast.success(`${singular} archived`);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const canUpdate = can(`${permission}:update`);
  const canDelete = can(`${permission}:delete`) && !config.noDelete;
  const total = query.data?.total ?? 0;

  return (
    <div>
      <PageHeader title={title}>
        {config.searchable !== false && (
          <Input
            aria-label={`Search ${title}`}
            placeholder="Search…"
            className="w-48"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        )}
        {can(`${permission}:create`) && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden /> New
          </Button>
        )}
      </PageHeader>

      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <Table
          columns={columns}
          rows={query.data?.rows ?? []}
          {...(config.onRowClick ? { onRowClick: config.onRowClick } : {})}
          {...(canUpdate || canDelete
            ? {
                actions: (row: Row) => (
                  <div className="flex justify-end gap-1">
                    {canUpdate && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Edit"
                        onClick={() => setEditing(row)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Archive"
                        onClick={() => {
                          if (window.confirm(`Archive this ${singular.toLowerCase()}?`))
                            archive.mutate(row.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                ),
              }
            : {})}
        />
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{total} records</span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </QueryState>

      {editing && (
        <ResourceForm
          title={`${editing === 'new' ? 'New' : 'Edit'} ${singular.toLowerCase()}`}
          fields={fields}
          schema={
            editing === 'new'
              ? schema
              : (schema as unknown as { partial: () => z.ZodType }).partial()
          }
          initial={editing === 'new' ? (defaults ?? {}) : editableValues(editing, fields)}
          onSubmit={(values) => save.mutateAsync(values)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
