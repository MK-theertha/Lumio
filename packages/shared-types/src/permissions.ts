const crud = (resource: string) =>
  [`${resource}:create`, `${resource}:read`, `${resource}:update`, `${resource}:delete`] as const;

const workflow = (resource: string) =>
  [
    ...crud(resource),
    `${resource}:approve`,
    `${resource}:reject`,
    `${resource}:post`,
    `${resource}:reverse`,
    `${resource}:export`,
  ] as const;

/** Every permission key in the system. The API enforces these; the UI only mirrors them. */
export const PERMISSIONS = [
  ...crud('branch'),
  ...crud('warehouse'),
  ...crud('department'),
  ...crud('employee'),
  ...crud('role'),
  ...crud('party'),
  ...crud('product'),
  ...crud('purity'),
  ...crud('financial_account'),
  ...crud('payment_method'),
  ...crud('ledger_account'),
  ...crud('tax'),
  ...crud('kyc'),
  ...crud('compliance_rule'),
  ...workflow('gold_rate'),
  ...workflow('stock'),
  ...workflow('sale'),
  ...workflow('purchase'),
  ...workflow('payment'),
  ...workflow('journal'),
  'period:read',
  'period:create',
  'period:close',
  'period:reopen',
  'compliance_case:read',
  'compliance_case:update',
  'report:read',
  'report:export',
  'audit:read',
  'financials:view_cost',
  'users:manage',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const reads = PERMISSIONS.filter((p) => p.endsWith(':read'));
const allOf = (...resources: string[]) =>
  PERMISSIONS.filter((p) => resources.includes(p.split(':')[0] as string));
const without = (list: readonly Permission[], ...blocked: string[]) =>
  list.filter((p) => !blocked.some((b) => p.endsWith(`:${b}`)));

/** Starting permission bundles. Companies can edit these or define their own roles. */
export const SYSTEM_ROLES: Record<string, readonly Permission[]> = {
  'Company Administrator': PERMISSIONS,
  'Branch Manager': [
    ...reads,
    ...without(allOf('sale', 'purchase', 'stock', 'payment', 'gold_rate'), 'delete'),
    'financials:view_cost',
    'report:export',
  ],
  Accountant: [
    ...reads,
    ...allOf('journal', 'period', 'payment', 'ledger_account', 'tax', 'financial_account'),
    'financials:view_cost',
    'report:export',
  ],
  'Sales Manager': [
    ...reads,
    ...without(allOf('sale'), 'delete'),
    ...allOf('party'),
    'report:export',
    'payment:create',
    'payment:post',
  ],
  'Sales Executive': [
    'party:read',
    'party:create',
    'party:update',
    'product:read',
    'purity:read',
    'gold_rate:read',
    'stock:read',
    'sale:read',
    'sale:create',
    'sale:update',
    'tax:read',
    'financial_account:read',
    'payment_method:read',
    'warehouse:read',
    'branch:read',
  ],
  'Purchase Manager': [
    ...reads,
    ...without(allOf('purchase'), 'delete'),
    ...allOf('party'),
    'report:export',
    'financials:view_cost',
  ],
  'Inventory Manager': [
    ...reads,
    ...without(allOf('stock'), 'delete'),
    ...allOf('product'),
    'financials:view_cost',
    'report:export',
  ],
  Storekeeper: [
    'product:read',
    'purity:read',
    'stock:read',
    'stock:create',
    'stock:update',
    'warehouse:read',
    'branch:read',
  ],
  Auditor: [...reads, 'audit:read', 'financials:view_cost', 'report:export'],
};
