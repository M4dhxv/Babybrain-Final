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
  recovery: boolean;             // true after a password-reset link is opened
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refreshProvider: () => Promise<void>;
}

const Ctx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [role, setRole] = useState<ProviderRole | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  async function loadProvider() {
    // Resolve the user's first active membership → its provider (RLS-scoped).
    const { data: member } = await supabase
      .from('provider_members')
      .select('role, provider:providers(*)')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
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
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) {
        identifyUser(data.session.user.id, data.session.user.email);
        await loadProvider();
      }
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
      if (s) {
        identifyUser(s.user.id, s.user.email);
        await loadProvider();
      } else {
        resetUser();
        setProvider(null);
        setRole(null);
        setSubscription(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session,
    provider,
    role,
    subscription,
    loading,
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
    refreshProvider: loadProvider,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
