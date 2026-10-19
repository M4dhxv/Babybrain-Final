import type { ReactNode } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A sign-in / reset problem shown right under the field it's about, with the
 * fix as a button, instead of a banner at the top of the card. `warn` is for a
 * mix-up (a business contact email typed as the login), `error` for a miss.
 */
export function AuthFieldMessage({
  id,
  tone = 'error',
  children,
  actions,
}: {
  id: string;
  tone?: 'error' | 'warn';
  children: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = tone === 'warn' ? Info : AlertCircle;
  return (
    <div
      id={id}
      role="alert"
      className={cn(
        'mt-2 rounded-lg px-3 py-2 text-sm',
        tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-700'
      )}
    >
      <div className="flex gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 break-words">{children}</div>
      </div>
      {actions && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-6">{actions}</div>}
    </div>
  );
}

/** A text-button action inside an AuthFieldMessage. */
export function AuthFieldAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-sm font-semibold underline underline-offset-2">
      {children}
    </button>
  );
}

/** Shown after repeated failures, so a stuck vendor always has a way out. */
export function AuthHelpLine() {
  return (
    <p className="mt-4 text-center text-xs text-gray-500">
      Still stuck? Email{' '}
      <a href="mailto:hello@babybrain.sg" className="font-semibold text-[#A7D8F8]">
        hello@babybrain.sg
      </a>{' '}
      and we'll sort it out.
    </p>
  );
}
