import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';

/**
 * Small building blocks for the vendor portal's long forms (Edit activity,
 * Terms). One look for switches, section cards and issue lists, so a form with
 * many options stays scannable: bold titles, a colour per section, and every
 * on/off control right-aligned in the same column.
 */

/** The one on/off switch used across the vendor site (components/ui/switch). */
export function Toggle({
  checked, onChange, disabled, label,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />;
}

/** A setting row: title and explanation on the left, the switch on the right.
 *  The switch sits in its own column at the top of the row, so every switch in
 *  a form lines up whatever the text beside it does. */
export function ToggleRow({
  title, hint, checked, onChange, disabled, disabledReason,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4', disabled && 'opacity-70')}>
      <div>
        <div className="text-[15px] font-bold text-gray-900">{title}</div>
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-gray-500">{hint}</p>}
        {disabled && disabledReason && <p className="mt-1 text-[13px] font-semibold text-amber-800">{disabledReason}</p>}
      </div>
      <div className="pt-px">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
      </div>
    </div>
  );
}

export type Tone = 'pink' | 'blue' | 'purple' | 'amber' | 'teal';

/** Palette per section: a soft chip for icons/nav, a strong tint for text. */
export const TONES: Record<Tone, { chip: string; text: string; soft: string; ring: string }> = {
  pink: { chip: 'bg-[#FEEBF2] text-[#FA4D8D]', text: 'text-[#C90044]', soft: 'bg-[#FFF5F8]', ring: 'ring-[#FA4D8D]' },
  blue: { chip: 'bg-sky-100 text-sky-700', text: 'text-sky-800', soft: 'bg-sky-50', ring: 'ring-sky-500' },
  purple: { chip: 'bg-purple-100 text-purple-700', text: 'text-purple-800', soft: 'bg-purple-50', ring: 'ring-purple-500' },
  amber: { chip: 'bg-amber-100 text-amber-800', text: 'text-amber-900', soft: 'bg-amber-50', ring: 'ring-amber-500' },
  teal: { chip: 'bg-teal-100 text-teal-800', text: 'text-teal-900', soft: 'bg-teal-50', ring: 'ring-teal-500' },
};

export type FormIssue = { section: string; level: 'error' | 'warn'; text: string };

/** A form section: coloured icon, bold title, one line of help, then its fields.
 *  Issues for the section are listed at the top of it, errors before warnings. */
export function SectionCard({
  id, icon: Icon, tone, title, subtitle, issues = [], children,
}: {
  id: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  subtitle: string;
  issues?: FormIssue[];
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <section id={`form-sec-${id}`} className="scroll-mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <header className={cn('flex items-center gap-3 border-b border-gray-100 px-5 py-4', t.soft)}>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', t.chip)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h4 className="text-lg font-bold leading-6 text-gray-900">{title}</h4>
          <p className="text-[13px] leading-snug text-gray-600">{subtitle}</p>
        </div>
      </header>
      <div className="space-y-5 p-5">
        {issues.length > 0 && (
          <ul className="space-y-1.5">
            {[...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)).map((i) => (
              <li
                key={i.text}
                className={cn(
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold',
                  i.level === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900',
                )}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {i.text}
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </section>
  );
}

/** The status mark beside a section in the navigator. */
export function SectionStatus({ issues }: { issues: FormIssue[] }) {
  const errors = issues.filter((i) => i.level === 'error').length;
  if (errors > 0) {
    return <span className="grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white" title={`${errors} to fix`}>{errors}</span>;
  }
  if (issues.length > 0) {
    return <span className="grid h-5 min-w-5 place-items-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-amber-950" title={`${issues.length} suggestion${issues.length === 1 ? '' : 's'}`}>{issues.length}</span>;
  }
  return <CheckCircle2 className="h-5 w-5 text-green-600" aria-label="Complete" />;
}
