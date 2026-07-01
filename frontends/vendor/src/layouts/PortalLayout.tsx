import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  LayoutDashboard,
  CalendarDays,
  CalendarCheck,
  MessageSquare,
  Settings,
  CreditCard,
  Crown,
  ChevronRight,
  HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const sidebarItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
  { icon: CalendarDays, label: 'Activities', path: '/activities' },
  { icon: CalendarCheck, label: 'Bookings', path: '/bookings' },
  { icon: MessageSquare, label: 'Messages', path: '/messages' },
  { icon: Settings, label: 'Settings', path: '/settings' },
  { icon: CreditCard, label: 'Billing', path: '/billing' },
];

export default function PortalLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col bg-white border-r border-gray-200 h-full transition-all duration-300',
          isSidebarCollapsed ? 'w-20' : 'w-64'
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 py-4">
          <img
            src="/assets/logo-icon.png"
            alt="BabyBrain"
            className="w-8 h-8 rounded-full"
          />
          {!isSidebarCollapsed && (
            <div>
              <div className="text-lg font-bold text-[#E91E63]">BabyBrain</div>
              <div className="text-xs text-gray-500">Vendor Portal</div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {sidebarItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <button
                key={item.label}
                onClick={() => navigate(item.path)}
                className={cn(
                  'flex items-center w-full gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative',
                  isActive
                    ? 'bg-pink-50 text-pink-600'
                    : 'text-gray-700 hover:bg-gray-100'
                )}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {!isSidebarCollapsed && (
                  <span className="flex-1 text-left">{item.label}</span>
                )}
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
            <div className="text-sm font-bold text-gray-900 mb-1">Growth Plan</div>
            <div className="text-xs text-gray-500 mb-3">Renews on<br />12 Jul 2026</div>
            <button
              onClick={() => navigate('/billing')}
              className="flex items-center justify-center w-full gap-1 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {location.pathname === '/billing' ? 'Manage Subscription' : 'Manage Plan'}
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Help */}
        <div className="px-5 py-4 border-t border-gray-100">
          <button className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
            <HelpCircle className="w-4 h-4" />
            {!isSidebarCollapsed && <span>Need help?</span>}
          </button>
          {!isSidebarCollapsed && (
            <div className="mt-1 text-xs text-gray-500">
              Visit our <span className="text-pink-600 cursor-pointer">Help Center</span>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
