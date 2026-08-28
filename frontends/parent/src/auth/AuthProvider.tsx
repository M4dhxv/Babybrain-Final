import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { identifyUser, resetUser } from "../lib/posthog";
import { goTo, appUrl } from "../lib/nav";
import type { ParentProfile, Child } from "../lib/database.types";

interface AuthState {
  session: Session | null;
  profile: ParentProfile | null;
  children: Child[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    onboarding?: SignupOnboarding
  ) => Promise<{ error?: string; emailExists?: boolean }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Everything the sign-up form collects beyond the credentials.
 *
 *  It rides along as auth metadata because with email confirmation on there is
 *  no session at sign-up, so the browser cannot write `children` or
 *  `user_preferences` itself. The `handle_new_user` trigger materialises this
 *  under the new user's own id (migration 00036) — QA: "when I logged in the
 *  children hadn't been saved". */
export interface SignupOnboarding {
  full_name: string;
  phone: string | null;
  postal_code: string;
  terms_accepted: boolean;
  preferences: {
    days: string[];
    times: string[];
    regions: string[];
    interests: string[];
    budget_min: number | null;
    budget_max: number | null;
  };
  children: {
    name: string;
    dob: string;
    gender: string;
    interests: string[];
  }[];
}

const Ctx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ParentProfile | null>(null);
  const [kids, setKids] = useState<Child[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setProfile(null);
      setKids([]);
      return;
    }
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from("parent_profiles").select("*").eq("id", user.id).maybeSingle(),
      supabase.from("children").select("*").order("created_at"),
    ]);
    setProfile(p ?? null);
    setKids(c ?? []);
  }

  useEffect(() => {
    let alive = true;
    const settle = () => { if (alive) setLoading(false); };

    // Never let a signed-in view sit on its "Loading…" gate because a
    // restored tab's auth/network call hung — clear `loading` within 8s.
    const failsafe = setTimeout(settle, 8000);

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSession(data.session);
        if (data.session) {
          identifyUser(data.session.user.id, data.session.user.email);
          await load();
        }
      } catch (err) {
        console.warn("[auth] session init failed", err);
      } finally {
        clearTimeout(failsafe);
        settle();
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      if (!alive) return;
      setSession(s);
      try {
        if (s) {
          identifyUser(s.user.id, s.user.email);
          await load();
        } else {
          resetUser();
          setProfile(null);
          setKids([]);
        }
      } catch (err) {
        console.warn("[auth] auth-state change failed", err);
      } finally {
        clearTimeout(failsafe);
        settle();
      }
    });

    // A tab woken from a browser restart / bfcache can hold a stale session
    // view; re-check when it comes back so it recovers without a hard refresh.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      supabase.auth
        .getSession()
        .then(({ data }) => { if (alive) setSession(data.session); })
        .catch(() => {})
        .finally(settle);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearTimeout(failsafe);
      document.removeEventListener("visibilitychange", onVisible);
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    session,
    profile,
    children: kids,
    loading,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? { error: error.message } : {};
    },
    signUp: async (email, password, fullName, onboarding) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, ...(onboarding ? { onboarding } : {}) },
          // Send the confirmation link through our own callback so a
          // confirmed parent lands on their profile, not back on sign-up.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/profile`,
        },
      });
      if (error) return { error: error.message };
      // With "Confirm email" on, Supabase won't error on a duplicate address —
      // it returns a fake user with no identities instead, so enumerating
      // registered emails isn't possible from the response alone. That's the
      // only way to tell the signup didn't actually happen.
      if (data.user && data.user.identities?.length === 0) return { emailExists: true };
      return {};
    },
    resetPassword: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: appUrl("/reset-password"),
      });
      return error ? { error: error.message } : {};
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      return error ? { error: error.message } : {};
    },
    signOut: async () => {
      await supabase.auth.signOut();
      goTo("/");
    },
    refresh: load,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
