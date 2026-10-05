import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FieldHandling {
  name: string;
  label: string;
  mandatory: boolean;
  handling: 'filled' | 'asked' | 'guests';
  note: string;
  options?: string[];
  multi?: boolean;
}

/**
 * Shows a vendor, field by field, how their Wix registration form is answered when a parent books:
 * which fields BabyBrain fills in itself and which are asked on the booking page. It is read live
 * from Wix, so a question the vendor just added shows up here, and a field whose wording sends it
 * the wrong way (a "Child name" filled in as the parent's, say) is easy to spot and fix in Wix.
 */
export function WixFormHandling({ providerId, activityId }: { providerId: string; activityId: string }) {
  const [fields, setFields] = useState<FieldHandling[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFields(null);
    setFailed(false);
    apiGet<{ fields: FieldHandling[] }>(
      `/api/vendor/wix-event-form?providerId=${encodeURIComponent(providerId)}&activityId=${encodeURIComponent(activityId)}`
    )
      .then((r) => {
        if (!cancelled) setFields(r.fields);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, activityId]);

  if (failed) {
    return <p className="text-xs text-gray-500">Couldn't read your Wix registration form just now, so its fields aren't listed here.</p>;
  }
  if (!fields) return <p className="text-xs text-gray-500">Reading your Wix registration form…</p>;
  if (!fields.length) return null;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
        <p className="text-xs font-semibold text-gray-800">How your Wix registration form is filled in</p>
        <p className="text-xs text-gray-500">
          Read from Wix just now. If a field is handled differently than you expect, reword it in Wix and sync.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {fields.map((f) => (
          <li key={f.name} className="px-3 py-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900">
                {f.label}
                {f.mandatory && <span className="text-red-600"> *</span>}
              </p>
              <p className="text-xs text-gray-500">{f.note}</p>
              {f.options && f.options.length > 0 && <p className="text-xs text-gray-400">Options: {f.options.join(', ')}</p>}
            </div>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                f.handling === 'asked' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
              )}
            >
              {f.handling === 'asked' ? 'Asked on booking page' : f.handling === 'guests' ? 'From guests booked' : 'Filled in for them'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
