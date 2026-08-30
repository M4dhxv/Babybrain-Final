import { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { identifyUser, resetUser } from '@/lib/posthog';
import type { Provider, ProviderRole, SubscriptionPlan } from '@/lib/database.types';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [role, setRole] = useState<ProviderRole | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [providerResolved, setProviderResolved] = useState(false);
  const [providerError, setProviderError] = useState(false);

  /** Returns whether the lookup actually answered. A failed query is NOT an
   *  answer: reporting it as "no business" is what dropped a real vendor onto
   *  the NoBusinessGate after a refresh. */
  async function loadProvider(): Promise<boolean> {
    // Resolve the user's first active membership → its provider (RLS-scoped).
    const { data: member, error } = await supabase
      .from('provider_members')
      .select('role, provider:providers(*)')
      .eq('status', 'active')
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
      setSubscription(sub ? (sub as Subscription) : { plan: 'free', status: 'active', current_period_end: null, cancel_at_period_end: false });
    } else {
      setProvider(null);
      setRole(null);
      setSubscription(null);
    }
    return true;
  }

  /** A page load can fire the lookup while the access token is still being
   *  renewed, and that first query comes back empty-handed. One miss isn't a
   *  verdict — retry briefly before settling on anything. */
  async function resolveProvider(attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        // Bounded: a request that never settles would otherwise hold the portal
        // on its spinner forever, which is the failure the 8s failsafe below
        // was there to prevent before this gate learned to wait.
        if (await withTimeout(loadProvider(), 6000)) {
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
          await resolveProvider();
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
          await resolveProvider();
        } else {
          resetUser();
          setProvider(null);
          setRole(null);
          setSubscription(null);
          setProviderResolved(false);
          setProviderError(false);
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
          if (data.session && !providerResolved) void resolveProvider();
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
      await supabase.auth.signOut();
    },
    refreshProvider: async () => { await resolveProvider(); },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
