import {
  branchSchema,
  complianceRuleSchema,
  departmentSchema,
  employeeSchema,
  financialAccountSchema,
  kycRecordSchema,
  ledgerAccountSchema,
  partySchema,
  paymentMethodSchema,
  productSchema,
  puritySchema,
  taxCodeSchema,
  taxRuleSchema,
  warehouseSchema,
} from '@lumio/validation';
import {
  ResourcePage,
  type FieldSpec,
  type ResourceConfig,
  type Row,
} from '@/components/app/resource-page';
import { formatDecimal, grams, StatusBadge, type Column } from '@/components/app/primitives';

const text = (header: string, key: string): Column<Row> => ({
  header,
  render: (row) => (row[key] as string) ?? '—',
});
const status = (header: string, key: string): Column<Row> => ({
  header,
  render: (row) => <StatusBadge status={String(row[key] ?? '')} />,
});
const decimal = (header: string, key: string, scale = 2): Column<Row> => ({
  header,
  numeric: true,
  render: (row) => formatDecimal(row[key] as string, scale),
});

const nameOf = (row: Row) => `${row.code ?? row.sku ?? ''} ${row.name ?? row.label ?? ''}`.trim();
const ref = (name: string, label: string, path: string): FieldSpec => ({
  name,
  label,
  type: 'ref',
  ref: { path, label: nameOf },
});

const page = (config: ResourceConfig) => () => <ResourcePage {...config} />;

const partyFields: FieldSpec[] = [
  { name: 'code', label: 'Code' },
  { name: 'name', label: 'Name' },
  { name: 'type', label: 'Type', type: 'select', options: ['INDIVIDUAL', 'BUSINESS'] },
  { name: 'roles', label: 'Roles', type: 'multiselect', options: ['CUSTOMER', 'SUPPLIER'] },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'taxRegistrationNumber', label: 'Tax registration number' },
  { name: 'dateOfBirth', label: 'Date of birth (YYYY-MM-DD)' },
  { name: 'nationality', label: 'Nationality (for example AE)' },
  { name: 'vatRegistered', label: 'VAT registered', type: 'checkbox' },
  { name: 'billingAddress', label: 'Billing address' },
  { name: 'shippingAddress', label: 'Shipping address' },
  { name: 'category', label: 'Category' },
  { name: 'creditLimit', label: 'Credit limit', type: 'decimal' },
  { name: 'notes', label: 'Notes' },
];
const partyColumns = [
  text('Code', 'code'),
  text('Name', 'name'),
  text('Type', 'type'),
  text('Phone', 'phone'),
  decimal('Credit limit', 'creditLimit'),
  status('KYC', 'kycStatus'),
  status('Risk', 'riskLevel'),
  status('Sanctions', 'sanctionsStatus'),
];
const party = (title: string, singular: string, role: string) =>
  page({
    title,
    singular,
    path: '/parties',
    permission: 'party',
    schema: partySchema,
    fields: partyFields,
    columns: partyColumns,
    params: { roles: role },
    defaults: { roles: [role], type: 'INDIVIDUAL' },
  });

export const CustomersPage = party('Customers', 'Customer', 'CUSTOMER');
export const SuppliersPage = party('Suppliers', 'Supplier', 'SUPPLIER');

export const PuritiesPage = page({
  title: 'Purities',
  singular: 'Purity',
  path: '/purities',
  permission: 'purity',
  schema: puritySchema,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'label', label: 'Label' },
    { name: 'karat', label: 'Karat', type: 'decimal' },
    { name: 'fineness', label: 'Fineness (e.g. 0.9160)', type: 'decimal' },
  ],
  columns: [
    text('Code', 'code'),
    text('Label', 'label'),
    decimal('Karat', 'karat'),
    decimal('Fineness', 'fineness', 4),
  ],
});

const makingModes = [
  'NONE',
  'PER_GRAM_NET',
  'PER_GRAM_GROSS',
  'PER_PIECE',
  'PERCENT_OF_GOLD_VALUE',
  'FIXED',
];

export const ProductsPage = page({
  title: 'Products',
  singular: 'Product',
  path: '/products',
  permission: 'product',
  schema: productSchema,
  fields: [
    { name: 'sku', label: 'SKU' },
    { name: 'barcode', label: 'Barcode' },
    { name: 'name', label: 'Name' },
    {
      name: 'kind',
      label: 'Category',
      type: 'select',
      options: [
        'RAW_GOLD',
        'BAR',
        'BULLION',
        'COIN',
        'JEWELLERY',
        'SCRAP',
        'RECYCLED',
        'OTHER_METAL',
      ],
    },
    ref('purityId', 'Purity', '/purities'),
    { name: 'tracking', label: 'Tracking', type: 'select', options: ['LOT', 'PIECE'] },
    { name: 'reorderLevelNet', label: 'Reorder level (g net)', type: 'decimal' },
    {
      name: 'defaultMaking.mode',
      label: 'Default making mode',
      type: 'select',
      options: makingModes,
    },
    { name: 'defaultMaking.value', label: 'Default making value', type: 'decimal' },
  ],
  columns: [
    text('SKU', 'sku'),
    text('Name', 'name'),
    text('Category', 'kind'),
    text('Tracking', 'tracking'),
    {
      header: 'Reorder level',
      numeric: true,
      render: (row) => grams(row.reorderLevelNet as string),
    },
  ],
});

export const BranchesPage = page({
  title: 'Branches',
  singular: 'Branch',
  path: '/branches',
  permission: 'branch',
  schema: branchSchema,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    { name: 'address', label: 'Address' },
    { name: 'phone', label: 'Phone' },
  ],
  columns: [text('Code', 'code'), text('Name', 'name'), text('Phone', 'phone')],
});

export const WarehousesPage = page({
  title: 'Warehouses',
  singular: 'Warehouse',
  path: '/warehouses',
  permission: 'warehouse',
  schema: warehouseSchema,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    ref('branchId', 'Branch', '/branches'),
  ],
  columns: [text('Code', 'code'), text('Name', 'name')],
});

export const DepartmentsPage = page({
  title: 'Departments',
  singular: 'Department',
  path: '/departments',
  permission: 'department',
  schema: departmentSchema,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
  ],
  columns: [text('Code', 'code'), text('Name', 'name')],
});

export const EmployeesPage = page({
  title: 'Employees',
  singular: 'Employee',
  path: '/employees',
  permission: 'employee',
  schema: employeeSchema,
  fields: [
    { name: 'employeeNo', label: 'Employee number' },
    { name: 'name', label: 'Name' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    ref('departmentId', 'Department', '/departments'),
    ref('branchId', 'Branch', '/branches'),
    { name: 'jobTitle', label: 'Job title' },
  ],
  columns: [
    text('Number', 'employeeNo'),
    text('Name', 'name'),
    text('Job title', 'jobTitle'),
    text('Email', 'email'),
  ],
});

export const PaymentMethodsPage = page({
  title: 'Payment methods',
  singular: 'Payment method',
  path: '/payment-methods',
  permission: 'payment_method',
  schema: paymentMethodSchema,
  searchable: false,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    {
      name: 'amlClass',
      label: 'AML class',
      type: 'select',
      options: ['CASH', 'BANK', 'CARD', 'EXCHANGE_HOUSE', 'OTHER'],
    },
  ],
  columns: [text('Code', 'code'), text('Name', 'name'), text('AML class', 'amlClass')],
});

export const FinancialAccountsPage = page({
  title: 'Cash and bank accounts',
  singular: 'Account',
  path: '/financial-accounts',
  permission: 'financial_account',
  schema: financialAccountSchema,
  searchable: false,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    { name: 'kind', label: 'Kind', type: 'select', options: ['CASH', 'BANK', 'PAYMENT'] },
    ref('ledgerAccountId', 'Ledger account', '/ledger-accounts'),
  ],
  columns: [text('Code', 'code'), text('Name', 'name'), text('Kind', 'kind')],
});

export const ChartOfAccountsPage = page({
  title: 'Chart of accounts',
  singular: 'Account',
  path: '/ledger-accounts',
  permission: 'ledger_account',
  schema: ledgerAccountSchema,
  noDelete: true,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    {
      name: 'type',
      label: 'Type',
      type: 'select',
      options: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'],
    },
    {
      name: 'cashFlowClass',
      label: 'Cash flow class',
      type: 'select',
      options: ['OPERATING', 'INVESTING', 'FINANCING'],
    },
  ],
  columns: [
    text('Code', 'code'),
    text('Name', 'name'),
    text('Type', 'type'),
    text('System role', 'systemRole'),
  ],
});

export const TaxCodesPage = page({
  title: 'Tax codes',
  singular: 'Tax code',
  path: '/tax-codes',
  permission: 'tax',
  schema: taxCodeSchema,
  searchable: false,
  fields: [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    { name: 'ratePercent', label: 'Rate %', type: 'decimal' },
    {
      name: 'treatment',
      label: 'Treatment',
      type: 'select',
      options: ['STANDARD', 'ZERO', 'EXEMPT', 'REVERSE_CHARGE', 'OUT_OF_SCOPE'],
    },
    { name: 'verified', label: 'Verified by a tax adviser', type: 'checkbox' },
    { name: 'legalReference', label: 'Legal reference' },
  ],
  columns: [
    text('Code', 'code'),
    text('Name', 'name'),
    decimal('Rate %', 'ratePercent'),
    text('Treatment', 'treatment'),
    { header: 'Verified', render: (row) => (row.verified ? 'Yes' : 'No') },
  ],
});

export const TaxRulesPage = page({
  title: 'Tax rules',
  singular: 'Tax rule',
  path: '/tax-rules',
  permission: 'tax',
  schema: taxRuleSchema,
  searchable: false,
  fields: [
    { name: 'name', label: 'Name' },
    { name: 'priority', label: 'Priority (lowest wins)', type: 'number' },
    ref('taxCodeId', 'Tax code', '/tax-codes'),
    { name: 'direction', label: 'Direction', type: 'select', options: ['ANY', 'SALE', 'PURCHASE'] },
    { name: 'minFineness', label: 'Minimum fineness', type: 'decimal' },
    { name: 'maxFineness', label: 'Maximum fineness', type: 'decimal' },
    { name: 'partyVatRegistered', label: 'Only VAT-registered parties', type: 'checkbox' },
  ],
  columns: [
    text('Name', 'name'),
    text('Direction', 'direction'),
    decimal('Minimum fineness', 'minFineness', 4),
  ],
});

export const KycPage = page({
  title: 'KYC records',
  singular: 'KYC record',
  path: '/kyc-records',
  permission: 'kyc',
  schema: kycRecordSchema,
  searchable: false,
  fields: [
    ref('partyId', 'Party', '/parties'),
    {
      name: 'documentType',
      label: 'Document',
      type: 'select',
      options: ['EMIRATES_ID', 'PASSPORT', 'TRADE_LICENCE', 'OTHER'],
    },
    { name: 'documentNumber', label: 'Document number' },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      options: ['PENDING', 'VERIFIED', 'REJECTED'],
    },
  ],
  columns: [
    text('Document', 'documentType'),
    { header: 'Number', render: (row) => `•••• ${row.documentNumberLast4 as string}` },
    status('Status', 'status'),
  ],
});

export const ComplianceRulesPage = page({
  title: 'Compliance rules',
  singular: 'Rule',
  path: '/compliance-rules',
  permission: 'compliance_rule',
  schema: complianceRuleSchema,
  searchable: false,
  fields: [
    { name: 'name', label: 'Name' },
    {
      name: 'trigger',
      label: 'Trigger',
      type: 'select',
      options: ['SALE_POSTED', 'PURCHASE_POSTED', 'PAYMENT_POSTED'],
    },
    {
      name: 'amlClasses',
      label: 'Applies to',
      type: 'multiselect',
      options: ['CASH', 'BANK', 'CARD', 'EXCHANGE_HOUSE'],
    },
    { name: 'thresholdAmount', label: 'Threshold amount', type: 'decimal' },
    { name: 'severity', label: 'Severity', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH'] },
    { name: 'active', label: 'Active', type: 'checkbox' },
    { name: 'legalReference', label: 'Legal reference' },
  ],
  columns: [
    text('Name', 'name'),
    text('Trigger', 'trigger'),
    decimal('Threshold', 'thresholdAmount'),
    status('Severity', 'severity'),
  ],
});
