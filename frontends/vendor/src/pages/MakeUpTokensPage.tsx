import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { RainbowLoader } from '@/components/ui/rainbow-loader';

/**
 * The make-up tokens table's column tracks. Header and body rows are separate grids, so the
 * track list is shared to keep them in step, and every track is
 * `minmax(0, …)` rather than a bare `Nfr` — a bare fr floors at min-content,
 * so one long class title or family name widened that row's track and left the row
 * misaligned against the header. `gap-x-4` keeps neighbouring values from
 * sitting flush. Same fix as the activities table.
 */
const TOKEN_COLS =
  'grid min-w-[790px] gap-x-4 grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]';

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

/** `expires_at` as a Singapore-local YYYY-MM-DD, for seeding the <input type="date">. */
const toDateInput = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

const statusBadge = (s: string) => cn(
  'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full capitalize',
  s === 'issued' ? 'bg-blue-300 text-blue-800' : s === 'redeemed' ? 'bg-green-300 text-green-800' : 'bg-gray-100 text-gray-500'
);

export default function MakeUpTokensPage() {
  const { provider, role } = useAuth();
  const navigate = useNavigate();
  const canManage = role === 'owner' || role === 'manager';
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<typeof statusFilters[number]>('All');

  // Inline expiry editor — one token open at a time. Issuance already lets you
  // set a bespoke expiry (BookingsPage); this is the same control for a token
  // that's already out, so a date can be pushed back or pulled in after the fact.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expiryMode, setExpiryMode] = useState<string>('none');
  const [expiryDate, setExpiryDate] = useState<string>('');
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [expiryError, setExpiryError] = useState<string | null>(null);

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

  function startEdit(t: Token) {
    setEditingId(t.token_id);
    setExpiryError(null);
    if (t.expires_at) {
      setExpiryMode('custom');
      setExpiryDate(toDateInput(t.expires_at));
    } else {
      setExpiryMode('none');
      setExpiryDate('');
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setExpiryError(null);
  }

  /** The chosen expiry as an ISO instant, or null for a token that never expires. */
  function resolveExpiresAt(): string | null | 'invalid' {
    if (expiryMode === 'none') return null;
    if (expiryMode === 'custom') {
      if (!expiryDate) return 'invalid';
      // End of the chosen day in Singapore time, so a token dated "today" is
      // still usable for the rest of today.
      const d = new Date(`${expiryDate}T23:59:59+08:00`);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return 'invalid';
      return d.toISOString();
    }
    return new Date(Date.now() + Number(expiryMode) * 864e5).toISOString();
  }

  async function saveExpiry(t: Token) {
    setExpiryError(null);
    const expiresAt = resolveExpiresAt();
    if (expiresAt === 'invalid') {
      setExpiryError('Pick an expiry date in the future.');
      return;
    }
    setSavingExpiry(true);
    // A future (or absent) expiry means the token is live again — clear a
    // stale 'expired' status the cron job may have already stamped on.
    const status = t.status === 'expired' ? 'issued' : t.status;
    const { error } = await supabase
      .from('make_up_tokens')
      .update({ expires_at: expiresAt, status })
      .eq('id', t.token_id);
    setSavingExpiry(false);
    if (error) {
      setExpiryError(error.message);
      return;
    }
    setTokens((prev) =>
      prev.map((x) => (x.token_id === t.token_id ? { ...x, expires_at: expiresAt, status } : x))
    );
    setEditingId(null);
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Make-up tokens</h1>
          <p className="text-sm text-gray-500 mt-1">Every make-up token you've issued, and where it stands.</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        <div className="mb-6 grid grid-cols-3 gap-3 sm:gap-4">
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
          Issue a new token from <button onClick={() => navigate('/bookings')} className="font-medium text-[#FA4D8D] hover:underline">Bookings</button> — select a child's booking → "Issue make-up token".
        </p>

        <div className="mb-4 flex w-full rounded-xl border border-gray-200 bg-white p-1 sm:inline-flex sm:w-auto">
          {statusFilters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'h-8 flex-1 px-3 text-sm font-medium rounded-lg transition-colors sm:flex-none',
                filter === f ? 'bg-pink-50 text-[#FA4D8D]' : 'text-gray-600 hover:bg-gray-100'
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {loading && <RainbowLoader className="py-6" label="Loading make-up tokens" />}

        {!loading && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <div className={cn(TOKEN_COLS, 'px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500')}>
              <div>Family</div><div>Original class</div><div>Status</div><div>Issued</div><div>Expires</div>
            </div>
            {visible.map((t) => {
              const editable = canManage && t.status !== 'redeemed';
              return (
                <div key={t.token_id}>
                  <div className={cn(TOKEN_COLS, 'px-5 py-3 border-t border-gray-100 items-center')}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                        <Gift className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                        {t.child_name}
                      </div>
                      <div className="text-xs text-gray-500 truncate">{t.parent_name}</div>
                    </div>
                    <div className="min-w-0 text-sm text-gray-700 break-words">
                      {t.origin_activity_title ?? <span className="text-gray-400">—</span>}
                      {t.origin_session_at && <div className="text-xs text-gray-500">{fmtDate(t.origin_session_at)}</div>}
                    </div>
                    <div><span className={statusBadge(effectiveStatus(t))}>{effectiveStatus(t)}</span></div>
                    <div className="text-xs text-gray-500">{fmtDate(t.created_at)}</div>
                    <div className="text-xs text-gray-500">
                      {editable ? (
                        <button
                          onClick={() => (editingId === t.token_id ? cancelEdit() : startEdit(t))}
                          className="text-left text-[#FA4D8D] hover:underline"
                        >
                          {t.expires_at ? fmtDate(t.expires_at) : 'Set expiry'}
                        </button>
                      ) : (
                        t.expires_at ? fmtDate(t.expires_at) : '—'
                      )}
                    </div>
                  </div>
                  {editingId === t.token_id && (
                    <div className="border-t border-gray-100 bg-gray-50 px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-500">Expires</span>
                        <select
                          value={expiryMode}
                          onChange={(e) => setExpiryMode(e.target.value)}
                          className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
                        >
                          <option value="30">in 30 days</option>
                          <option value="60">in 60 days</option>
                          <option value="90">in 90 days</option>
                          <option value="180">in 6 months</option>
                          <option value="365">in 12 months</option>
                          <option value="custom">on a set date…</option>
                          <option value="none">never</option>
                        </select>
                        {expiryMode === 'custom' && (
                          <input
                            type="date"
                            value={expiryDate}
                            onChange={(e) => setExpiryDate(e.target.value)}
                            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
                          />
                        )}
                        <button
                          onClick={() => saveExpiry(t)}
                          disabled={savingExpiry}
                          className="rounded-lg bg-[#FA4D8D] px-3 py-1 text-xs font-medium text-white hover:bg-[#e23f7c] disabled:opacity-60"
                        >
                          {savingExpiry ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                        {expiryError && <span className="text-xs font-medium text-red-600">{expiryError}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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
