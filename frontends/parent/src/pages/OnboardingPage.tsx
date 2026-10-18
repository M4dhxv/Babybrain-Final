import { useEffect, useState } from "react";
import { PageShell, Button, Icon, DateInput } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { ResendConfirmation } from "../components/ResendConfirmation";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { geocodePostal } from "../lib/geocode";
import { goTo } from "../lib/nav";
import { captureEvent } from "../lib/posthog";
import {
  PASSWORD_RULES,
  dobError,
  emailError,
  passwordError,
  postcodeError,
} from "../lib/validation";
import { TIME_CHIPS, BUDGET_CHIPS, REGION_FILTERS, budgetRange } from "./prefChips";
import { FREE_PLAN_ITEMS, PLUS_PLAN_ITEMS } from "../lib/planFeatures";

type ChildDraft = { key: string; name: string; dob: string; gender: string; interests: string[] };

const newChildDraft = (): ChildDraft => ({
  key: String(Date.now() + Math.random()),
  name: "",
  dob: "",
  gender: "unspecified",
  interests: [],
});

/* Sign-up is one question per screen. A screen is identified by a string id
   rather than its position, because the list grows and shrinks as children are
   added or removed: "name", "account", then four screens per child
   ("child-name:<key>" and so on), "kids", "home", "areas", "when", "budget",
   "terms" and finally "plan". Each screen is its own browser history entry, so
   the phone's Back button goes to the previous question instead of leaving
   sign-up and losing everything typed. No step counts are shown on purpose:
   the bar at the top is the only progress cue. */
const CHILD_SCREENS = ["child-name", "child-dob", "child-gender", "child-interests"] as const;
type ChildScreen = (typeof CHILD_SCREENS)[number];

function buildSteps(kids: ChildDraft[]): string[] {
  return [
    "name",
    "account",
    ...kids.flatMap((k) => CHILD_SCREENS.map((s) => `${s}:${k.key}`)),
    "kids",
    "home",
    "areas",
    "when",
    "budget",
    "terms",
    "plan",
  ];
}

/** "child-dob:123" → ["child-dob", "123"]; "home" → ["home", undefined]. */
function parseStep(id: string): [string, string | undefined] {
  const i = id.indexOf(":");
  return i === -1 ? [id, undefined] : [id.slice(0, i), id.slice(i + 1)];
}

/** ISO yyyy-mm-dd → dd/mm/yyyy, the way parents typed it. */
function dayFirst(iso: string) {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** A big tappable choice — the one-question screens' version of a chip. */
function Option({ on, onClick, children, className = "" }: { on: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex min-h-[52px] items-center justify-between gap-2 rounded-[12px] border px-4 py-3 text-left text-[15px] font-black transition-colors ${on ? "border-baby-pink bg-[#FED7E4] text-baby-cta" : "border-[#DCD2D5] bg-white text-baby-ink hover:border-baby-pink"} ${className}`}
    >
      <span>{children}</span>
      {on && <Icon name="check" className="h-4 w-4 shrink-0" />}
    </button>
  );
}

export default function OnboardingPage() {
  const { signUp } = useAuth();
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [weekdays, setWeekdays] = useState(false);
  const [weekend, setWeekend] = useState(false);
  const [times, setTimes] = useState<string[]>([]);
  const [budgets, setBudgets] = useState<string[]>([]);
  const [kids, setKids] = useState<ChildDraft[]>([newChildDraft()]);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  /* Marketing consent at account creation. Unticked by default and optional:
     it never blocks sign-up. QA 04/09 briefly made it required; reverted 29 Sep
     because Singapore's PDPA doesn't let consent beyond what the service needs
     be a condition of signing up. Parents can change it later in Settings. */
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [emailExists, setEmailExists] = useState(false);
  /* The account is only created on the last screen, once a plan is chosen, and
     `accountReady` guards against creating it twice if Plus checkout fails and
     the parent retries. */
  const [step, setStep] = useState("name");
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [selectedPlan, setSelectedPlan] = useState<"free" | "plus">("plus");
  const [accountReady, setAccountReady] = useState(false);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  /* Browser Back / Forward move between questions. The first screen takes over
     the current history entry (also resetting a reload, where the typed
     answers are gone, back to the start); every later screen is pushed. */
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, signupStep: "name" }, "");
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { signupStep?: string } | null)?.signupStep;
      setError(null);
      setStep(s ?? "name");
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const steps = buildSteps(kids);
  // A history entry can point at a child that has since been removed; land on
  // the children summary instead of a blank screen.
  const stepIndex = steps.indexOf(step) === -1 ? steps.indexOf("kids") : steps.indexOf(step);
  const current = steps[stepIndex];
  const [kind, childKey] = parseStep(current);
  const child = kids.find((k) => k.key === childKey);
  const childLabel = child?.name.trim() || "your child";

  // Which screens parents reach, so drop-off between them shows up in PostHog.
  useEffect(() => {
    void captureEvent("signup_step_viewed", { step: kind });
  }, [current, kind]);

  function show(id: string) {
    setError(null);
    setStep(id);
    window.history.pushState({ ...window.history.state, signupStep: id }, "");
    window.scrollTo(0, 0);
  }

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const updateChild = (key: string, patch: Partial<ChildDraft>) =>
    setKids((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const input = "h-12 w-full rounded-[12px] border border-[#FED7E4] bg-white px-4 text-base font-semibold";

  /** The problem on one screen, or null. Everything recommendations depend on
   *  is required, so a new parent can't land on an empty Matches page. */
  function validateStep(id: string): string | null {
    const [k, key] = parseStep(id);
    const c = kids.find((x) => x.key === key);
    const who = c?.name.trim() || "your child";
    switch (k) {
      case "name":
        return fullName.trim() ? null : "Please add your full name.";
      case "account":
        return emailError(email)
          ?? passwordError(password)
          ?? (password !== confirmPassword ? "Passwords don't match — please re-enter them." : null);
      case "child-name":
        return c?.name.trim() ? null : "Please add your child's name.";
      case "child-dob": {
        const problem = c ? dobError(c.dob) : null;
        return problem;
      }
      case "child-interests":
        return c && c.interests.length === 0 ? `Pick at least one interest for ${who}.` : null;
      case "home":
        return postcodeError(postcode);
      case "areas":
        return regions.length === 0 ? "Pick at least one area you'd like activities in." : null;
      case "terms":
        return acceptedTerms ? null : "Please accept our Terms of Service, Terms of Use and Privacy Policy to continue.";
      default:
        return null;
    }
  }

  /** The first screen with a problem, checked before the account is created. */
  function firstProblem(): { id: string; message: string } | null {
    for (const id of steps) {
      const message = validateStep(id);
      if (message) return { id, message };
    }
    return null;
  }

  // Backing out of a just-added child leaves an empty draft behind; drop it on
  // the children summary rather than list an "Unnamed child".
  useEffect(() => {
    if (kind !== "kids") return;
    setKids((xs) => {
      const kept = xs.filter((k) => k.name.trim() || k.dob || k.interests.length);
      return kept.length && kept.length !== xs.length ? kept : xs;
    });
  }, [kind]);

  function next() {
    // Leaving the children summary: every child must be complete, so send the
    // parent to the first unanswered question for any of them.
    if (kind === "kids") {
      const gap = steps.slice(0, stepIndex).map((id) => ({ id, message: validateStep(id) })).find((p) => p.message);
      if (gap) {
        show(gap.id);
        setError(gap.message);
        return;
      }
    }
    const problem = validateStep(current);
    if (problem) {
      setError(problem);
      return;
    }
    show(steps[stepIndex + 1]);
  }

  function addChild() {
    const k = newChildDraft();
    setKids((xs) => [...xs, k]);
    show(`child-name:${k.key}`);
  }

  /** Last screen. Create the account (once), then either drop the parent into
   *  their matches on Free, or hand off to Stripe Checkout to start paying for Plus. */
  async function submit(plan: "free" | "plus") {
    setBusy(true);
    setError(null);

    // Create the account exactly once. If Plus checkout then fails the parent
    // is already signed up on Free, so a retry must not sign them up again.
    if (!accountReady) {
      const problem = firstProblem();
      if (problem) {
        setBusy(false);
        show(problem.id);
        setError(problem.message);
        return;
      }

      const days = [...(weekdays ? ["mon", "tue", "wed", "thu", "fri"] : []), ...(weekend ? ["sat", "sun"] : [])];
      const { budget_min: budgetMin, budget_max: budgetMax } = budgetRange(budgets);
      // Interests across all children drive the parent-level recommendations.
      const allInterests = [...new Set(kids.flatMap((k) => k.interests))];
      const draftKids = kids.map((k) => ({
        name: k.name.trim(),
        dob: k.dob,
        gender: k.gender,
        interests: k.interests,
      }));

      // Send the whole form with the sign-up. When confirmation is required there
      // is no session to write with, so the trigger persists this server-side —
      // QA: "the children hadn't been saved and I had to add them again".
      const { error: signErr, emailExists: alreadyExists } = await signUp(email, password, fullName, {
        full_name: fullName,
        phone: phone || null,
        postal_code: postcode.trim(),
        terms_accepted: acceptedTerms,
        marketing_consent: marketingConsent,
        preferences: {
          days,
          times,
          regions,
          interests: allInterests,
          budget_min: budgetMin,
          budget_max: budgetMax,
        },
        children: draftKids,
      }, plan === "plus" ? { plan: "plus", billing } : undefined);
      if (alreadyExists) {
        setBusy(false);
        return setEmailExists(true);
      }
      if (signErr) {
        setBusy(false);
        return setError(signErr);
      }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        // Email confirmation is on: there's no session to write with, and none
        // to start Plus checkout from. The Plus choice rides along on the
        // account (see the sign-up intent above) and PendingPlusGate takes the
        // parent to payment as soon as they're back, confirmed. Dropping it
        // here used to leave a parent who picked Plus on Free, never charged.
        setBusy(false);
        return setConfirmSent(true);
      }
      const uid = session.user.id;
      // Best-effort: resolves postal_code to coordinates so the recommendation
      // engine's distance scoring (compute_recommendations_for_child) has
      // something to work with — it previously read parent_profiles.latitude/
      // longitude, which nothing ever wrote, so every parent fell back to its
      // neutral "unknown location" score regardless of where they actually are.
      const coords = await geocodePostal(postcode);
      await supabase.from("parent_profiles").update({
        full_name: fullName,
        phone: phone || null,
        postal_code: postcode.trim(),
        terms_accepted_at: new Date().toISOString(),
        // Finishing the wizard is what onboarding is; /admin → Parents reads this.
        onboarding_completed_at: new Date().toISOString(),
        // Only written when actually ticked — a null here means no consent, and
        // that is the state every account starts in.
        ...(marketingConsent ? { marketing_consent_at: new Date().toISOString() } : {}),
        ...(coords ? { latitude: coords.latitude, longitude: coords.longitude } : {}),
      }).eq("id", uid);
      await supabase.from("user_preferences").update({
        preferred_days: days as never,
        preferred_times: times as never,
        preferred_regions: regions as never,
        budget_min: budgetMin,
        budget_max: budgetMax,
        interests: allInterests,
      }).eq("user_id", uid);
      // The trigger already seeded these from the sign-up metadata; only insert
      // when it didn't, so confirming by email never doubles a parent's children.
      const { count } = await supabase
        .from("children")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", uid);
      if (!count) {
        await supabase.from("children").insert(
          draftKids.map((k) => ({
            parent_id: uid,
            name: k.name,
            date_of_birth: k.dob,
            gender: k.gender as never,
            interests: k.interests,
            notes: null,
          }))
        );
      }
      setAccountReady(true);
    }

    if (plan === "plus") {
      // Hand off to Stripe Checkout to start Plus (same call PricingPage
      // uses). On any failure the parent stays signed up on Free — surface it
      // rather than dead-ending the sign-up.
      try {
        const { url } = await apiPost<{ url?: string }>(
          "/api/customer/stripe/subscription",
          { billing }
        );
        if (url) {
          window.location.href = url;
          return;
        }
        setError("We couldn't start checkout just now — your account is ready on the Free plan. You can upgrade any time from Pricing.");
        setBusy(false);
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Payments aren't available right now — your account is ready on the Free plan.");
        setBusy(false);
        return;
      }
    }

    // Fresh sign-in plus brand-new children. AuthProvider reloads the profile and
    // children on the sign-in event, and per-user hooks key on the user id, so a
    // client-side hop picks it all up without re-downloading the bundle.
    goTo("/matches", { replace: true });
  }

  if (confirmSent) {
    return (
      <PageShell active="/onboarding">
        <main className="mx-auto max-w-[460px] px-6 py-16 text-center">
          <h1 className="text-2xl font-black">Check your email</h1>
          <p className="mt-3 font-semibold text-[#44507b]">We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.</p>
          <p className="mt-3 text-sm font-semibold text-[#6D748D]">Can't find it? Check your spam or promotions folder — it can take a couple of minutes.</p>
          <ResendConfirmation email={email} startCoolingDown />
          <p className="mt-3 text-sm font-semibold text-[#5a6690]">
            Wrong address?{" "}
            <button type="button" onClick={() => { setConfirmSent(false); show("account"); }} className="font-black text-baby-pink underline">
              Go back and fix it
            </button>
          </p>
          <p className="mt-2 text-sm font-semibold text-[#5a6690]">
            Still nothing? Email <a href="mailto:hello@babybrain.sg" className="font-black text-baby-pink underline">hello@babybrain.sg</a> and we'll activate your account.
          </p>
          <Button href="/login" className="mt-5">Go to log in</Button>
        </main>
      </PageShell>
    );
  }

  if (emailExists) {
    return (
      <PageShell active="/onboarding">
        <main className="mx-auto max-w-[460px] px-6 py-16 text-center">
          <h1 className="text-2xl font-black">Account already exists</h1>
          <p className="mt-3 font-semibold text-[#44507b]">An account with <strong>{email}</strong> already exists. Log in instead, or use a different email to sign up.</p>
          <Button href="/login" className="mt-5">Go to log in</Button>
          <p className="mt-4 text-sm font-semibold text-[#5a6690]">
            <button type="button" onClick={() => { setEmailExists(false); show("account"); }} className="font-black text-baby-pink underline">
              Use a different email
            </button>
          </p>
        </main>
      </PageShell>
    );
  }

  /* Each screen: one question (title), an optional line under it, the answer
     controls, and what the main button says. Optional screens say "Skip"
     until something is picked. */
  let title: React.ReactNode = null;
  let sub: React.ReactNode = null;
  let body: React.ReactNode = null;
  let cta = "Next";
  switch (kind as "name" | "account" | ChildScreen | "kids" | "home" | "areas" | "when" | "budget" | "terms" | "plan") {
    case "name":
      title = <>First, what's <span className="text-baby-pink">your</span> name?</>;
      sub = "We'll suggest activities that are a great fit for your family.";
      body = (
        <input className={input} autoFocus autoComplete="name" autoCapitalize="words" aria-label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Sarah Tan" />
      );
      break;
    case "account":
      title = <>Create your <span className="text-baby-pink">account</span></>;
      sub = `Nice to meet you${fullName.trim() ? `, ${fullName.trim().split(/\s+/)[0]}` : ""}. You'll log in with these.`;
      body = (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-black" htmlFor="su-email">Email address</label>
            <input id="su-email" type="email" className={input} autoFocus autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. sarah@gmail.com" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-black" htmlFor="su-password">Password</label>
            <input id="su-password" type="password" className={input} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password" />
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
              {PASSWORD_RULES.map((rule) => {
                const met = rule.test(password);
                return (
                  <li key={rule.label} className={met ? "text-[#A8E59A]" : "text-[#6D748D]"}>
                    {met ? "✓" : "•"} {rule.label}
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <label className="mb-1 block text-sm font-black" htmlFor="su-confirm">Confirm password</label>
            <input id="su-confirm" type="password" className={input} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter your password" />
          </div>
        </div>
      );
      break;
    case "child-name":
      title = kids[0]?.key === childKey
        ? <>What's your <span className="text-baby-pink">child's</span> name?</>
        : <>What's your <span className="text-baby-pink">next child's</span> name?</>;
      sub = kids[0]?.key === childKey ? "You can add more children in a moment." : null;
      body = child && (
        <input className={input} autoFocus autoComplete="off" autoCapitalize="words" aria-label="Child's name" value={child.name} onChange={(e) => updateChild(child.key, { name: e.target.value })} placeholder="e.g. Emma" />
      );
      break;
    case "child-dob":
      title = <>When was <span className="text-baby-pink">{childLabel}</span> born?</>;
      sub = "Day first, e.g. 14/03/2024.";
      body = child && (
        <DateInput value={child.dob} onChange={(iso) => updateChild(child.key, { dob: iso })} className={input} />
      );
      break;
    case "child-gender":
      title = <>Is <span className="text-baby-pink">{childLabel}</span> a boy or a girl?</>;
      body = child && (
        <div className="grid gap-3">
          {[["female", "Girl"], ["male", "Boy"], ["unspecified", "Prefer not to say"]].map(([v, l]) => (
            // A single choice: tapping it answers the question and moves on.
            <Option key={v} on={child.gender === v} onClick={() => { updateChild(child.key, { gender: v }); show(steps[stepIndex + 1]); }}>{l}</Option>
          ))}
        </div>
      );
      break;
    case "child-interests":
      title = <>What does <span className="text-baby-pink">{childLabel}</span> love?</>;
      sub = "Pick as many as you like. We use this to match activities.";
      body = child && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {cats.map((c) => (
            <Option
              key={c.slug}
              on={child.interests.includes(c.slug)}
              onClick={() => updateChild(child.key, {
                interests: child.interests.includes(c.slug)
                  ? child.interests.filter((x) => x !== c.slug)
                  : [...child.interests, c.slug],
              })}
            >
              {c.name}
            </Option>
          ))}
        </div>
      );
      break;
    case "kids":
      title = <>Any other <span className="text-baby-pink">children</span>?</>;
      sub = "Add them now and we'll find activities for each of them.";
      cta = "That's everyone";
      body = (
        <div className="space-y-3">
          {kids.map((k) => (
            <div key={k.key} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#FEE9D7] bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-black">{k.name.trim() || "Unnamed child"}</p>
                {k.dob && <p className="text-xs font-semibold text-[#6D748D]">Born {dayFirst(k.dob)}</p>}
              </div>
              <div className="flex shrink-0 gap-4 text-sm font-bold">
                <button type="button" onClick={() => show(`child-name:${k.key}`)} className="text-baby-pink hover:underline">Edit</button>
                {kids.length > 1 && (
                  <button type="button" onClick={() => setKids((xs) => xs.filter((x) => x.key !== k.key))} className="text-[#6D748D] hover:underline">Remove</button>
                )}
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" className="w-full" onClick={addChild}>
            <Icon name="user" className="h-4 w-4" /> Add another child
          </Button>
        </div>
      );
      break;
    case "home":
      title = <>Where's <span className="text-baby-pink">home</span>?</>;
      sub = "Your postcode lets us show what's near you.";
      body = (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-black" htmlFor="su-postcode">Postcode</label>
            <input id="su-postcode" className={input} autoFocus inputMode="numeric" autoComplete="postal-code" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} placeholder="307591" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-black" htmlFor="su-phone">Phone <span className="font-semibold text-[#6D748D]">(optional)</span></label>
            <input id="su-phone" className={input} inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" />
          </div>
        </div>
      );
      break;
    case "areas":
      title = <>Which <span className="text-baby-pink">areas</span> work for you?</>;
      sub = "Pick any that suit you. They don't have to be near home.";
      body = (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {REGION_FILTERS.map(([v, l]) => (
            <Option key={v} on={regions.includes(v)} onClick={() => toggle(regions, v, setRegions)}>{l}</Option>
          ))}
        </div>
      );
      break;
    case "when":
      title = <>When suits you <span className="text-baby-pink">best</span>?</>;
      sub = "Optional. Skip it if you're flexible.";
      if (!weekdays && !weekend && times.length === 0) cta = "Skip";
      body = (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-black">Days</p>
            <div className="grid grid-cols-2 gap-3">
              <Option on={weekdays} onClick={() => setWeekdays(!weekdays)}>Weekdays</Option>
              <Option on={weekend} onClick={() => setWeekend(!weekend)}>Weekend</Option>
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-black">Times</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {TIME_CHIPS.map(([v, l]) => <Option key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Option>)}
            </div>
          </div>
        </div>
      );
      break;
    case "budget":
      title = <>What's your <span className="text-baby-pink">budget</span>?</>;
      sub = "Optional. Pick any that work for you.";
      if (budgets.length === 0) cta = "Skip";
      body = (
        <div className="grid grid-cols-2 gap-3">
          {BUDGET_CHIPS.map(([k, l]) => <Option key={k} on={budgets.includes(k)} onClick={() => toggle(budgets, k, setBudgets)}>{l}</Option>)}
        </div>
      );
      break;
    case "terms":
      title = <>One last <span className="text-baby-pink">thing</span></>;
      body = (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#FEE9D7] bg-white p-4 text-sm font-semibold text-[#44507b]">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-baby-pink"
            />
            <span>
              I hereby acknowledge that I have read the{" "}
              <a href="/terms" target="_blank" rel="noreferrer" className="font-black text-baby-pink underline">Terms of Service</a>
              {", "}
              <a href="/terms#tou" target="_blank" rel="noreferrer" className="font-black text-baby-pink underline">Terms of Use</a>
              {" and "}
              <a href="/terms#privacy" target="_blank" rel="noreferrer" className="font-black text-baby-pink underline">Privacy Policy</a>
              {" and confirm that I am in agreement with and legally bound by such terms, as modified from time to time."}
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#FEE9D7] bg-white p-4 text-sm font-semibold text-[#44507b]">
            <input
              type="checkbox"
              checked={marketingConsent}
              onChange={(e) => setMarketingConsent(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-baby-pink"
            />
            <span>
              I agree and consent to receive marketing communications from BabyBrain to update me on
              offers, promotions, discounts, events, news, etc. relating to BabyBrain's products and
              services via any means of communication such as via email.
            </span>
          </label>
        </div>
      );
      break;
    case "plan":
      title = <>Choose your <span className="text-baby-pink">plan</span></>;
      sub = "Start free, or unlock everything with Plus. Change or cancel any time from your profile.";
      body = (
        <>
          <div className="mx-auto grid h-11 max-w-[340px] grid-cols-2 rounded-full border border-[#DCD2D5] bg-white p-1 text-sm font-black">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={billing === "monthly" ? "rounded-full bg-palette-blue text-white" : "text-[#59658d]"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={billing === "annual" ? "rounded-full bg-palette-blue text-white" : "text-[#59658d]"}
            >
              Annual <span className={billing === "annual" ? "text-white" : "text-baby-pink"}>(1 month free)</span>
            </button>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {/* Plus first and pre-selected — the point of the step is to give the
                paid plan a fair shot rather than defaulting everyone to Free. */}
            <button
              type="button"
              onClick={() => setSelectedPlan("plus")}
              aria-pressed={selectedPlan === "plus"}
              className={`relative rounded-[16px] border bg-white p-5 text-left transition ${selectedPlan === "plus" ? "border-palette-blue ring-2 ring-palette-blue/40" : "border-[#EBE3E5] hover:border-palette-blue"}`}
            >
              <span className="inline-block rounded-full bg-palette-blue px-3 py-1 text-[11px] font-black text-white">MOST POPULAR</span>
              <span className={`absolute right-4 top-4 grid h-5 w-5 place-items-center rounded-full border ${selectedPlan === "plus" ? "border-palette-blue bg-palette-blue text-white" : "border-[#DCD2D5] text-transparent"}`}>
                <Icon name="check" className="h-3 w-3" />
              </span>
              <h2 className="mt-3 text-xl font-black">Plus</h2>
              <p className="mt-1">
                <span className="text-sm font-black text-[#68718f]">SGD </span>
                <span className="text-[32px] font-black text-baby-lilac">{billing === "monthly" ? "15" : "165"}</span>
                <span className="font-bold text-[#68718f]"> {billing === "monthly" ? "/mo" : "/yr"}</span>
              </p>
              <p className="text-sm font-black text-baby-pink">Cancel with 14 days' notice</p>
              <ul className="mt-3 space-y-1.5 text-sm font-semibold text-[#44507b]">
                {PLUS_PLAN_ITEMS.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-palette-blue" /> {item}
                  </li>
                ))}
              </ul>
            </button>

            <button
              type="button"
              onClick={() => setSelectedPlan("free")}
              aria-pressed={selectedPlan === "free"}
              className={`relative rounded-[16px] border bg-white p-5 text-left transition ${selectedPlan === "free" ? "border-palette-blue ring-2 ring-palette-blue/40" : "border-[#EBE3E5] hover:border-palette-blue"}`}
            >
              <span className={`absolute right-4 top-4 grid h-5 w-5 place-items-center rounded-full border ${selectedPlan === "free" ? "border-palette-blue bg-palette-blue text-white" : "border-[#DCD2D5] text-transparent"}`}>
                <Icon name="check" className="h-3 w-3" />
              </span>
              <h2 className="mt-3 text-xl font-black">Free</h2>
              <p className="mt-1">
                <span className="text-sm font-black text-[#68718f]">SGD </span>
                <span className="text-[32px] font-black text-baby-lilac">0</span>
              </p>
              <p className="text-sm font-black text-[#9aa0b4]">Always free</p>
              <ul className="mt-3 space-y-1.5 text-sm font-semibold text-[#44507b]">
                {FREE_PLAN_ITEMS.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-palette-blue" /> {item}
                  </li>
                ))}
              </ul>
            </button>
          </div>

          <p className="mt-4 text-center text-xs font-semibold text-[#6D748A]">
            {/* QA 06/09 (vendor ticket, same root cause on the parent side):
                this used to promise "You won't be charged today... after the
                free month" — false since 9fd57da removed the free period, the
                first charge happens on sign-up. Fixed to say what actually
                happens. */}
            {selectedPlan === "plus"
              ? `${billing === "monthly" ? "This is a monthly subscription, charged today and renewing automatically each month." : "This is an annual subscription, charged today for 12 months at the price of 11. It renews automatically each year. Cancellations are not refunded pro rata."} Cancel at least 14 days before your renewal date. If you cancel with less than 14 days' notice you will be charged for the coming period. You keep access until the end of the period you have paid for. By continuing you agree to our `
              : "By continuing you agree to our "}
            <a href="/terms" target="_blank" rel="noreferrer" className="text-palette-blue underline">Terms &amp; Conditions</a>.
          </p>
        </>
      );
      break;
  }

  const progress = stepIndex / (steps.length - 1);
  // The gender screen answers on tap, so it has no Next button of its own.
  const hasNext = kind !== "plan" && kind !== "child-gender";

  return (
    <PageShell active="/onboarding">
      <div className="h-1 bg-[#FEEBF2]" aria-hidden="true">
        <div className="h-1 bg-[#FA4D8D]" style={{ width: `${Math.max(progress, 0.04) * 100}%` }} />
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); if (hasNext) next(); }}
        noValidate
        className={`mx-auto flex min-h-[calc(100dvh-80px)] flex-col px-6 pb-6 pt-4 sm:min-h-0 sm:pb-16 sm:pt-8 ${kind === "plan" ? "max-w-[680px]" : "max-w-[540px]"}`}
      >
        <div className="h-8">
          {stepIndex > 0 && (
            <button type="button" onClick={() => window.history.back()} className="text-sm font-black text-baby-pink hover:underline">
              ← Back
            </button>
          )}
        </div>

        {/* Keyed by screen so each one mounts fresh and its first field takes focus. */}
        <div key={current} className="mt-2">
          <h1 className="text-[28px] font-black leading-tight sm:text-[32px]">{title}</h1>
          {sub && <p className="mt-2 text-sm font-semibold text-[#44507b]">{sub}</p>}
          <div className="mt-6">{body}</div>
        </div>

        {/* The error sits directly above the button — QA found it at the top of
            the page where you had to scroll back up to see why nothing happened. */}
        {error && (
          <p role="alert" className="mt-5 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">
            {error}
          </p>
        )}

        {/* On a phone the button sits at the bottom of the screen, under the thumb. */}
        <div className="mt-auto pt-6 sm:mt-8">
          {hasNext && (
            <Button type="submit" size="lg" className="w-full justify-center">{cta}{cta !== "Skip" && " →"}</Button>
          )}
          {kind === "plan" && (
            <>
              <Button
                type="button"
                size="lg"
                onClick={() => submit(selectedPlan)}
                className="w-full justify-center"
                disabled={busy}
              >
                {busy
                  ? "Setting up…"
                  : selectedPlan === "plus"
                    ? "Start Plus →"
                    : "Create my account →"}
              </Button>
              {selectedPlan === "plus" && (
                <button
                  type="button"
                  onClick={() => submit("free")}
                  disabled={busy}
                  className="mt-3 w-full text-center text-sm font-bold text-[#6E748D] hover:text-[#59658d] disabled:opacity-50"
                >
                  I'll decide later — start on the Free plan
                </button>
              )}
            </>
          )}
          {kind === "name" && (
            <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">Already have an account? <a href="/login" className="font-black text-baby-pink">Log in</a></p>
          )}
        </div>
      </form>
    </PageShell>
  );
}
