import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { identifyUser, resetUser } from '@/lib/posthog';
import type { Provider, ProviderRole, SubscriptionPlan } from '@/lib/database.types';
import { getCachedSubscription, setCachedSubscription, clearCachedSubscription } from '@/lib/providerCache';
import { cacheInvalidate } from '@/lib/queryCache';

export interface Subscription {
  plan: SubscriptionPlan;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

interface AuthState {
  session: Session | null;
  provider: Provider | null;     // the vendor's active business
  role: ProviderRole | null;
  subscription: Subscription | null;
  loading: boolean;
  /** The membership lookup has answered — `provider: null` alongside this
   *  means "no business", without it only means "we don't know yet". */
  providerResolved: boolean;
  /** The lookup kept failing (offline, RLS hiccup). Distinct from a clean
   *  "no business" answer, so callers can offer a retry instead of a fork. */
  providerError: boolean;
  recovery: boolean;             // true after a password-reset link is opened
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refreshProvider: () => Promise<void>;
}

const Ctx = createContext<AuthState | undefined>(undefined);

/** Resolves to `false` if `p` hasn't settled within `ms` — a hung lookup is a
 *  failed lookup, not an answer to wait on indefinitely. Also aborts `p`'s
 *  underlying request via `controller` on timeout, so the stale request
 *  doesn't keep running (and competing with) the next retry attempt. */
function withTimeout(p: Promise<boolean>, ms: number, controller: AbortController): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { controller.abort(); resolve(false); }, ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }).catch((err) => {
      clearTimeout(timer);
      if ((err as { name?: string })?.name !== 'AbortError') console.warn('[auth] provider lookup failed', err);
      resolve(false);
    });
  });
}

/**
 * Read the Supabase session straight out of localStorage, synchronously, so a
 * returning vendor's first render isn't a full-screen boot loader while
 * `getSession()` — which can do a token-refresh round trip — settles. The
 * effect still calls `getSession()` right after to validate/refresh. Only a
 * token that isn't already expired is trusted; a malformed or blocked store
 * returns null, i.e. the old behaviour.
 */
function readStoredSession(): Session | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const s = (parsed.access_token ? parsed : parsed.currentSession) as
        | (Session & { expires_at?: number })
        | undefined;
      if (!s || !s.access_token || !s.user?.id) return null;
      if (typeof s.expires_at === 'number' && s.expires_at * 1000 <= Date.now()) return null;
      return s;
    }
  } catch {
    /* storage blocked or JSON malformed — fall back to the async path */
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Optimistic session from storage — lets the router render without a
  // full-screen boot loader. `getSession()` in the effect still confirms it.
  const initialSession = useMemo(readStoredSession, []);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [role, setRole] = useState<ProviderRole | null>(null);
  // Seed the plan from the last-known value for THIS user, so the sidebar plan
  // card and the Pro/paid tab locks paint correct on the first frame instead of
  // flashing "free" while the provider lookup is in flight. The live query
  // below always overwrites this.
  const initialSubscription = useMemo<Subscription | null>(() => {
    const cached = getCachedSubscription(initialSession?.user.id);
    return cached ? (cached as Subscription) : null;
  }, [initialSession]);
  const [subscription, setSubscription] = useState<Subscription | null>(initialSubscription);
  // Only hold routing on the async check when there's nothing to render from.
  const [loading, setLoading] = useState(!initialSession);
  const [recovery, setRecovery] = useState(false);
  const [providerResolved, setProviderResolved] = useState(false);
  const [providerError, setProviderError] = useState(false);

  /** Returns whether the lookup actually answered. A failed query is NOT an
   *  answer: reporting it as "no business" is what dropped a real vendor onto
   *  the NoBusinessGate after a refresh. */
  async function loadProvider(userId?: string, signal?: AbortSignal): Promise<boolean> {
    // Resolve the user's active membership → its provider (RLS-scoped), with
    // its subscription embedded in the same request (subscriptions.provider_id
    // is providers' 1:1 child, so PostgREST can join it server-side) — this
    // used to be two sequential awaited round trips, which doubled the latency
    // of every retry attempt for no reason.
    //
    // The portal shows exactly one business and has no switcher, so which row
    // wins here IS the account's identity in the app. An account can hold more
    // than one active membership — most often a genuine owner of Business A who
    // was also invited as staff/manager onto Business B — and the higher-role
    // one wins (owner > manager > staff), oldest-created as the tiebreak. An
    // owner row can only ever come from that person proving control of the
    // business's own contact email (see claim/verify's identity-binding check)
    // or their own signup, never from an invite (staff/invite only ever grants
    // manager/staff) — so unlike a plain "oldest wins" pick, ranking by role
    // can't be hijacked by a spuriously-added lower-privilege membership, and
    // it stops a real owner from being silently stuck on a staff-only view
    // just because that row happened to be created first.
    const query = supabase
      .from('provider_members')
      .select('role, created_at, provider:providers(*, subscription:subscriptions(*))')
      .eq('status', 'active')
      .order('created_at', { ascending: true });
    const { data: members, error } = await (signal ? query.abortSignal(signal) : query);
    if (error) return false;
    const ROLE_RANK: Record<ProviderRole, number> = { staff: 1, manager: 2, owner: 3 };
    const member = (members ?? []).reduce<(typeof members)[number] | null>((best, m) => {
      if (!best) return m;
      const rank = ROLE_RANK[m.role as ProviderRole] ?? 0;
      const bestRank = ROLE_RANK[best.role as ProviderRole] ?? 0;
      return rank > bestRank ? m : best;
    }, null);
    if (member?.provider) {
      const { subscription: sub, ...prov } = member.provider as unknown as Provider & {
        subscription: Subscription | null;
      };
      setProvider(prov as Provider);
      setRole(member.role as ProviderRole);
      const resolved: Subscription = sub ?? {
        plan: 'free',
        status: 'active',
        current_period_end: null,
        cancel_at_period_end: false,
      };
      setSubscription(resolved);
      // Persist for the next cold load's first paint (see providerCache.ts).
      if (userId) setCachedSubscription(userId, resolved);
    } else {
      setProvider(null);
      setRole(null);
      setSubscription(null);
      clearCachedSubscription();
    }
    return true;
  }

  /** A page load can fire the lookup while the access token is still being
   *  renewed, and that first query comes back empty-handed. One miss isn't a
   *  verdict — retry briefly before settling on anything. */
  async function resolveProvider(userId?: string, attempts = 3) {
    // Bounded: a request that never settles would otherwise hold the portal on
    // its spinner forever, which is the failure the 8s failsafe below was
    // there to prevent before this gate learned to wait. Kept comfortably
    // under index.html's 20s "wedged on a loading gate" watchdog — that
    // reload discards whatever attempt is in flight and restarts the whole
    // bootstrap from scratch, so a retry budget that only just fits under it
    // is worse than no retries at all on a merely-slow connection.
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      if (await withTimeout(loadProvider(userId, controller.signal), 4500, controller)) {
        setProviderResolved(true);
        setProviderError(false);
        return true;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    setProviderError(true);
    return false;
  }

  useEffect(() => {
    let alive = true;
    const settle = () => { if (alive) setLoading(false); };

    // Never let the portal sit on its "Loading…" gate because a restored
    // tab's auth/network call hung — clear `loading` no matter what within 8s.
    const failsafe = setTimeout(settle, 8000);

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSession(data.session);
        if (data.session) {
          identifyUser(data.session.user.id, data.session.user.email);
          await resolveProvider(data.session.user.id);
        }
      } catch (err) {
        console.warn('[auth] session init failed', err);
      } finally {
        clearTimeout(failsafe);
        settle();
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!alive) return;
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
      try {
        if (s) {
          identifyUser(s.user.id, s.user.email);
          await resolveProvider(s.user.id);
        } else {
          resetUser();
          setProvider(null);
          setRole(null);
          setSubscription(null);
          setProviderResolved(false);
          setProviderError(false);
          // A different account must never inherit this one's cached plan or
          // read rows.
          clearCachedSubscription();
          cacheInvalidate();
        }
      } catch (err) {
        console.warn('[auth] auth-state change failed', err);
      } finally {
        clearTimeout(failsafe);
        settle();
      }
    });

    // A tab woken from a browser restart / bfcache can hold a stale session
    // view; re-check when it comes back so it recovers without a hard refresh.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      supabase.auth.getSession()
        .then(({ data }) => {
          if (!alive) return;
          setSession(data.session);
          // Coming back to a tab whose lookup had failed is the natural moment
          // to try again, rather than leaving it stuck on the retry panel.
          if (data.session && !providerResolved) void resolveProvider(data.session.user.id);
        })
        .catch(() => {})
        .finally(settle);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      clearTimeout(failsafe);
      document.removeEventListener('visibilitychange', onVisible);
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    session,
    provider,
    role,
    subscription,
    loading,
    providerResolved,
    providerError,
    recovery,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? { error: error.message } : {};
    },
    resetPassword: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      });
      return error ? { error: error.message } : {};
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      setRecovery(false);
      return error ? { error: error.message } : {};
    },
    signOut: async () => {
      clearCachedSubscription();
      cacheInvalidate();
      await supabase.auth.signOut();
    },
    refreshProvider: async () => {
      const { data } = await supabase.auth.getSession();
      await resolveProvider(data.session?.user.id);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
