import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, AUTH_STORAGE_KEY } from "../lib/supabase";
import { identifyUser, resetUser } from "../lib/posthog";
import { clearPlanCache } from "../lib/planCache";
import { goTo, appUrl } from "../lib/nav";
import type { ParentProfile, Child } from "../lib/database.types";

interface AuthState {
  session: Session | null;
  profile: ParentProfile | null;
  children: Child[];
  loading: boolean;
  /** The profile/children fetch has answered — an empty `children` alongside
   *  this means "no children yet", without it only means "we don't know yet". */
  dataResolved: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    onboarding?: SignupOnboarding,
    /** The plan the parent picked on the sign-up form. Kept on the account so a
     *  Plus choice survives the email-confirmation round trip (see
     *  PendingPlusGate) — without it, confirming by email silently left the
     *  parent on Free with no payment taken. */
    intent?: SignupPlanIntent
  ) => Promise<{ error?: string; emailExists?: boolean }>;
  /** Re-send the sign-up confirmation email (same link, same branded template). */
  resendConfirmation: (email: string) => Promise<{ error?: string }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** A paid plan chosen at sign-up, stored as auth metadata until payment lands. */
export interface SignupPlanIntent {
  plan: "plus";
  billing: "monthly" | "annual";
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
  /** Optional marketing permission from the sign-up checkbox (00094). */
  marketing_consent?: boolean;
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

/** Resolves to `false` if `p` hasn't settled within `ms` — a hung lookup is a
 *  failed lookup, not an answer to wait on indefinitely. */
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

/**
 * Read the Supabase session straight out of localStorage, synchronously, so a
 * returning parent's first render is already the signed-in app (with its own
 * skeletons) instead of a full-screen boot loader while `getSession()` — which
 * can do a token-refresh round trip — settles. `getSession()` still runs right
 * after to validate/refresh; this is only the optimistic starting point.
 *
 * Reads only this app's own key (AUTH_STORAGE_KEY) — not just anything
 * matching Supabase's default `sb-*-auth-token` shape. The vendor portal
 * shares this same Supabase project and, in production, the same origin; a
 * vendor account also always has a parent_profiles row, so scanning broadly
 * used to mean a vendor who'd only ever logged into /vendor/ could open /app/
 * in the same browser and be read as an already-signed-in parent.
 *
 * Only a token that isn't already expired is trusted: an expired one needs a
 * real refresh before it's usable, so that case falls through to the normal
 * async flow. A malformed or blocked store returns null — no regression, just
 * the old behaviour.
 */
function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // supabase-js v2 stores the session object directly; some setups wrap it.
    const s = (parsed.access_token ? parsed : parsed.currentSession) as
      | (Session & { expires_at?: number })
      | undefined;
    if (!s || !s.access_token || !s.user?.id) return null;
    if (typeof s.expires_at === "number" && s.expires_at * 1000 <= Date.now()) return null;
    return s;
  } catch {
    /* storage blocked or JSON malformed — fall back to the async path */
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Optimistic session from storage — lets routing render the signed-in app on
  // the first paint. `getSession()` in the effect below still confirms it.
  const initialSession = useMemo(readStoredSession, []);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [profile, setProfile] = useState<ParentProfile | null>(null);
  const [kids, setKids] = useState<Child[]>([]);
  // Only hold routing on the async check when there's nothing to render from.
  const [loading, setLoading] = useState(!initialSession);
  const [dataResolved, setDataResolved] = useState(false);

  /** Returns whether the fetch actually answered. A failed query is NOT an
   *  answer — reporting it as "no profile, no children" is what showed signed-in
   *  parents the logged-out and "tell us about your child" screens on refresh. */
  async function load(): Promise<boolean> {
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr) return false;
    if (!user) {
      setProfile(null);
      setKids([]);
      return true;
    }
    const [{ data: p, error: pErr }, { data: c, error: cErr }] = await Promise.all([
      supabase.from("parent_profiles").select("*").eq("id", user.id).maybeSingle(),
      supabase.from("children").select("*").order("created_at"),
    ]);
    if (pErr || cErr) return false;
    setProfile(p ?? null);
    setKids(c ?? []);
    return true;
  }

  /** A page load can fire these while the access token is still being renewed,
   *  and they come back empty. One miss isn't a verdict — retry briefly. */
  async function resolveData(attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        // Bounded, so a request that never settles can't hold a signed-in page
        // on its loader forever.
        if (await withTimeout(load(), 6000)) {
          setDataResolved(true);
          return true;
        }
      } catch (err) {
        console.warn("[auth] profile lookup failed", err);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return false;
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
          // Don't hold `loading` (which gates routing) on the profile/children
          // lookup — knowing whether there's a session is enough to route. The
          // lookup runs in the background and flips `dataResolved` when done;
          // anything that needs the profile or child list gates on that.
          void resolveData();
        }
      } catch (err) {
        console.warn("[auth] session init failed", err);
      } finally {
        clearTimeout(failsafe);
        settle();
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!alive) return;
      setSession(s);
      try {
        if (s) {
          identifyUser(s.user.id, s.user.email);
          void resolveData();
        } else {
          resetUser();
          // Don't let the next account (same browser, no hard refresh) inherit
          // this one's persisted plan.
          clearPlanCache();
          setProfile(null);
          setKids([]);
          setDataResolved(false);
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
        .then(({ data }) => {
          if (!alive) return;
          setSession(data.session);
          // Coming back to a tab whose fetch had failed is the natural moment
          // to try again rather than leaving it on a logged-out-looking page.
          if (data.session && !dataResolved) void resolveData();
        })
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
    dataResolved,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? { error: error.message } : {};
    },
    signUp: async (email, password, fullName, onboarding, intent) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            ...(onboarding ? { onboarding } : {}),
            ...(intent ? { intended_plan: intent.plan, intended_billing: intent.billing } : {}),
          },
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
    resendConfirmation: async (email) => {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/profile` },
      });
      return error ? { error: error.message } : {};
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
      // Full reload on the way out so no signed-in state (dashboard caches,
      // favourites, plan) lingers in memory for the landing page.
      goTo("/", { hard: true });
    },
    refresh: async () => { await resolveData(); },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
