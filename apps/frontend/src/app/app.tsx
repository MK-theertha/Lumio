import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import { ThemeProvider } from '@/contexts/theme-context';
import * as accounting from '@/features/accounting/accounting-pages';
import { BankReconciliationPage } from '@/features/accounting/bank-reconciliation-page';
import { ForgotPasswordPage, LoginPage, SetPasswordPage } from '@/features/auth/auth-pages';
import { GoamlReportsPage, SanctionsPage } from '@/features/compliance/compliance-pages';
import { MetalAccountsPage, RateBoardPage } from '@/features/metal/metal-pages';
import { VatReturnPage } from '@/features/accounting/vat-return-page';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { DocumentsPage } from '@/features/documents/documents';
import * as inventory from '@/features/inventory/inventory-pages';
import * as operations from '@/features/inventory/operations-pages';
import { CashBookPage, PartyStatementPage } from '@/features/accounting/ledgers-pages';
import * as master from '@/features/master/master-pages';
import { IntegrityPage, NotificationsPage } from '@/features/notifications/notifications';
import { PlatformCompaniesPage } from '@/features/platform/platform-companies-page';
import * as settings from '@/features/settings/settings-pages';
import { SystemStatusPage } from '@/features/system/system-status-page';
import { EInvoicesPage } from '@/features/trade/e-invoices-page';
import { TradeDetailPage, TradeEditorPage, TradeListPage } from '@/features/trade/trade-pages';
import { AppShell } from '@/layouts/app-shell';
import { ErrorBoundary } from './error-boundary';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function Guard({ permission, children }: { permission: string; children: ReactNode }) {
  const { can, user } = useAuth();
  if (user?.isPlatformAdmin && !user.companyId)
    return <Navigate to="/platform/companies" replace />;
  return can(permission) ? (
    children
  ) : (
    <p className="text-sm">You do not have access to this page.</p>
  );
}

const guarded: [string, string, ReactNode][] = [
  ['/', 'report:read', <DashboardPage key="d" />],
  ['/customers', 'party:read', <master.CustomersPage key="c" />],
  ['/suppliers', 'party:read', <master.SuppliersPage key="s" />],
  ['/products', 'product:read', <master.ProductsPage key="p" />],
  ['/purities', 'purity:read', <master.PuritiesPage key="pu" />],
  ['/gold-rates', 'gold_rate:read', <inventory.GoldRatesPage key="g" />],
  ['/gold-rates/board', 'gold_rate:read', <RateBoardPage key="gb" />],
  ['/metal-accounts', 'metal:read', <MetalAccountsPage key="ma" />],
  ['/vat-return', 'tax:read', <VatReturnPage key="vr" />],
  ['/party-pricing', 'party:read', <master.PartyPricingPage key="pp" />],
  ['/posting-profiles', 'ledger_account:read', <master.PostingProfilesPage key="ppf" />],
  ['/stock', 'stock:read', <inventory.StockPage key="st" />],
  ['/stock/adjustments', 'stock:read', <inventory.AdjustmentsPage key="a" />],
  ['/stock/transfers', 'stock:read', <inventory.TransfersPage key="t" />],
  ['/stock/movements', 'stock:read', <inventory.MovementsPage key="m" />],
  ['/stock/reservations', 'stock:read', <operations.ReservationsPage key="rs" />],
  ['/stock/counts', 'stock:read', <operations.CountsPage key="sc" />],
  ['/stock/labels', 'stock:read', <operations.LabelsPage key="lb" />],
  ['/purchase-orders', 'purchase:read', <operations.PurchaseOrdersPage key="po" />],
  ['/goods-receipts', 'purchase:read', <operations.GoodsReceiptsPage key="gr" />],
  ['/cash-book', 'payment:read', <CashBookPage key="cb" />],
  ['/party-statements', 'report:read', <PartyStatementPage key="ps" />],
  ['/sales', 'sale:read', <TradeListPage key="sl" mode="sale" />],
  ['/sales/new', 'sale:create', <TradeEditorPage key="sn" mode="sale" />],
  ['/sales/:id', 'sale:read', <TradeDetailPage key="sd" mode="sale" />],
  ['/purchases', 'purchase:read', <TradeListPage key="pl" mode="purchase" />],
  ['/purchases/new', 'purchase:create', <TradeEditorPage key="pn" mode="purchase" />],
  ['/purchases/:id', 'purchase:read', <TradeDetailPage key="pd" mode="purchase" />],
  ['/payments', 'payment:read', <accounting.PaymentsPage key="pay" />],
  ['/accounts', 'financial_account:read', <master.FinancialAccountsPage key="fa" />],
  ['/payment-methods', 'payment_method:read', <master.PaymentMethodsPage key="pm" />],
  ['/bank-reconciliation', 'bank_reconciliation:read', <BankReconciliationPage key="br" />],
  ['/e-invoices', 'einvoice:read', <EInvoicesPage key="ei" />],
  ['/journals', 'journal:read', <accounting.JournalsPage key="j" />],
  ['/chart-of-accounts', 'ledger_account:read', <master.ChartOfAccountsPage key="coa" />],
  ['/periods', 'period:read', <accounting.PeriodsPage key="per" />],
  ['/statements', 'financials:view_cost', <accounting.StatementsPage key="fs" />],
  ['/reports', 'report:read', <accounting.ReportsPage key="r" />],
  ['/tax-codes', 'tax:read', <master.TaxCodesPage key="tc" />],
  ['/tax-rules', 'tax:read', <master.TaxRulesPage key="tr" />],
  ['/kyc', 'kyc:read', <master.KycPage key="k" />],
  ['/compliance/cases', 'compliance_case:read', <settings.ComplianceCasesPage key="cc" />],
  ['/compliance/rules', 'compliance_rule:read', <master.ComplianceRulesPage key="cr" />],
  ['/compliance/sanctions', 'sanctions:review', <SanctionsPage key="sa" />],
  ['/compliance/goaml', 'goaml:view', <GoamlReportsPage key="ga" />],
  ['/documents', 'document:read', <DocumentsPage key="do" />],
  ['/integrity', 'audit:read', <IntegrityPage key="in" />],
  ['/branches', 'branch:read', <master.BranchesPage key="b" />],
  ['/warehouses', 'warehouse:read', <master.WarehousesPage key="w" />],
  ['/departments', 'department:read', <master.DepartmentsPage key="dp" />],
  ['/employees', 'employee:read', <master.EmployeesPage key="e" />],
  ['/users', 'users:manage', <settings.UsersPage key="u" />],
  ['/roles', 'role:read', <settings.RolesPage key="ro" />],
  ['/company', 'settings:manage', <settings.CompanySettingsPage key="co" />],
  ['/audit-log', 'audit:read', <settings.AuditLogPage key="al" />],
];

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<SetPasswordPage />} />
                <Route path="/accept-invite" element={<SetPasswordPage />} />
                <Route element={<RequireAuth />}>
                  <Route element={<AppShell />}>
                    {guarded.map(([path, permission, element]) => (
                      <Route
                        key={path}
                        path={path}
                        element={<Guard permission={permission}>{element}</Guard>}
                      />
                    ))}
                    <Route path="/platform/companies" element={<PlatformCompaniesPage />} />
                    <Route path="/notifications" element={<NotificationsPage />} />
                    <Route path="/security" element={<settings.SecurityPage />} />
                    <Route path="/system-status" element={<SystemStatusPage />} />
                    <Route path="*" element={<p className="text-sm">Page not found.</p>} />
                  </Route>
                </Route>
              </Routes>
            </BrowserRouter>
          </AuthProvider>
          <Toaster richColors />
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
