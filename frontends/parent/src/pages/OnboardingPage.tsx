import { useEffect, useState } from "react";
import { PageShell, Button, Icon, DateInput } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { goTo } from "../lib/nav";
import {
  PASSWORD_RULES,
  dobError,
  emailError,
  passwordError,
  postcodeError,
} from "../lib/validation";
import { Chip, TIME_CHIPS, BUDGET_CHIPS, REGION_FILTERS, budgetRange } from "./prefChips";

type ChildDraft = { key: number; name: string; dob: string; gender: string; interests: string[] };

const newChildDraft = (): ChildDraft => ({
  key: Date.now() + Math.random(),
  name: "",
  dob: "",
  gender: "unspecified",
  interests: [],
});

/** One child's fields inside the sign-up form (repeated per child). */
function ChildDraftFields({
  draft,
  index,
  total,
  cats,
  onChange,
  onRemove,
}: {
  draft: ChildDraft;
  index: number;
  total: number;
  cats: { slug: string; name: string }[];
  onChange: (next: ChildDraft) => void;
  onRemove: () => void;
}) {
  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
  const toggle = (v: string) =>
    onChange({
      ...draft,
      interests: draft.interests.includes(v)
        ? draft.interests.filter((x) => x !== v)
        : [...draft.interests, v],
    });

  return (
    <div className={index > 0 ? "mt-5 border-t border-[#FEEBF2] pt-5" : ""}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-black">{total > 1 ? `Child ${index + 1}` : "Your child"}</h3>
        {total > 1 && (
          <button type="button" onClick={onRemove} className="text-xs font-bold text-[#FFC1D6] hover:underline">
            Remove
          </button>
        )}
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-black">Child's name</label>
          <input className={input} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="e.g. Emma" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-black">Date of birth</label>
          <DateInput
            value={draft.dob}
            onChange={(iso) => onChange({ ...draft, dob: iso })}
            className={input}
          />
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Day first, e.g. 14/03/2024.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[["male", "Boy"], ["female", "Girl"], ["unspecified", "Prefer not to say"]].map(([v, l]) => (
            <Chip key={v} on={draft.gender === v} onClick={() => onChange({ ...draft, gender: v })}>{l}</Chip>
          ))}
        </div>
        <div>
          <p className="mb-1 text-sm font-black">Interests</p>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => (
              <Chip key={c.slug} on={draft.interests.includes(c.slug)} onClick={() => toggle(c.slug)}>{c.name}</Chip>
            ))}
          </div>
        </div>
      </div>
    </div>
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
  /* QA 04/09: marketing consent at account creation. Optional and unticked by
     default — it is a permission, not a condition of signing up, so it never
     blocks the form (unlike the Terms checkbox above). */
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [emailExists, setEmailExists] = useState(false);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";

  /** Everything recommendations depend on is required, so a new parent can't
   *  land on an empty Matches page. Returns the first problem, or null. */
  function validate(): string | null {
    if (!fullName.trim()) return "Please add your full name.";
    const emailProblem = emailError(email);
    if (emailProblem) return emailProblem;
    const pwProblem = passwordError(password);
    if (pwProblem) return pwProblem;
    if (password !== confirmPassword) return "Passwords don't match — please re-enter them.";
    const postcodeProblem = postcodeError(postcode);
    if (postcodeProblem) return postcodeProblem;
    if (regions.length === 0) return "Pick at least one area you'd like activities in.";
    for (const [i, k] of kids.entries()) {
      const who = kids.length > 1 ? `Child ${i + 1}` : "Your child";
      if (!k.name.trim()) return `${who} needs a name.`;
      const dobProblem = dobError(k.dob);
      if (dobProblem) return `${who}: ${dobProblem.charAt(0).toLowerCase()}${dobProblem.slice(1)}`;
      if (k.interests.length === 0) return `Pick at least one interest for ${k.name.trim() || who.toLowerCase()}.`;
    }
    if (!acceptedTerms) return "Please accept the Terms & Conditions and Privacy Policy to continue.";
    return null;
  }

  async function submit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);

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
    });
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
      setBusy(false);
      return setConfirmSent(true); // email confirmation required
    }
    const uid = session.user.id;
    await supabase.from("parent_profiles").update({
      full_name: fullName,
      phone: phone || null,
      postal_code: postcode.trim(),
      terms_accepted_at: new Date().toISOString(),
      // Only written when actually ticked — a null here means no consent, and
      // that is the state every account starts in.
      ...(marketingConsent ? { marketing_consent_at: new Date().toISOString() } : {}),
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
    // Fresh sign-in plus brand-new children — reboot so every hook picks up
    // the new auth and profile state from scratch.
    goTo("/matches", { hard: true });
  }

  if (confirmSent) {
    return (
      <PageShell active="/onboarding">
        <main className="mx-auto max-w-[460px] px-6 py-16 text-center">
          <h1 className="text-2xl font-black">Check your email</h1>
          <p className="mt-3 font-semibold text-[#44507b]">We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account — it'll bring you straight back to your profile.</p>
          <p className="mt-3 text-sm font-semibold text-[#6D748D]">Can't find it? Check your spam folder.</p>
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
            <button type="button" onClick={() => setEmailExists(false)} className="font-black text-baby-pink underline">
              Use a different email
            </button>
          </p>
        </main>
      </PageShell>
    );
  }

  return (
    <PageShell active="/onboarding">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <section className="rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h1 className="text-[26px] font-black">Let's get to know <span className="text-baby-pink">you</span></h1>
          <p className="mt-1 text-sm font-semibold text-[#44507b]">Allow us to suggest activities that are a great fit for your family.</p>
          <div className="mt-5 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Sarah Tan" /></div>
            <div><label className="mb-1 block text-sm font-black">Email address</label><input type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. sarah@gmail.com" /></div>
            <div>
              <label className="mb-1 block text-sm font-black">Password</label>
              <input type="password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password" />
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
            <div><label className="mb-1 block text-sm font-black">Confirm password</label><input type="password" className={input} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter your password" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div>
                <label className="mb-1 block text-sm font-black">Postcode</label>
                <input className={input} inputMode="numeric" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} placeholder="307591" />
                <p className="mt-1 text-xs font-semibold text-[#6D748D]">Used to show what's near you.</p>
              </div>
            </div>
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="pin" className="h-4 w-4 text-baby-pink" /> Areas you'd like activities in</h2>
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Pick any areas that work for you — they don't have to be near home.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGION_FILTERS.map(([v, l]) => (
              <Chip key={v} on={regions.includes(v)} onClick={() => toggle(regions, v, setRegions)}>{l}</Chip>
            ))}
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="heart" className="h-4 w-4 text-baby-pink" /> Your preferences</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip on={weekdays} onClick={() => setWeekdays(!weekdays)}>Weekdays</Chip>
            <Chip on={weekend} onClick={() => setWeekend(!weekend)}>Weekend</Chip>
            {TIME_CHIPS.map(([v, l]) => <Chip key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Chip>)}
            {BUDGET_CHIPS.map(([k, l]) => <Chip key={k} on={budgets.includes(k)} onClick={() => toggle(budgets, k, setBudgets)}>{l}</Chip>)}
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h1 className="text-[26px] font-black">Tell us about your <span className="text-baby-pink">{kids.length > 1 ? "children" : "child"}</span></h1>
          <div className="mt-4">
            {kids.map((k, i) => (
              <ChildDraftFields
                key={k.key}
                draft={k}
                index={i}
                total={kids.length}
                cats={cats}
                onChange={(next) => setKids((xs) => xs.map((x) => (x.key === k.key ? next : x)))}
                onRemove={() => setKids((xs) => xs.filter((x) => x.key !== k.key))}
              />
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={() => setKids((xs) => [...xs, newChildDraft()])}
          >
            <Icon name="user" className="h-4 w-4" /> Add another child
          </Button>
        </section>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#FEE9D7] bg-white p-4 text-sm font-semibold text-[#44507b]">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-baby-pink"
          />
          <span>
            I agree to BabyBrain's{" "}
            <a href="/terms" target="_blank" rel="noreferrer" className="font-black text-baby-pink underline">Terms &amp; Conditions</a>{" "}
            and{" "}
            <a href="/terms#privacy" target="_blank" rel="noreferrer" className="font-black text-baby-pink underline">Privacy Policy</a>.
          </span>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#FEE9D7] bg-white p-4 text-sm font-semibold text-[#44507b]">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => setMarketingConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-baby-pink"
          />
          <span>
            I agree and consent to receive marketing communications from BabyBrain to update me on
            offers, promotions, discounts, events, news, etc. relating to BabyBrain's products and
            services via any means of communication such as via email.
          </span>
        </label>

        {/* The error sits directly above the CTA — QA found it at the top of the
            page where you had to scroll back up to see why nothing happened. */}
        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">
            {error}
          </p>
        )}

        <Button type="button" onClick={submit} className="mt-3 w-full justify-center" disabled={busy}>{busy ? "Setting up…" : "Show me options →"}</Button>
        <p className="mt-3 text-center text-sm font-semibold text-[#5a6690]">Already have an account? <a href="/login" className="font-black text-baby-pink">Log in</a></p>
      </main>
    </PageShell>
  );
}
