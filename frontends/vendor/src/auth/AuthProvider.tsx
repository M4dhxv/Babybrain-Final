import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, AUTH_STORAGE_KEY } from '@/lib/supabase';
import { identifyUser, resetUser } from '@/lib/posthog';
import type { Provider, ProviderRole, SubscriptionPlan } from '@/lib/database.types';
import { getCachedSubscription, setCachedSubscription, clearCachedSubscription, getCachedProvider, setCachedProvider } from '@/lib/providerCache';
import { cacheInvalidate } from '@/lib/queryCache';
import { disconnectChat } from '@/lib/chat';
import { releasePushOnSignOut } from '@/lib/push';
import { apiPost } from '@/lib/api';
import { getAdminTarget, clearAdminTarget, takeAdminToken } from '@/lib/adminView';

/** Set when this load came from admin → "Open vendor portal" (see lib/adminView.ts). */
const adminToken = takeAdminToken();

/** Caches are per account, and per vendor in admin view, where one account
 *  moves between vendors. */
function cacheId(userId: string | undefined): string | undefined {
  const target = getAdminTarget();
  return userId && target ? `${userId}:as:${target}` : userId;
}

/** supabase-js falls back to `JSON.stringify(body)` when a GoTrue error
 *  response has none of msg/message/error_description/error (see auth-js's
 *  `_getErrorMessage`) — an infra-level 500 with an empty JSON body then
 *  surfaces as the literal string "{}" here rather than a readable message.
 *  Same fallback as the parent app's AuthProvider. */
function authErrorMessage(error: { message: string }): string {
  const m = error.message.trim();
  return m && !/^[{[]/.test(m) ? m : 'Something went wrong on our end — please try again in a moment.';
}

type LoginHelp =
  | { status: 'login' }
  | { status: 'contact_only'; business_name: string; login_hint: string | null }
  | { status: 'unknown' };

/** Why an email didn't work (app/api/vendor/login-help). Null when the lookup
 *  itself failed or was throttled — callers then keep Supabase's own wording. */
async function loginHelp(email: string): Promise<LoginHelp | null> {
  try {
    return await apiPost<LoginHelp>('/api/vendor/login-help', { email });
  } catch {
    return null;
  }
}

/** Why a sign-in or reset failed, for the auth pages to show next to the field
 *  that's wrong (with a fix-it action) rather than as a banner. */
export type AuthIssue =
  | { kind: 'unknown_email' }
  | { kind: 'wrong_password' }
  /** The email is a business's public contact address, not a login — the
   *  commonest vendor sign-in mistake. */
  | { kind: 'contact_email'; businessName: string; loginHint: string | null };

export interface AuthResult {
  /** Plain-text reason, always set on failure (the claim flow shows only this). */
  error?: string;
  issue?: AuthIssue;
}

function issueResult(email: string, issue: AuthIssue): AuthResult {
  const e = email.trim();
  switch (issue.kind) {
    case 'unknown_email':
      return { issue, error: `No vendor account uses ${e}.` };
    case 'wrong_password':
      return { issue, error: 'Incorrect password.' };
    case 'contact_email':
      return { issue, error: `${e} is ${issue.businessName}'s contact email, not a login.` };
  }
}

function contactIssue(help: Extract<LoginHelp, { status: 'contact_only' }>): AuthIssue {
  return { kind: 'contact_email', businessName: help.business_name, loginHint: help.login_hint };
}

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
  /** A Babybrain admin working in this vendor's portal as a manager (00251),
   *  not one of the vendor's own team. */
  adminView: boolean;
  /** Back to the admin's own (vendor-less) portal. */
  leaveAdminView: () => void;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  resetPassword: (email: string) => Promise<AuthResult>;
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

/** How long past its expiry a stored session is still trusted for the optimistic first render (see readStoredSession). */
const STALE_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read the Supabase session straight out of localStorage, synchronously, so a
 * returning vendor's first render isn't a full-screen boot loader while
 * `getSession()` — which can do a token-refresh round trip — settles. The
 * effect still calls `getSession()` right after to validate/refresh. Only a
 * token that isn't already expired is trusted; a malformed or blocked store
 * returns null, i.e. the old behaviour.
 *
 * Reads only this app's own key (AUTH_STORAGE_KEY) — see the matching
 * comment in lib/supabase.ts: the parent app shares this same Supabase
 * project and, in production, the same origin, so scanning broadly for
 * anything shaped like `sb-*-auth-token` used to also pick up a parent-only
 * session here.
 */
function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const s = (parsed.access_token ? parsed : parsed.currentSession) as
      | (Session & { expires_at?: number })
      | undefined;
    if (!s || !s.access_token || !s.user?.id) return null;
    // An access token only lives about an hour, so a vendor coming back after a
    // few hours always had an "expired" one here and got the full-screen loader
    // until a token renewal round trip finished (and, on a dead connection, a
    // lot longer). The refresh token outlives it, and supabase-js renews the
    // access token on its own before the first request goes out — so keep
    // rendering optimistically while it is within a week of expiry. If the
    // renewal is refused, the SIGNED_OUT event below clears the session and
    // routes them to sign in, same as any other expired session.
    if (typeof s.expires_at === 'number' && s.expires_at * 1000 <= Date.now()) {
      const staleMs = Date.now() - s.expires_at * 1000;
      if (!s.refresh_token || staleMs > STALE_SESSION_MAX_MS) return null;
    }
    return s;
  } catch {
    /* storage blocked or JSON malformed — fall back to the async path */
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Optimistic session from storage — lets the router render without a
  // full-screen boot loader. `getSession()` in the effect still confirms it.
  // An admin's sign-in link replaces whoever was signed in here, so don't paint
  // that account first.
  const initialSession = useMemo(() => (adminToken ? null : readStoredSession()), []);
  const [session, setSession] = useState<Session | null>(initialSession);
  const initialProvider = useMemo(() => getCachedProvider<Provider>(cacheId(initialSession?.user.id)), [initialSession]);
  const [provider, setProvider] = useState<Provider | null>(initialProvider?.provider ?? null);
  const [role, setRole] = useState<ProviderRole | null>((initialProvider?.role as ProviderRole | undefined) ?? null);
  // Seed the plan from the last-known value for THIS user, so the sidebar plan
  // card and the Pro/paid tab locks paint correct on the first frame instead of
  // flashing "free" while the provider lookup is in flight. The live query
  // below always overwrites this.
  const initialSubscription = useMemo<Subscription | null>(() => {
    const cached = getCachedSubscription(cacheId(initialSession?.user.id));
    return cached ? (cached as Subscription) : null;
  }, [initialSession]);
  const [subscription, setSubscription] = useState<Subscription | null>(initialSubscription);
  // Only hold routing on the async check when there's nothing to render from.
  const [loading, setLoading] = useState(!initialSession);
  const [recovery, setRecovery] = useState(false);
  const [providerResolved, setProviderResolvedState] = useState(false);
  // The same, for the visibility handler below: it is set up once, so it would
  // only ever see the first render's `false` and re-run the business lookup
  // every time the tab came back to the front.
  const providerResolvedRef = useRef(false);
  const setProviderResolved = (v: boolean) => {
    providerResolvedRef.current = v;
    setProviderResolvedState(v);
  };
  const [providerError, setProviderError] = useState(false);
  const [adminView, setAdminView] = useState(false);

  /** Returns whether the lookup actually answered. A failed query is NOT an
   *  answer: reporting it as "no business" is what dropped a real vendor onto
   *  the NoBusinessGate after a refresh. */
  async function loadProvider(userId?: string, signal?: AbortSignal): Promise<boolean> {
    const target = getAdminTarget();
    if (target) {
      const q = supabase
        .from('admin_vendor_access')
        .select('provider:providers(*, subscription:subscriptions(*))')
        .eq('provider_id', target);
      const { data: grants, error: grantErr } = await (signal ? q.abortSignal(signal) : q);
      if (grantErr) return false;
      const granted = grants?.[0]?.provider;
      if (granted) {
        applyProvider(granted, 'manager', userId);
        setAdminView(true);
        return true;
      }
      // No grant for this account (a vendor signed in on the admin's browser,
      // or access was withdrawn) — carry on as a normal sign-in.
      clearAdminTarget();
    }
    setAdminView(false);
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
      applyProvider(member.provider, member.role as ProviderRole, userId);
    } else {
      setProvider(null);
      setRole(null);
      setSubscription(null);
      clearCachedSubscription();
    }
    return true;
  }

  function applyProvider(row: unknown, memberRole: ProviderRole, userId?: string) {
    const { subscription: sub, ...prov } = row as Provider & { subscription: Subscription | null };
    setProvider(prov as Provider);
    setRole(memberRole);
    const resolved: Subscription = sub ?? {
      plan: 'free',
      status: 'active',
      current_period_end: null,
      cancel_at_period_end: false,
    };
    setSubscription(resolved);
    // Persist for the next cold load's first paint (see providerCache.ts).
    const id = cacheId(userId);
    if (id) {
      setCachedSubscription(id, resolved);
      setCachedProvider(id, prov, memberRole);
    }
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
        if (adminToken) {
          // Start clean: nothing cached for whoever was signed in here before.
          cacheInvalidate();
          await disconnectChat();
          const { error } = await supabase.auth.verifyOtp({ token_hash: adminToken, type: 'magiclink' });
          if (error) console.warn('[auth] admin sign-in link failed', error.message);
        }
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
          setAdminView(false);
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
          if (data.session && !providerResolvedRef.current) void resolveProvider(data.session.user.id);
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
    adminView,
    leaveAdminView: () => {
      clearAdminTarget();
      cacheInvalidate();
      window.location.replace(`${window.location.origin}/admin`);
    },
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return {};
      // Supabase says "Invalid login credentials" for both a wrong password and
      // an email with no account; ask which it was.
      if (error.code === 'invalid_credentials') {
        const help = await loginHelp(email);
        if (help?.status === 'login') return issueResult(email, { kind: 'wrong_password' });
        if (help?.status === 'contact_only') return issueResult(email, contactIssue(help));
        if (help?.status === 'unknown') return issueResult(email, { kind: 'unknown_email' });
      }
      return { error: authErrorMessage(error) };
    },
    resetPassword: async (email) => {
      // Supabase answers "sent" even when no account has this email, and sends
      // nothing — so check first and say why.
      const help = await loginHelp(email);
      if (help?.status === 'unknown') return issueResult(email, { kind: 'unknown_email' });
      if (help?.status === 'contact_only') return issueResult(email, contactIssue(help));
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        // No trailing slash: the hosted redirect allow-list is exact-match, and
        // `/vendor/` (BASE_URL) is silently rewritten to the parent site_url.
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`,
      });
      return error ? { error: authErrorMessage(error) } : {};
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      setRecovery(false);
      return error ? { error: authErrorMessage(error) } : {};
    },
    signOut: async () => {
      clearAdminTarget();
      clearCachedSubscription();
      cacheInvalidate();
      // getChatClient() caches one StreamChat connection per browser tab and
      // never tore it down — a vendor who signs out and a different vendor
      // who signs into a different business in the same tab (a real
      // workflow; the portal has no business switcher) silently inherited
      // the first vendor's chat identity: their unread badge, their channel
      // list, and any message the second vendor sent went out under the
      // first vendor's Stream user. Disconnecting here forces the next
      // getChatClient() call to open a fresh connection for whoever signs in
      // next.
      await disconnectChat();
      // Needs the session, so before it ends: stop this device getting the account's pushes.
      await releasePushOnSignOut();
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
