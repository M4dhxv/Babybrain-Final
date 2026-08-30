import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Slim marketing header for the pre-auth flow pages (claim business, sign in,
 * forgot / reset password, 404). BabyBrain lockup on the left, the same Home /
 * Plans / Contact nav the landing page carries, and an optional slot of action
 * buttons on the right.
 *
 * Below md those nav links have nowhere to sit, so they collapse behind a
 * toggle into the same centred dropdown the landing page uses — without it
 * these pages simply had no way to reach Home, Plans or Contact on a phone.
 */
export function AuthHeader({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const link = 'text-sm font-medium text-gray-700 hover:text-gray-900';
  const items = [
    { label: 'Home', path: '/' },
    { label: 'Plans', path: '/plans' },
    { label: 'Contact', path: '/contact' },
  ];

  const go = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  return (
    <header className="relative flex items-center justify-between gap-3 border-b border-gray-100 bg-white px-4 py-3 sm:px-8 md:grid md:grid-cols-[1fr_auto_1fr]">
      <button
        type="button"
        onClick={() => navigate('/')}
        aria-label="BabyBrain home"
        className="flex cursor-pointer items-center justify-self-start"
      >
        <BrandLogo className="h-9 sm:h-10" />
      </button>

      <nav className="hidden items-center gap-10 md:flex">
        {items.map((item) => (
          <button key={item.label} type="button" onClick={() => navigate(item.path)} className={link}>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-self-end gap-2 sm:gap-3">
        {children}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={menuOpen}
          className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 md:hidden"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {menuOpen && (
        <div className="absolute inset-x-0 top-full z-40 border-b border-gray-100 bg-white shadow-lg md:hidden">
          <nav className="flex flex-col px-4 py-1">
            {items.map((item, i) => (
              <button
                key={item.label}
                type="button"
                onClick={() => go(item.path)}
                className={[
                  'py-3 text-center text-sm',
                  i > 0 ? 'border-t border-gray-100' : '',
                  pathname === item.path ? 'font-semibold text-[#FA4D8D]' : 'font-medium text-gray-700',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}

export default AuthHeader;
