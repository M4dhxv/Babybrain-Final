import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* Boutique-look empty state: a pastel icon tile, one line saying what this
   space is, an optional detail, and at most one action. Replaces bare grey
   "No X yet." text so an empty page still looks looked-after. */

const TONES = {
  pink: 'bg-pink-100 text-pink-600',
  purple: 'bg-purple-100 text-purple-600',
  blue: 'bg-blue-100 text-blue-600',
  green: 'bg-green-100 text-green-600',
  yellow: 'bg-yellow-100 text-yellow-600',
} as const;

export function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
  tone = 'purple',
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail?: ReactNode;
  action?: { label: string; onClick: () => void };
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-4 py-6 text-center', className)}>
      <div className={cn('grid h-11 w-11 place-items-center rounded-2xl', TONES[tone])}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="mt-3 text-sm font-bold text-gray-900">{title}</div>
      {detail && <div className="mt-1 max-w-xs text-xs text-gray-500">{detail}</div>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 rounded-full bg-[#FA4D8D] px-4 py-2 text-xs font-bold text-white hover:opacity-90"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
