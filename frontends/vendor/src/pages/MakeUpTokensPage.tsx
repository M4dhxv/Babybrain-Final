import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

type Token = {
  token_id: string;
  child_name: string;
  parent_name: string;
  origin_activity_title: string | null;
  origin_session_at: string | null;
  status: 'issued' | 'redeemed' | 'expired';
  created_at: string;
  expires_at: string | null;
};

const statusFilters = ['All', 'Issued', 'Redeemed', 'Expired'] as const;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });

const statusBadge = (s: string) => cn(
  'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full capitalize',
  s === 'issued' ? 'bg-blue-300 text-blue-800' : s === 'redeemed' ? 'bg-green-300 text-green-800' : 'bg-gray-100 text-gray-500'
);

export default function MakeUpTokensPage() {
  const { provider } = useAuth();
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<typeof statusFilters[number]>('All');

  useEffect(() => {
    if (!provider) return;
    (async () => {
      setLoading(true);
      const { data } = await supabase.rpc('provider_make_up_tokens', { p_provider: provider.id });
      setTokens((data ?? []) as Token[]);
      setLoading(false);
    })();
  }, [provider]);

  // A token past its expiry that's still marked "issued" reads as active but
  // isn't — flag it here rather than waiting on a cron job to flip the status.
  const isExpired = (t: Token) => t.status === 'issued' && !!t.expires_at && new Date(t.expires_at) < new Date();
  const effectiveStatus = (t: Token) => (isExpired(t) ? 'expired' : t.status);

  const visible = useMemo(
    () => (filter === 'All' ? tokens : tokens.filter((t) => effectiveStatus(t) === filter.toLowerCase())),
    [tokens, filter]
  );

  const counts = useMemo(() => {
    const c = { issued: 0, redeemed: 0, expired: 0 };
    tokens.forEach((t) => { c[effectiveStatus(t) as keyof typeof c]++; });
    return c;
  }, [tokens]);

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Make-up Tokens</h1>
          <p className="text-sm text-gray-500 mt-1">Every make-up token you've issued, and where it stands.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="mb-6 grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{counts.issued}</div>
            <div className="text-sm text-gray-500">Outstanding</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{counts.redeemed}</div>
            <div className="text-sm text-gray-500">Redeemed</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{counts.expired}</div>
            <div className="text-sm text-gray-500">Expired</div>
          </div>
        </div>

        <p className="mb-4 text-xs text-gray-500">
          Issue a new token from <button onClick={() => navigate('/bookings')} className="font-medium text-[#C90044] hover:underline">Bookings</button> — select a child's booking → "Issue make-up token".
        </p>

        <div className="mb-4 inline-flex rounded-xl border border-gray-200 bg-white p-1">
          {statusFilters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 h-8 text-sm font-medium rounded-lg transition-colors',
                filter === f ? 'bg-pink-50 text-[#C90044]' : 'text-gray-600 hover:bg-gray-100'
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-gray-400">Loading…</div>}

        {!loading && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[1.2fr_1.2fr_0.8fr_0.8fr_0.8fr] px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500">
              <div>Family</div><div>Original class</div><div>Status</div><div>Issued</div><div>Expires</div>
            </div>
            {visible.map((t) => (
              <div key={t.token_id} className="grid grid-cols-[1.2fr_1.2fr_0.8fr_0.8fr_0.8fr] px-5 py-3 border-t border-gray-100 items-center">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                    <Gift className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                    {t.child_name}
                  </div>
                  <div className="text-xs text-gray-500 truncate">{t.parent_name}</div>
                </div>
                <div className="text-sm text-gray-700">
                  {t.origin_activity_title ?? <span className="text-gray-400">—</span>}
                  {t.origin_session_at && <div className="text-xs text-gray-500">{fmtDate(t.origin_session_at)}</div>}
                </div>
                <div><span className={statusBadge(effectiveStatus(t))}>{effectiveStatus(t)}</span></div>
                <div className="text-xs text-gray-500">{fmtDate(t.created_at)}</div>
                <div className="text-xs text-gray-500">{t.expires_at ? fmtDate(t.expires_at) : '—'}</div>
              </div>
            ))}
            {visible.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-gray-400">
                {filter === 'All' ? 'No make-up tokens issued yet.' : `No ${filter.toLowerCase()} tokens.`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
