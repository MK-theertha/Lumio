import {
  Activity,
  BarChart3,
  BookOpen,
  Building2,
  Coins,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sun,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  permission?: string;
}
interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [{ to: '/', label: 'Dashboard', permission: 'report:read' }],
  },
  {
    label: 'Sales',
    icon: Receipt,
    items: [
      { to: '/sales', label: 'Sales invoices', permission: 'sale:read' },
      { to: '/customers', label: 'Customers', permission: 'party:read' },
    ],
  },
  {
    label: 'Purchases',
    icon: ShoppingCart,
    items: [
      { to: '/purchases', label: 'Purchase invoices', permission: 'purchase:read' },
      { to: '/suppliers', label: 'Suppliers', permission: 'party:read' },
    ],
  },
  {
    label: 'Inventory',
    icon: Package,
    items: [
      { to: '/stock', label: 'Stock on hand', permission: 'stock:read' },
      { to: '/stock/adjustments', label: 'Adjustments', permission: 'stock:read' },
      { to: '/stock/transfers', label: 'Transfers', permission: 'stock:read' },
      { to: '/stock/movements', label: 'Movements', permission: 'stock:read' },
      { to: '/products', label: 'Products', permission: 'product:read' },
    ],
  },
  {
    label: 'Gold',
    icon: Coins,
    items: [
      { to: '/gold-rates', label: 'Gold rates', permission: 'gold_rate:read' },
      { to: '/purities', label: 'Purities', permission: 'purity:read' },
    ],
  },
  {
    label: 'Payments',
    icon: Wallet,
    items: [
      { to: '/payments', label: 'Payments', permission: 'payment:read' },
      { to: '/accounts', label: 'Cash and bank', permission: 'financial_account:read' },
      { to: '/payment-methods', label: 'Methods', permission: 'payment_method:read' },
    ],
  },
  {
    label: 'Accounting',
    icon: BookOpen,
    items: [
      { to: '/journals', label: 'Journals', permission: 'journal:read' },
      { to: '/chart-of-accounts', label: 'Chart of accounts', permission: 'ledger_account:read' },
      { to: '/periods', label: 'Periods', permission: 'period:read' },
      { to: '/statements', label: 'Statements', permission: 'financials:view_cost' },
      { to: '/tax-codes', label: 'Tax codes', permission: 'tax:read' },
      { to: '/tax-rules', label: 'Tax rules', permission: 'tax:read' },
    ],
  },
  {
    label: 'Reports',
    icon: BarChart3,
    items: [{ to: '/reports', label: 'Reports', permission: 'report:read' }],
  },
  {
    label: 'Compliance',
    icon: ShieldCheck,
    items: [
      { to: '/kyc', label: 'KYC records', permission: 'kyc:read' },
      { to: '/compliance/cases', label: 'Cases', permission: 'compliance_case:read' },
      { to: '/compliance/rules', label: 'Rules', permission: 'compliance_rule:read' },
      { to: '/audit-log', label: 'Audit log', permission: 'audit:read' },
    ],
  },
  {
    label: 'Organisation',
    icon: Building2,
    items: [
      { to: '/branches', label: 'Branches', permission: 'branch:read' },
      { to: '/warehouses', label: 'Warehouses', permission: 'warehouse:read' },
      { to: '/departments', label: 'Departments', permission: 'department:read' },
      { to: '/employees', label: 'Employees', permission: 'employee:read' },
    ],
  },
  {
    label: 'Access',
    icon: Users,
    items: [
      { to: '/users', label: 'Users', permission: 'users:manage' },
      { to: '/roles', label: 'Roles', permission: 'role:read' },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    items: [
      { to: '/company', label: 'Company', permission: 'settings:manage' },
      { to: '/security', label: 'My security' },
    ],
  },
  { label: 'System', icon: Activity, items: [{ to: '/system-status', label: 'System status' }] },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <>
      <div className="flex h-14 shrink-0 items-center border-b px-4 text-lg font-semibold">
        Lumio
      </div>
      <nav aria-label="Main" className="flex-1 space-y-3 overflow-y-auto p-2">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.permission || can(i.permission));
          if (items.length === 0) return null;
          const Icon = group.icon;
          return (
            <div key={group.label}>
              <p className="flex items-center gap-2 px-3 py-1 text-xs font-medium text-muted-foreground">
                <Icon className="size-3.5" aria-hidden /> {group.label}
              </p>
              {items.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-md px-3 py-1.5 text-sm hover:bg-muted',
                      isActive && 'bg-muted font-medium',
                    )
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
    </>
  );
}

export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e bg-card md:flex print:hidden">
        <SidebarContent />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 start-0 flex w-64 flex-col bg-card">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {user?.isDemo && (
          <p
            role="status"
            className="bg-primary px-4 py-1 text-center text-xs text-primary-foreground print:hidden"
          >
            Demo company: this data is for demonstration only.
          </p>
        )}
        <header className="flex h-14 items-center justify-between gap-2 border-b bg-card px-4 print:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>
          <div className="ms-auto flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user?.name}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
