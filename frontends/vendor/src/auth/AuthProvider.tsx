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
 *  failed lookup, not an answer to wait on indefinitely. */
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
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
  // flashing "free" for the beat between the provider lookup and its follow-up
  // subscription query. The live query below always overwrites this.
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
  async function loadProvider(userId?: string): Promise<boolean> {
    // Resolve the user's active membership → its provider (RLS-scoped).
    //
    // `order('created_at')` is load-bearing, not cosmetic: the portal shows
    // exactly one business and has no switcher, so which row wins here IS the
    // account's identity in the app. Without an explicit order Postgres could
    // return either membership when an account has more than one, and a
    // spuriously-added membership (e.g. from a mis-aimed "Claim your listing")
    // could quietly take over the portal — with a sign-out/in cycle unable to
    // shake it, because the row is in the database. Oldest membership = the
    // vendor's original business = home.
    const { data: member, error } = await supabase
      .from('provider_members')
      .select('role, created_at, provider:providers(*)')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return false;
    if (member?.provider) {
      const prov = member.provider as unknown as Provider;
      setProvider(prov);
      setRole(member.role as ProviderRole);
      // The provider's real subscription tier (free/growth/…) — RLS-scoped.
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('plan, status, current_period_end, cancel_at_period_end')
        .eq('provider_id', prov.id)
        .maybeSingle();
      const resolved: Subscription = sub
        ? (sub as Subscription)
        : { plan: 'free', status: 'active', current_period_end: null, cancel_at_period_end: false };
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
    for (let i = 0; i < attempts; i++) {
      try {
        // Bounded: a request that never settles would otherwise hold the portal
        // on its spinner forever, which is the failure the 8s failsafe below
        // was there to prevent before this gate learned to wait.
        if (await withTimeout(loadProvider(userId), 6000)) {
          setProviderResolved(true);
          setProviderError(false);
          return true;
        }
      } catch (err) {
        console.warn('[auth] provider lookup failed', err);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
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
