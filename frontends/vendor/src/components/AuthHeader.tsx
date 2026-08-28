import { useNavigate } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Slim marketing header for the pre-auth flow pages (claim business, forgot /
 * reset password). BabyBrain lockup on the left, the same Home / Plans /
 * Contact nav the landing and sign-in pages carry (desktop only, mirroring
 * LoginPage), and an optional slot of action buttons on the right.
 */
export function AuthHeader({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const link = 'text-sm font-medium text-gray-700 hover:text-gray-900';
  return (
    <header className="flex items-center justify-between gap-3 border-b border-gray-100 bg-white px-4 py-3 sm:px-8 md:grid md:grid-cols-[1fr_auto_1fr]">
      <button
        type="button"
        onClick={() => navigate('/')}
        aria-label="BabyBrain home"
        className="flex cursor-pointer items-center justify-self-start"
      >
        <BrandLogo className="h-9 sm:h-10" />
      </button>
      <nav className="hidden items-center gap-10 md:flex">
        <button type="button" onClick={() => navigate('/')} className={link}>Home</button>
        <button type="button" onClick={() => navigate('/plans')} className={link}>Plans</button>
        <button type="button" onClick={() => navigate('/contact')} className={link}>Contact</button>
      </nav>
      <div className="flex items-center justify-self-end gap-2 sm:gap-3">{children}</div>
    </header>
  );
}

export default AuthHeader;
