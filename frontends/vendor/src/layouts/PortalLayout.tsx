import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import SiteFooter from '@/components/SiteFooter';
import { useState } from 'react';
import {
  LayoutDashboard,
  CalendarDays,
  CalendarRange,
  CalendarCheck,
  Package,
  Gift,
  MessageSquare,
  Bell,
  Settings,
  CreditCard,
  Crown,
  ChevronRight,
  HelpCircle,
  Menu,
  X,
  Star,
  TrendingUp,
  Lock,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthProvider';
import { planMeta } from '@/lib/plans';
import { BrandIcon, BrandLogo } from '@/components/BrandLogo';

const sidebarItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
  { icon: CalendarDays, label: 'Activities', path: '/activities' },
  { icon: CalendarRange, label: 'Schedule', path: '/schedule' },
  { icon: CalendarCheck, label: 'Bookings', path: '/bookings' },
  { icon: Package, label: 'Packages', path: '/packages' },
  { icon: Gift, label: 'Make-up Tokens', path: '/make-up-tokens' },
  { icon: MessageSquare, label: 'Messages', path: '/messages' },
  { icon: Bell, label: 'Notifications', path: '/notifications' },
  { icon: Star, label: 'Reviews', path: '/reviews' },
  // Headline Pro feature, so it gets its own tab and shows a lock below Pro.
  { icon: TrendingUp, label: 'Insights', path: '/insights', proOnly: true },
  { icon: Settings, label: 'Settings', path: '/settings' },
  { icon: Wallet, label: 'Earnings', path: '/earnings' },
  { icon: CreditCard, label: 'Billing', path: '/billing' },
];

export default function PortalLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { subscription } = useAuth();
  const isPro = subscription?.plan === 'pro' || subscription?.plan === 'premium';
  const [isSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const plan = planMeta(subscription?.plan);
  const renewLabel = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  // Close the mobile drawer whenever the route changes.
  const go = (path: string) => {
    setMobileOpen(false);
    navigate(path);
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-gray-200 bg-white px-4 md:hidden">
        <BrandLogo className="h-8" />
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="grid h-10 w-10 place-items-center rounded-lg border border-gray-200 text-gray-700"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Backdrop for the mobile drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col bg-white border-r border-gray-200 h-full transition-transform duration-300',
          'fixed inset-y-0 left-0 z-50 md:static md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          isSidebarCollapsed ? 'w-20' : 'w-64'
        )}
      >
        {/* Mobile close button */}
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
        {/* Logo */}
        <div className="px-5 py-4">
          {isSidebarCollapsed ? (
            <BrandIcon className="h-8 w-8" />
          ) : (
            <>
              <BrandLogo className="h-9" />
              <div className="mt-1 text-xs text-gray-500">Vendor Portal</div>
            </>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {sidebarItems.map((item) => {
            const isActive = location.pathname === item.path;
            // Pro-only tabs stay visible but greyed, so the feature is
            // discoverable rather than hidden. The page itself explains the
            // upgrade, so the tab is still clickable.
            const locked = item.proOnly && !isPro;
            return (
              <button
                key={item.label}
                onClick={() => go(item.path)}
                title={locked ? 'Insights is a Pro feature' : undefined}
                className={cn(
                  'flex items-center w-full gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative',
                  isActive
                    ? 'bg-pink-50 text-pink-600'
                    : locked
                      ? 'text-gray-400 hover:bg-gray-50'
                      : 'text-gray-700 hover:bg-gray-100'
                )}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {!isSidebarCollapsed && (
                  <span className="flex-1 text-left">{item.label}</span>
                )}
                {locked && !isSidebarCollapsed && <Lock className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            );
          })}
        </nav>

        {/* Current Plan Card */}
        {!isSidebarCollapsed && (
          <div className="mx-3 mb-4 p-4 bg-gradient-to-br from-pink-50 to-purple-50 rounded-xl border border-pink-100">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-gradient-to-br from-pink-400 to-purple-500 rounded-lg flex items-center justify-center">
                <Crown className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="text-xs text-gray-500 mb-0.5">Current Plan</div>
            <div className="text-sm font-bold text-gray-900 mb-1">{plan.short}</div>
            <div className="text-xs text-gray-500 mb-3">
              {plan.isPaid && subscription?.current_period_end
                ? <>{subscription.cancel_at_period_end ? 'Access until' : 'Renews on'}<br />{renewLabel}</>
                : plan.price}
            </div>
            {/* QA 24/08: "When click 'Upgrade Plan' under current plan bottom
                left it just jumps up to current plan." It always went to
                /billing, which opens on the Current Plan card — so an
                "Upgrade" button showed you the plan you were already on, and
                reaching the tiers took a second click. An upgrade now goes
                straight to /plans; managing an existing paid plan still goes
                to /billing, which is where the card and invoices live. */}
            <button
              onClick={() => go(plan.isPaid ? '/billing' : '/plans')}
              className="flex items-center justify-center w-full gap-1 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {plan.isPaid ? (location.pathname === '/billing' ? 'Manage Subscription' : 'Manage Plan') : 'Upgrade Plan'}
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Help */}
        <div className="px-5 py-4 border-t border-gray-100">
          {/* Both of these were inert. They go to Contact, which is the help
              page this portal actually has. */}
          <button onClick={() => navigate('/contact')} className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
            <HelpCircle className="w-4 h-4" />
            {!isSidebarCollapsed && <span>Need help?</span>}
          </button>
          {!isSidebarCollapsed && (
            <div className="mt-1 text-xs text-gray-500">
              Visit our{' '}
              <button onClick={() => navigate('/contact')} className="text-pink-600 hover:underline">
                Help Center
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pt-14 md:pt-0">
        <Outlet />
        <SiteFooter />
      </main>
    </div>
  );
}
