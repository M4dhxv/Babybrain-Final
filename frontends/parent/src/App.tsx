import {
  ActivityCard,
  ActivityRow,
  AnimalAvatar,
  Button,
  BrandStacked,
  CategoryTile,
  Confetti,
  DateInput,
  Footer,
  Icon,
  MiniActivityGrid,
  PageShell,
  SectionTitle,
} from "./components/ui";
import { useEffect, useState } from "react";
import { categories } from "./data/content";
import { useActivities } from "./lib/useActivities";
import { useAuth } from "./auth/AuthProvider";
import {
  useActivityDetail,
  useFavorite,
  usePlan,
  useRecommendations,
  useJourney,
  invalidatePlan,
  toCard,
} from "./lib/data";
import { supabase } from "./lib/supabase";
import { apiGet, apiPost } from "./lib/api";
import { downloadBookingIcs, downloadScheduleIcs } from "./lib/ics";
import { downloadSchedulePdf } from "./lib/schedule-pdf";
import { formatChildAge, formatAgeRange, formatDuration, regionLabel } from "./lib/database.types";
import {
  MIN_CHILD_DOB,
  PASSWORD_RULES,
  dobError,
  emailError,
  passwordError,
  postcodeError,
  todayIso,
} from "./lib/validation";
import type { ActivitySession, Child, Gender } from "./lib/database.types";
import { EnquiryChat } from "./components/EnquiryChat";
import { ClassGroupChat } from "./components/ClassGroupChat";
import { ExploreMap } from "./components/ExploreMap";
import { SupportChat } from "./components/SupportChat";

function getParam(name: string) {
  return new URLSearchParams(window.location.search).get(name);
}

function HomePage() {
  return (
    <PageShell active="/" auth="public">
      <main>
        <section className="mx-auto grid max-w-[1120px] items-center gap-8 px-6 pb-4 pt-6 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[#ffe9f2] px-4 py-2.5 text-[13px] font-bold text-baby-pink">
              <Icon name="heart" className="h-4 w-4" /> Made by a parent, for parents.
            </div>
            <h1 className="max-w-[520px] text-[40px] font-black leading-[1.04] md:text-[52px]">
              Curated activities for{" "}
              <span className="text-baby-pink">your child</span>
            </h1>
            <p className="mt-5 max-w-[460px] text-[17px] font-semibold leading-7 text-[#27325f]">
              Discover &amp; book classes, play spaces and events tailored to
              your little one and convenient for you.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Button href="/explore" size="lg">
                Start searching <span>›</span>
              </Button>
              <Button href="/onboarding" variant="outline" size="lg">
                Create profile <Icon name="user" className="h-[18px] w-[18px]" />
              </Button>
            </div>
          </div>
          <div className="relative min-h-[370px]">
            <div className="absolute -left-6 top-40 h-14 w-14 rounded-full bg-[#c7a7ff]" />
            <Icon name="star" className="absolute right-[-18px] top-14 h-8 w-8 fill-[#ffbd30] text-[#ffbd30]" />
            <img
              src={`${import.meta.env.BASE_URL}assets/crops/hero-mom-child.png`}
              alt="Mother and child playing with educational toys"
              className="relative z-10 h-[370px] w-full rounded-[100px_74px_82px_52px] object-cover shadow-soft"
            />
          </div>
        </section>

        <section className="mx-auto grid max-w-[1120px] gap-4 px-6 py-4 md:grid-cols-3">
          {[
            ["search", "Find activities", "Selected to meet a range of kid's needs."],
            ["shield", "Trusted providers", "We partner with verified providers."],
            ["calendar", "Plan with ease", "Book activities that suit you."],
          ].map(([icon, title, copy]) => (
            <div key={title} className="flex items-center gap-4">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#ffe4ef] to-[#fff0f5] text-baby-pink">
                <Icon name={icon} className="h-8 w-8" />
              </span>
              <p>
                <strong className="block text-base font-black">{title}</strong>
                <span className="text-sm font-semibold leading-6 text-[#3f4b78]">{copy}</span>
              </p>
            </div>
          ))}
        </section>

        <section id="how-it-works" className="mx-auto max-w-[1120px] scroll-mt-24 px-6 py-3">
          <div className="rounded-[22px] border border-[#e8ecf6] bg-white/80 p-5 shadow-card">
            <h2 className="text-center text-[26px] font-black text-baby-orange">
              How it works <Icon name="spark" className="inline h-5 w-5 text-baby-pink" />
            </h2>
            <p className="text-center text-sm font-semibold text-[#46527d]">
              Three simple steps to help you identify &amp; book activities ideal for your child.
            </p>
            <div className="mt-5 grid gap-5 md:grid-cols-3">
              {[
                ["1", "how-step-1", "Tell us what you're looking for", "Share details about your child's age, interests and the location you're looking for."],
                ["2", "how-step-2", "Discover activities", "Browse curated activities that match your preferences."],
                ["3", "how-step-3", "Plan and book", "Choose what works for you and book direct or via the provider's website."],
              ].map(([step, art, title, copy]) => (
                <article key={title} className="text-center">
                  <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-baby-lilac text-base font-black text-white">
                    {step}
                  </span>
                  <div className="mx-auto my-2 grid h-20 place-items-center">
                    <img src={`${import.meta.env.BASE_URL}assets/crops/${art}.png`} alt="" className="h-full object-contain" />
                  </div>
                  <h3 className="text-lg font-black">{title}</h3>
                  <p className="mx-auto mt-2 max-w-[230px] text-sm font-semibold leading-6 text-[#46527d]">
                    {copy}
                  </p>
                </article>
              ))}
            </div>
            <div className="mt-5 grid gap-3 rounded-[18px] border border-[#e8ecf6] bg-white p-3 md:grid-cols-3">
              {[
                ["people", "1000+", "Curated activities"],
                ["store", "100+", "Verified providers"],
                ["chart", "200+", "Locations"],
              ].map(([icon, stat, label]) => (
                <div key={stat} className="flex items-center justify-center gap-3">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-[#fff0f7] text-baby-pink">
                    <Icon name={icon} className="h-7 w-7" />
                  </span>
                  <p>
                    <strong className="block text-2xl font-black text-baby-pink">{stat}</strong>
                    <span className="text-sm font-semibold">{label}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <SectionTitle>Explore activities by age</SectionTitle>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {/* Drawn from AGE_BANDS so these tiles can't drift out of step with
                the Explore filter — they used to say "0 – 6 months" but link to
                ?age=6, which lands on the 6–17 month band. */}
            {AGE_BANDS.map((band, i) => (
              <a
                key={band.key}
                href={`/explore?age=${band.key}`}
                className="flex min-h-[92px] flex-col justify-center rounded-[16px] border border-[#e9edf7] bg-gradient-to-br from-[#fff0f7] to-[#f0f7ff] px-4 py-3 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-soft"
              >
                <span className="text-[15px] font-black leading-tight text-baby-lilac">{band.label}</span>
                <span className="mt-1 text-[12px] font-semibold leading-4 text-[#59658d]">{AGE_BAND_COPY[i]}</span>
              </a>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <SectionTitle>Explore activities by type</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label, , slug]) => (
              <CategoryTile key={label} icon={icon} label={label} href={`/explore?cat=${slug}`} />
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <SectionTitle
            action={<a href="/explore" className="font-bold text-baby-pink">View all activities ›</a>}
          >
            Activities near you
          </SectionTitle>
          <MiniActivityGrid />
        </section>

        <section className="mx-auto grid max-w-[1120px] gap-4 px-6 py-3 md:grid-cols-3">
          {["Joanne", "Marcus", "Sarah"].map((name, index) => (
            <article key={name} className="flex gap-4 rounded-[16px] border border-[#e8ecf6] bg-white p-5 shadow-card">
              <AnimalAvatar seed={name} kind="parent" className="h-11 w-11" />
              <div>
                <div className="flex gap-0.5 text-[#ffb71b]">{Array.from({ length: 5 }).map((_, starIndex) => <Icon key={starIndex} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
                <p className="mt-2 text-sm font-semibold leading-6">
                  {index === 0
                    ? "We found so many engaging activities that our daughter loves."
                    : index === 1
                      ? "Easy to use and saves us so much time planning weekends."
                      : "A great platform to discover new activities and local gems."}
                </p>
                <strong className="mt-3 block text-sm">{name}</strong>
                <span className="text-xs font-semibold text-[#6b759a]">Mum of {index + 2}.5 year old</span>
              </div>
            </article>
          ))}
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <div className="grid items-center gap-6 overflow-hidden rounded-[18px] border border-[#eadcf8] bg-gradient-to-r from-[#fff0f7] via-white to-[#f2edff] px-10 py-5 md:grid-cols-[220px_1fr_280px]">
            <img src={`${import.meta.env.BASE_URL}assets/crops/baby-character.png`} alt="" className="h-28 object-contain object-left" />
            <div>
              <h2 className="text-2xl font-black">Reduce your mental load</h2>
              <p className="mt-1 font-semibold text-[#4e5982]">We make it quicker &amp; easier to plan activities for your little ones.</p>
            </div>
            <Button href="/onboarding" size="lg">Get started ›</Button>
          </div>
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

function Field({ label, placeholder }: { label: string; placeholder: string }) {
  return (
    <label className="block text-xs font-black">
      {label}
      <input
        className="mt-2 h-10 w-full rounded-[8px] border border-[#dfe5f2] bg-white px-3 text-sm font-semibold outline-none focus:border-baby-pink"
        placeholder={placeholder}
      />
    </label>
  );
}

const TIME_CHIPS: [string, string][] = [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"]];
const BUDGET_CHIPS: [string, string, number | null, number | null][] = [
  ["u40", "Under $40", 0, 40],
  ["40-80", "$40 - $80", 40, 80],
  ["80-120", "$80 - $120", 80, 120],
  ["120+", "$120+", 120, null],
];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-[8px] border px-3 py-2 text-xs font-bold ${on ? "border-baby-pink bg-[#ffe9f2] text-[#FA5D93]" : "border-[#e2e7f4] bg-white"}`}>
      {children}
    </button>
  );
}

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
  const input = "h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 text-sm font-semibold";
  const toggle = (v: string) =>
    onChange({
      ...draft,
      interests: draft.interests.includes(v)
        ? draft.interests.filter((x) => x !== v)
        : [...draft.interests, v],
    });

  return (
    <div className={index > 0 ? "mt-5 border-t border-[#f0e6ec] pt-5" : ""}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-black">{total > 1 ? `Child ${index + 1}` : "Your child"}</h3>
        {total > 1 && (
          <button type="button" onClick={onRemove} className="text-xs font-bold text-[#b00040] hover:underline">
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
            min={MIN_CHILD_DOB}
            max={todayIso()}
            className={input}
          />
          <p className="mt-1 text-xs font-semibold text-[#8a93b2]">Day first, e.g. 14/03/2024.</p>
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

function OnboardingPage() {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 text-sm font-semibold";

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
    const { error: signErr } = await signUp(email, password, fullName);
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
    const days = [...(weekdays ? ["mon", "tue", "wed", "thu", "fri"] : []), ...(weekend ? ["sat", "sun"] : [])];
    const chosenBudgets = BUDGET_CHIPS.filter(([k]) => budgets.includes(k));
    const budgetMin = chosenBudgets.length ? Math.min(...chosenBudgets.map(([, , lo]) => lo ?? 0)) : null;
    const budgetMax = chosenBudgets.length && chosenBudgets.every(([, , , hi]) => hi != null)
      ? Math.max(...chosenBudgets.map(([, , , hi]) => hi as number))
      : null;
    // Interests across all children drive the parent-level recommendations.
    const allInterests = [...new Set(kids.flatMap((k) => k.interests))];
    await supabase.from("parent_profiles").update({
      full_name: fullName,
      phone: phone || null,
      postal_code: postcode.trim(),
      terms_accepted_at: new Date().toISOString(),
    }).eq("id", uid);
    await supabase.from("user_preferences").update({
      preferred_days: days as never,
      preferred_times: times as never,
      preferred_regions: regions as never,
      budget_min: budgetMin,
      budget_max: budgetMax,
      interests: allInterests,
    }).eq("user_id", uid);
    await supabase.from("children").insert(
      kids.map((k) => ({
        parent_id: uid,
        name: k.name.trim(),
        date_of_birth: k.dob,
        gender: k.gender as never,
        interests: k.interests,
        notes: null,
      }))
    );
    window.location.href = "/matches";
  }

  if (confirmSent) {
    return (
      <PageShell active="/onboarding">
        <main className="mx-auto max-w-[460px] px-6 py-16 text-center">
          <h1 className="text-2xl font-black">Check your email</h1>
          <p className="mt-3 font-semibold text-[#44507b]">We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account — it'll bring you straight back to your profile.</p>
          <p className="mt-3 text-sm font-semibold text-[#8a93b2]">Can't find it? Check your spam folder.</p>
          <Button href="/login" className="mt-5">Go to log in</Button>
        </main>
      </PageShell>
    );
  }

  return (
    <PageShell active="/onboarding">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <section className="rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h1 className="text-[26px] font-black">Let's get to know you</h1>
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
                    <li key={rule.label} className={met ? "text-[#1f9d4d]" : "text-[#8a93b2]"}>
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
                <p className="mt-1 text-xs font-semibold text-[#8a93b2]">Used to show what's near you.</p>
              </div>
            </div>
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="pin" className="h-4 w-4 text-baby-pink" /> Areas you'd like activities in</h2>
          <p className="mt-1 text-xs font-semibold text-[#8a93b2]">Pick any areas that work for you — they don't have to be near home.</p>
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

        <section className="mt-4 rounded-[14px] border border-[#eadfd2] bg-white p-5">
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

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#eadfd2] bg-white p-4 text-sm font-semibold text-[#44507b]">
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

        {/* The error sits directly above the CTA — QA found it at the top of the
            page where you had to scroll back up to see why nothing happened. */}
        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#ffd2de] bg-[#ffe9ef] px-4 py-3 text-sm font-bold text-[#b00040]">
            {error}
          </p>
        )}

        <Button type="button" onClick={submit} className="mt-3 w-full justify-center" disabled={busy}>{busy ? "Setting up…" : "Show me options →"}</Button>
        <p className="mt-3 text-center text-sm font-semibold text-[#5a6690]">Already have an account? <a href="/login" className="font-black text-baby-pink">Log in</a></p>
      </main>
    </PageShell>
  );
}

function MatchesPage({ active = "/matches" }: { active?: string }) {
  const { session, profile, children, loading } = useAuth();
  const { data: recsByChild, loading: recsLoading } = useRecommendations(children);

  if (!loading && !session) {
    return (
      <PageShell active={active}>
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Log in to see your matches.</p>
          <Button href="/login" className="mt-4">Log in</Button>
        </main>
      </PageShell>
    );
  }
  if (!loading && children.length === 0) {
    return (
      <PageShell active={active}>
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Tell us about your child to get matches.</p>
          <Button href="/onboarding" className="mt-4">Complete your profile</Button>
        </main>
      </PageShell>
    );
  }

  const first = recsByChild[0];
  const child = first?.child;
  const reasons = first ? [...new Set(first.recs.slice(0, 4).flatMap((r) => r.reasons))].slice(0, 4) : [];
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  return (
    <PageShell active={active}>
      <main className="mx-auto max-w-[1180px] px-6 py-6">
        <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="grid items-center gap-6 lg:grid-cols-[1fr_340px]">
            <div>
              <p className="text-base font-bold">Hi {firstName}!</p>
              <h1 className="mt-2 text-[36px] font-black leading-tight">
                Here are some suggested activities for <span className="text-baby-lilac">{child?.name ?? "your child"}</span>
              </h1>
              <p className="mt-4 text-[17px] font-semibold text-[#47527d]">Based on age, interests and your preferences.</p>
              <Button href="/explore" className="mt-5">Explore activities →</Button>
            </div>
            {child && (
              <article className="flex gap-4 rounded-[18px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                <AnimalAvatar seed={child.name} kind="child" className="h-32 w-32 ring-8 ring-[#fff1f5]" />
                <div>
                  <h2 className="text-xl font-black">{child.name}</h2>
                  <p className="mb-3 font-bold">{formatChildAge(child.date_of_birth)}</p>
                  {child.interests.map((item) => (
                    <p key={item} className="mb-1.5 rounded-full bg-[#f7f4ef] px-3 py-1.5 text-xs font-bold text-[#596184]">enjoys {item.replace(/-/g, " ")}</p>
                  ))}
                </div>
              </article>
            )}
          </div>
          <article className="rounded-[18px] border border-[#e7ebf6] bg-white p-5 shadow-card">
            <h2 className="text-2xl font-black text-baby-lilac">Why these activities?</h2>
            <p className="mb-4 mt-1 font-semibold text-[#4b5681]">These activities match what you've shared with us.</p>
            <div className="grid grid-cols-[1fr_150px] items-center gap-4">
              <div className="space-y-3">
                {reasons.length > 0 ? reasons.map((item) => (
                  <p key={item} className="text-sm font-semibold leading-5"><strong className="block">{item}</strong></p>
                )) : (
                  <p className="text-sm font-semibold text-[#5a648b]">Add your preferences in onboarding to sharpen these matches.</p>
                )}
              </div>
              <img src={`${import.meta.env.BASE_URL}assets/crops/baby-character.png`} alt="" className="h-36 object-contain" />
            </div>
          </article>
        </section>

        <section className="mt-6">
          {/* On mobile the "See activity options" link sits below the cards
              rather than crowding the heading. */}
          <SectionTitle
            action={<a href="/explore" className="hidden font-bold text-[#FA5D93] sm:inline">Explore more activities →</a>}
          >
            Matching activities
          </SectionTitle>
          {recsLoading ? (
            <p className="font-bold text-[#5a6690]">Loading matches…</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {(first?.recs ?? []).slice(0, 4).map((r) =>
                r.activity ? <ActivityCard key={r.id} activity={{ ...toCard(r.activity), note: r.reasons[0] ?? "" }} /> : null
              )}
              {first && first.recs.length === 0 && <p className="font-semibold text-[#68718f]">No matches yet — new activities are added regularly.</p>}
            </div>
          )}
          <a href="/explore" className="mt-4 block text-center font-bold text-[#FA5D93] sm:hidden">Explore more activities →</a>
        </section>

        <section className="mt-6">
          <SectionTitle>Explore activities by type</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label, copy, slug]) => (
              <CategoryTile key={label} icon={icon} label={label} copy={copy} href={`/explore?cat=${slug}`} />
            ))}
          </div>
        </section>
      </main>
    </PageShell>
  );
}

// Age bands, as brackets rather than a single "child is N months old" probe.
// The old filter matched any class whose range *contained* the age, so picking
// "0 – 6 months" surfaced classes running up to 2 years. A band matches only
// when the class's own age range overlaps it.
const AGE_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "0-5", label: "0 – 5 months", min: 0, max: 5 },
  { key: "6-17", label: "6 – 17 months", min: 6, max: 17 },
  { key: "18-35", label: "18 months – 3 years", min: 18, max: 35 },
  { key: "36+", label: "Over 3 years", min: 36, max: 132 },
];
/** Marketing sub-line for each band, used by the home page tiles. */
const AGE_BAND_COPY = ["Social awakening", "Curious little movers", "Busy toddlers", "Confident explorers"];

// Singapore areas. These now come from the listing itself (derived from its
// postal sector — see migration 00032), so listings without coordinates are
// still filterable.
const REGION_FILTERS: [string, string][] = [
  ["central", "Central"],
  ["east", "East"],
  ["north-east", "North-East"],
  ["north", "North"],
  ["west", "West"],
  ["sentosa", "Sentosa"],
];
/** Hour of day (0–23) of an ISO timestamp, in Singapore time. */
function sgHour(iso?: string | null): number | null {
  if (!iso) return null;
  const h = new Date(iso).toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", hour12: false });
  const n = Number(h);
  return Number.isFinite(n) ? n % 24 : null;
}
const PRICE_MAX = 200; // slider ceiling; at the ceiling the price filter is "Any".
const timeLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

const LEAD_KEY = "bb_lead_captured";

/** One-time email-capture modal shown when a visitor starts exploring. Skipped
 *  for signed-in users (we already have their email) and once dismissed or
 *  submitted (remembered in localStorage). Leads land in the `leads` table. */
function EmailCapturePopup() {
  const { session, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || session) return;
    if (localStorage.getItem(LEAD_KEY)) return;
    const t = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(t);
  }, [loading, session]);

  function dismiss() {
    localStorage.setItem(LEAD_KEY, "dismissed");
    setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError("Please enter a valid email."); return; }
    setBusy(true); setError(null);
    const { error } = await supabase.from("leads").insert({ email, source: "explore-popup" });
    setBusy(false);
    if (error) { setError("Something went wrong — please try again."); return; }
    localStorage.setItem(LEAD_KEY, "submitted");
    setDone(true);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={dismiss}>
      <div className="w-full max-w-md rounded-[20px] bg-white p-7 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={dismiss} aria-label="Close" className="float-right -mr-1 -mt-1 text-[#9aa3c0] hover:text-[#3a4468]">
          <Icon name="close" className="h-5 w-5" />
        </button>
        {done ? (
          <div className="py-4 text-center">
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#eafaf0] text-[#28a765]"><Icon name="check" className="h-8 w-8" /></div>
            <h2 className="text-xl font-black">You're on the list! 🎉</h2>
            <p className="mt-2 text-sm font-semibold text-[#59658d]">We'll send you activity ideas matched to your family.</p>
            <Button className="mt-5 w-full" onClick={dismiss}>Start exploring</Button>
          </div>
        ) : (
          <>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[#ffe9f2] px-3 py-1.5 text-xs font-bold text-baby-pink"><Icon name="heart" className="h-3.5 w-3.5" /> Made for your family</div>
            <h2 className="text-2xl font-black leading-tight">Get activity ideas for your child</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-[#59658d]">Pop in your email and we'll send curated classes and play spaces near you — no spam, unsubscribe anytime.</p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                autoFocus
                className="h-12 w-full rounded-[12px] border border-[#e6e6ef] px-4 font-semibold shadow-card focus:border-baby-pink focus:outline-none"
              />
              {error && <p className="text-sm font-semibold text-baby-pink">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Send me ideas"}</Button>
            </form>
            <button type="button" onClick={dismiss} className="mt-3 w-full text-center text-xs font-bold text-[#8b93b3] hover:text-[#59658d]">Maybe later</button>
          </>
        )}
      </div>
    </div>
  );
}

/** A row of multi-select filter chips with an "all" reset at the front. */
function ChipFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-[#68718f]">{label}</p>
      <div className="flex flex-wrap gap-2">
        <Chip on={selected.length === 0} onClick={() => onChange([])}>{allLabel}</Chip>
        {options.map((o) => (
          <Chip
            key={o.key}
            on={selected.includes(o.key)}
            onClick={() =>
              onChange(
                selected.includes(o.key)
                  ? selected.filter((k) => k !== o.key)
                  : [...selected, o.key]
              )
            }
          >
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function ExplorePage() {
  // "Top rated" and "Most popular" read the same to parents, so popularity now
  // covers both; the other two sorts are the ones QA asked for.
  const [sort, setSort] = useState<"popular" | "distance" | "soonest">("popular");
  // Seed from the query string so home-page tiles and header search land on a
  // pre-filtered list.
  const [categories_, setCategories] = useState<string[]>(() => {
    const c = getParam("cat");
    return c ? [c] : [];
  });
  const [ages, setAges] = useState<string[]>(() => {
    const a = getParam("age");
    if (!a) return [];
    // Home tiles pass a band key; older emails pass ?age=<months>.
    if (AGE_BANDS.some((b) => b.key === a)) return [a];
    const band = AGE_BANDS.find((b) => Number(a) >= b.min && Number(a) <= b.max);
    return band ? [band.key] : [];
  });
  const [regions, setRegions] = useState<string[]>([]);
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [timeRange, setTimeRange] = useState<[number, number]>([0, 23]);
  const [maxPrice, setMaxPrice] = useState(PRICE_MAX);
  const [showMore, setShowMore] = useState(false);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const query = getParam("q");

  // Categories, ages and areas are all multi-select now, so we fetch the whole
  // published set once (it's a few hundred rows) and filter in the browser.
  const { activities, loading } = useActivities({
    limit: 500,
    sort: sort === "distance" ? "distance" : "popular",
    query: query || null,
  });

  const [minH, maxH] = timeRange;
  const priceActive = maxPrice < PRICE_MAX;
  const timeActive = minH > 0 || maxH < 23;
  const anyFilter =
    categories_.length > 0 || ages.length > 0 || regions.length > 0 ||
    !!dateFrom || priceActive || timeActive;

  const selectedBands = AGE_BANDS.filter((b) => ages.includes(b.key));

  const filtered = activities.filter((a) => {
    if (categories_.length && !categories_.includes(catSlugOf(a, cats))) return false;
    // A class matches an age band when its own range overlaps that band.
    if (selectedBands.length &&
        !selectedBands.some((b) => a.ageMinMonths <= b.max && a.ageMaxMonths >= b.min)) return false;
    if (regions.length) {
      const inRegion =
        (a.region && regions.includes(a.region)) ||
        a.venues.some((v) => v.region && regions.includes(v.region));
      if (!inRegion) return false;
    }
    if (priceActive && a.price != null && a.price > maxPrice) return false;
    if (dateFrom) {
      if (!a.nextSessionAt) return false;
      if (new Date(a.nextSessionAt) < new Date(`${dateFrom}T00:00:00+08:00`)) return false;
    }
    if (timeActive) {
      const h = sgHour(a.nextSessionAt);
      if (h == null || h < minH || h > maxH) return false;
    }
    return true;
  });

  // "Nearest" and "Starting soonest" re-order what the server returned, but
  // instant-book listings still lead so parents stay on platform.
  const shown = [...filtered].sort((x, y) => {
    if (x.instantBook !== y.instantBook) return x.instantBook ? -1 : 1;
    if (sort === "soonest") {
      const ax = x.nextSessionAt ? Date.parse(x.nextSessionAt) : Infinity;
      const ay = y.nextSessionAt ? Date.parse(y.nextSessionAt) : Infinity;
      return ax - ay;
    }
    if (sort === "distance" && here) {
      return distanceFrom(here, x) - distanceFrom(here, y);
    }
    return 0;
  });

  function resetFilters() {
    setCategories([]); setAges([]); setRegions([]);
    setDateFrom(""); setTimeRange([0, 23]); setMaxPrice(PRICE_MAX);
  }

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  // Sorting by distance needs a location; ask only when it's chosen.
  useEffect(() => {
    if (sort !== "distance" || here || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setHere(null),
      { timeout: 8000 }
    );
  }, [sort, here]);

  const selectClass = "h-10 rounded-[10px] border border-[#e6e6ef] bg-white px-3 text-[13px] font-bold shadow-card focus:border-baby-pink focus:outline-none";
  const pinned = shown.filter((a) => a.venues.length > 0 || a.lat != null).length;

  return (
    <PageShell active="/explore">
      <EmailCapturePopup />
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[28px] font-black text-baby-green sm:text-[34px]">Explore activities <Icon name="spark" className="inline h-6 w-6 text-baby-green" /></h1>
            <p className="mt-1 text-base font-semibold text-[#4a5680] sm:text-lg">
              {query ? <>Results for “{query}”. <a href="/explore" className="font-black text-baby-pink">Clear search</a></> : "Browse activities across Singapore."}
            </p>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/explore-skyline.png`} alt="" className="hidden h-24 object-contain md:block lg:h-28" />
        </div>

        <div className="mb-4 space-y-3 rounded-[16px] border border-[#e7ebf6] bg-white p-4 shadow-card">
          <ChipFilter
            label="Type of activity"
            allLabel="All types of activity"
            options={cats.map((c) => ({ key: c.slug, label: c.name }))}
            selected={categories_}
            onChange={setCategories}
          />
          <ChipFilter
            label="Age"
            allLabel="All ages"
            options={AGE_BANDS.map((b) => ({ key: b.key, label: b.label }))}
            selected={ages}
            onChange={setAges}
          />
          <ChipFilter
            label="Area"
            allLabel="All areas"
            options={REGION_FILTERS.map(([k, l]) => ({ key: k, label: l }))}
            selected={regions}
            onChange={setRegions}
          />

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[#eef1f7] pt-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-[#68718f]">Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={selectClass}>
                <option value="popular">Most popular</option>
                <option value="distance">Nearest</option>
                <option value="soonest">Starting soonest</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="h-10 rounded-[10px] border border-[#e6e6ef] bg-white px-4 text-[13px] font-bold text-[#4a5680] hover:border-baby-pink"
            >
              {showMore ? "Fewer filters ▲" : "More filters ▾"}
            </button>
            {anyFilter && (
              <button type="button" onClick={resetFilters} className="h-10 text-xs font-bold text-baby-pink hover:underline">
                Reset filters
              </button>
            )}
          </div>

          {sort === "distance" && !here && (
            <p className="rounded-[10px] bg-[#fff7fb] px-3 py-2 text-xs font-semibold text-[#68718f]">
              Allow location access to sort by how near activities are to you.
            </p>
          )}

          {showMore && (
            <div className="grid gap-3 border-t border-[#eef1f7] pt-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-[#68718f]">Date from</span>
                <DateInput value={dateFrom} onChange={setDateFrom} className={`${selectClass} w-full`} />
              </label>
              <label className="flex flex-col justify-center gap-1">
                <span className="flex justify-between text-xs font-bold text-[#68718f]"><span>Price</span><span className="text-baby-pink">{priceActive ? `Up to $${maxPrice}` : "Any"}</span></span>
                <input type="range" min={0} max={PRICE_MAX} step={10} value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} className="mt-2 h-2 w-full accent-baby-pink" />
              </label>
              <label className="flex flex-col justify-center gap-1">
                <span className="flex justify-between text-xs font-bold text-[#68718f]"><span>Time</span><span className="text-baby-pink">{timeActive ? `${timeLabel(minH)}–${timeLabel(maxH)}` : "Any"}</span></span>
                <div className="mt-1 flex items-center gap-2">
                  <input type="range" min={0} max={23} value={minH} onChange={(e) => setTimeRange([Math.min(Number(e.target.value), maxH), maxH])} className="h-2 w-full accent-baby-pink" />
                  <input type="range" min={0} max={23} value={maxH} onChange={(e) => setTimeRange([minH, Math.max(Number(e.target.value), minH)])} className="h-2 w-full accent-baby-pink" />
                </div>
              </label>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <section className="rounded-[16px] border border-[#e7ebf6] bg-white p-3 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-baby-green">Explore on map</h2>
              <span className="text-xs font-bold text-[#68718f]">{pinned} of {shown.length} pinned</span>
            </div>
            <div className="relative overflow-hidden rounded-[12px]">
              <ExploreMap activities={shown} />
            </div>
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-black">{loading ? "Loading…" : `${shown.length} activities found`}</p>
            </div>
            <div className="grid gap-2.5 xl:grid-cols-2">
              {shown.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </div>
            {!loading && shown.length === 0 && (
              <p className="mt-6 rounded-[12px] bg-[#fff7fb] p-5 text-center font-semibold text-[#68718f]">No activities match these filters — try widening your search.</p>
            )}
          </section>
        </div>
      </main>
      <Footer />
    </PageShell>
  );
}

/** Category slug for an activity — the RPC gives us the display name, so map
 *  it back through the category list the filter chips were built from. */
function catSlugOf(a: { category: string }, cats: { slug: string; name: string }[]) {
  return cats.find((c) => c.name === a.category)?.slug ?? "";
}

/** Rough great-circle distance (km) from a point to an activity's nearest venue. */
function distanceFrom(here: { lat: number; lng: number }, a: { venues: { lat: number; lng: number }[]; lat?: number; lng?: number }) {
  const points = a.venues.length ? a.venues : a.lat != null && a.lng != null ? [{ lat: a.lat, lng: a.lng }] : [];
  if (!points.length) return Infinity;
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  return Math.min(
    ...points.map((p) => {
      const dLat = rad(p.lat - here.lat);
      const dLng = rad(p.lng - here.lng);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(here.lat)) * Math.cos(rad(p.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    })
  );
}

const sgDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

const sgDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  });

const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  });

/** Full-screen photo viewer for an activity's gallery. Arrow keys and Escape
 *  work, and clicking the backdrop closes it. */
function PhotoLightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % images.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onIndex]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4" onClick={onClose}>
      <div className="flex items-center justify-between text-white">
        <span className="text-sm font-bold">{index + 1} / {images.length}</span>
        <button type="button" onClick={onClose} aria-label="Close photos" className="rounded-full p-2 hover:bg-white/10">
          <Icon name="close" className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center gap-4" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => onIndex((index - 1 + images.length) % images.length)}
            className="shrink-0 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
          >
            ‹
          </button>
        )}
        <img src={images[index]} alt="" className="max-h-[75vh] max-w-full rounded-[14px] object-contain" />
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => onIndex((index + 1) % images.length)}
            className="shrink-0 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
          >
            ›
          </button>
        )}
      </div>
      <div className="flex justify-center gap-2 overflow-x-auto pb-2" onClick={(e) => e.stopPropagation()}>
        {images.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={() => onIndex(i)}
            aria-label={`Photo ${i + 1}`}
            className={`overflow-hidden rounded-[8px] border-2 transition ${i === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
          >
            <img src={url} alt="" className="h-12 w-20 object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A chat CTA that greys out — with the reason on hover — when messaging isn't
 *  available: either the parent is on Free, or the provider isn't integrated
 *  with BabyBrain so there's nothing to open. */
function ChatButton({
  icon,
  label,
  disabledReason,
  onOpen,
}: {
  icon: string;
  label: string;
  disabledReason: string | null;
  onOpen: () => void;
}) {
  if (disabledReason) {
    return (
      <span
        title={disabledReason}
        className="mt-3 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#e3e7f2] bg-[#f5f6fa] px-6 py-3 text-[15px] font-extrabold leading-none text-[#9aa3bd]"
      >
        <Icon name={icon} className="h-4 w-4" /> {label} <Icon name="lock" className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <Button variant="blueOutline" className="mt-3 w-full" onClick={onOpen}>
      <Icon name={icon} className="h-4 w-4" /> {label}
    </Button>
  );
}

function ActivityDetailPage() {
  const { activity, sessions, reviews, loading } = useActivityDetail(getParam("slug"));
  const fav = useFavorite(activity?.id);
  const { session } = useAuth();
  const { isPlus } = usePlan();
  const [enquiring, setEnquiring] = useState(false);
  const [groupChat, setGroupChat] = useState(false);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  /** Index of the photo open in the lightbox, or null when it's closed. */
  const [galleryAt, setGalleryAt] = useState<number | null>(null);

  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("packages")
      .select("id, name, credits, price_cents, activity_id")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_id: string | null }>;
        setPacks(rows.filter((p) => p.activity_id === null || p.activity_id === activity.id));
      });
  }, [activity?.provider_id, activity?.id]);

  async function buyPack(packageId: string) {
    if (!session) {
      window.location.href = "/login";
      return;
    }
    setBuyingPack(packageId);
    try {
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/package", { package_id: packageId });
      if (url) window.location.href = url;
    } finally {
      setBuyingPack(null);
    }
  }

  if (loading) {
    return (
      <PageShell active="/explore">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center font-bold text-[#5a6690]">Loading…</main>
      </PageShell>
    );
  }
  if (!activity) {
    return (
      <PageShell active="/explore">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Activity not found.</p>
          <a href="/explore" className="font-bold text-baby-pink">← Back to results</a>
        </main>
      </PageShell>
    );
  }

  const next = sessions[0];
  const durationMins = next
    ? Math.round((new Date(next.ends_at).getTime() - new Date(next.starts_at).getTime()) / 60000)
    : null;
  const images = activity.image_urls.length ? activity.image_urls : [`${import.meta.env.BASE_URL}assets/crops/detail-hero.png`];

  // Messaging needs both an integrated provider and a Plus subscription.
  // Signed-out visitors still get a live button — it sends them to log in.
  const chatBlockedReason = activity.external_booking_url
    ? "This provider takes bookings on their own site, so messaging isn't available here. Use the WhatsApp or email buttons to reach them."
    : session && !isPlus
      ? "Messaging providers and other parents is a BabyBrain Plus feature."
      : null;
  const requireLogin = (open: () => void) => () => {
    if (!session) window.location.href = "/login";
    else open();
  };

  return (
    <PageShell active="/explore">
      {galleryAt !== null && (
        <PhotoLightbox
          images={images}
          index={galleryAt}
          onClose={() => setGalleryAt(null)}
          onIndex={setGalleryAt}
        />
      )}
      <main className="mx-auto max-w-[1180px] px-6 py-5">
        <section className="grid gap-5 lg:grid-cols-[285px_1fr_295px]">
          <div>
            <a href="/explore" className="font-bold text-baby-lilac">← Back to results</a>
            <h1 className="mt-5 text-[29px] font-black">{activity.title}</h1>
            {activity.provider_name &&
              activity.provider_name.trim().toLowerCase() !== activity.title.trim().toLowerCase() && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[14px] font-bold text-[#7a5cc8]">
                  <Icon name="store" className="h-4 w-4" /> {activity.provider_name}
                </p>
              )}
            {activity.category_name && (
              <span className="mt-4 inline-flex items-center gap-1 rounded-[9px] bg-[#fff0f6] px-4 py-1.5 font-bold text-baby-pink"><Icon name="music" className="h-4 w-4" /> {activity.category_name}</span>
            )}
            <p className="mt-3 text-[15px] font-semibold leading-6 text-[#34406f]">{activity.description}</p>
            {activity.rating_count > 0 && (
              <div className="mt-5 flex gap-5 font-bold"><span className="flex items-center gap-1"><Icon name="star" className="h-4 w-4 text-[#ffb72b]" /> {Number(activity.rating_avg).toFixed(1)} ({activity.rating_count})</span></div>
            )}
          </div>
          <div>
            <div className="relative">
              <img src={images[0]} alt={activity.title} className="h-[305px] w-full rounded-[18px] object-cover" />
              <button
                type="button"
                onClick={() => setGalleryAt(0)}
                className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-[10px] bg-white/95 px-3 py-2 text-[13px] font-bold text-baby-ink shadow-soft transition hover:bg-white"
              >
                <Icon name="open" className="h-3.5 w-3.5" />{" "}
                {images.length > 1 ? `View photos (${images.length})` : "View photo"}
              </button>
            </div>
            {images.length > 1 && (
              <div className="mt-3 flex gap-2">
                {images.slice(1, 6).map((url, i) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setGalleryAt(i + 1)}
                    className="overflow-hidden rounded-[8px] border-2 border-white shadow-soft transition hover:border-baby-blue"
                  >
                    <img src={url} alt="" className="h-11 w-[76px] object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <aside className="rounded-[18px] border border-[#f0dccd] bg-white p-5 shadow-card">
            {activity.price != null ? (
              <p><strong className="text-[30px] text-baby-lilac">${Number(activity.price)}</strong> <span className="font-bold">/ class</span></p>
            ) : (
              <>
                <p className="text-xl font-black text-baby-lilac">Price on enquiry</p>
                <p className="mt-1 text-sm font-semibold text-[#68718f]">
                  {activity.external_booking_url ? "See pricing on the provider's booking page." : "Contact the provider for pricing."}
                </p>
              </>
            )}
            {activity.external_booking_url ? (
              <a
                href={activity.external_booking_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white shadow-pink transition hover:brightness-105"
              >
                <Icon name="calendar" className="h-4 w-4" /> Book on provider's site
              </a>
            ) : (
              <Button href={`/book?slug=${activity.slug}`} variant="blue" className="mt-4 w-full"><Icon name="calendar" className="h-4 w-4" /> Book a class</Button>
            )}
            {/* Enquiry chat needs a provider to message — hide the button
                for listings without a linked provider, else it dead-clicks
                for signed-in users. Messaging is a Plus feature, and it also
                needs the provider to be integrated with us: a listing that
                books on the provider's own site has no chat to open. */}
            {activity.provider_id && (
              <ChatButton
                icon="mail"
                label="Chat with provider"
                disabledReason={chatBlockedReason}
                onOpen={requireLogin(() => setEnquiring(true))}
              />
            )}
            {/* 1.4: direct click-through contact — WhatsApp and email */}
            {(activity.provider_contact?.whatsapp || activity.provider_contact?.contact_phone || activity.provider_contact?.contact_email) && (
              <div className="mt-3 flex gap-2">
                {(activity.provider_contact.whatsapp || activity.provider_contact.contact_phone) && (
                  <a
                    href={`https://wa.me/${phoneDigits(activity.provider_contact.whatsapp ?? activity.provider_contact.contact_phone ?? "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-[11px] border border-[#3fc36a] bg-white px-4 py-2.5 text-[13px] font-extrabold leading-none text-[#1f9d4d] transition hover:bg-[#f2fcf5]"
                  >
                    <Icon name="whatsapp" className="h-4 w-4" /> WhatsApp
                  </a>
                )}
                {activity.provider_contact.contact_email && (
                  <a
                    href={`mailto:${activity.provider_contact.contact_email}?subject=${encodeURIComponent(`Enquiry about ${activity.title}`)}`}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-[11px] border border-baby-blue bg-white px-4 py-2.5 text-[13px] font-extrabold leading-none text-[#2f7fd8] transition hover:bg-[#f2f8ff]"
                  >
                    <Icon name="mail" className="h-4 w-4" /> Email
                  </a>
                )}
              </div>
            )}
            <ChatButton
              icon="people"
              label="Class group chat"
              disabledReason={chatBlockedReason}
              onOpen={requireLogin(() => setGroupChat(true))}
            />
            <Button variant="soft" type="button" onClick={fav.toggle} className="mt-3 w-full text-baby-pink">
              <Icon name="heart" className="h-4 w-4" /> {fav.saved ? "Saved to favourites" : "Save to favourites"}
            </Button>
            {enquiring && activity.provider_id && (
              <EnquiryChat
                providerId={activity.provider_id}
                providerName={activity.provider_name ?? activity.title}
                onClose={() => setEnquiring(false)}
              />
            )}
            {groupChat && (
              <ClassGroupChat
                activityId={activity.id}
                activityTitle={activity.title}
                onClose={() => setGroupChat(false)}
              />
            )}
            <div className="mt-5 space-y-4 border-t border-[#eceff7] pt-4 text-sm font-semibold">
              {activity.address && <p><strong>Location</strong><span className="float-right text-right">{activity.address}</span></p>}
              {next && <p><strong>Next available class</strong><span className="float-right">{sgDateTime(next.starts_at)}</span></p>}
              {next?.capacity != null && <p><strong>Spaces available</strong><span className="float-right text-[#197bff]">{next.capacity} spots</span></p>}
              {durationMins != null && <p><strong>Duration</strong><span className="float-right">{formatDuration(durationMins)}</span></p>}
            </div>
          </aside>
        </section>

        <section className="mt-5 grid gap-5 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card lg:grid-cols-[1.4fr_1fr]">
          <InfoBlock title="About" items={[activity.description]} />
          <div>
            <h3 className="mb-2 font-black text-baby-ink">Upcoming sessions</h3>
            <div className="flex flex-wrap gap-2">
              {sessions.map((s) => (
                <span key={s.id} className="rounded-[10px] border border-[#e6eaf6] px-3 py-2 text-sm font-bold">{sgDateTime(s.starts_at)}</span>
              ))}
              {sessions.length === 0 && <p className="text-sm font-semibold text-[#68718f]">No upcoming sessions scheduled.</p>}
            </div>
            {durationMins && <p className="mt-3 text-sm font-semibold text-[#68718f]">Each session runs about {durationMins} minutes.</p>}
          </div>
        </section>

        {packs.length > 0 && (
          <section className="mt-5 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
            <h2 className="mb-1 text-xl font-black">Packages</h2>
            <p className="mb-4 text-sm font-semibold text-[#68718f]">Buy a multi-class pack and save — credits work across this provider's classes.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {packs.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#e7ebf6] p-4">
                  <div>
                    <h3 className="font-black">{p.name}</h3>
                    <p className="text-sm font-semibold text-[#59658d]">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</p>
                  </div>
                  <Button type="button" variant="blue" size="sm" onClick={() => buyPack(p.id)} className={buyingPack === p.id ? "opacity-60" : ""}>
                    {buyingPack === p.id ? "…" : "Buy pack"}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-5 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
          <h2 className="mb-3 text-xl font-black">Reviews ({activity.rating_count})</h2>
          <ReviewForm activityId={activity.id} />
          {reviews.map((r) => (
            <div key={r.id} className="mb-3 border-b border-[#eef1f8] pb-3">
              <div className="flex gap-0.5 text-[#ffb71b]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
              {r.comment && <p className="mt-1 font-semibold text-[#34406f]">{r.comment}</p>}
              <p className="mt-1 text-xs font-semibold text-[#8a93b2]">A BabyBrain parent</p>
              {r.provider_response && (
                <div className="mt-2 rounded-[10px] bg-[#fff7fb] p-3">
                  <p className="text-xs font-black text-baby-pink">Response from the provider</p>
                  <p className="mt-1 text-sm font-semibold text-[#34406f]">{r.provider_response}</p>
                </div>
              )}
            </div>
          ))}
          {reviews.length === 0 && <p className="text-sm font-semibold text-[#68718f]">No reviews yet — be the first!</p>}
        </section>
      </main>
    </PageShell>
  );
}

function ReviewForm({ activityId }: { activityId: string }) {
  const { session } = useAuth();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <p className="mb-4 rounded-[10px] bg-[#f4f8ff] px-4 py-3 text-sm font-semibold text-[#59658d]">
        <a href="/login" className="font-black text-baby-pink">Log in</a> to review a class you've attended.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) return setError("Pick a star rating first.");
    setBusy(true);
    setError(null);
    const { error } = await supabase.from("reviews").upsert(
      { user_id: session!.user.id, activity_id: activityId, rating, comment: comment.trim() || null },
      { onConflict: "user_id,activity_id" }
    );
    setBusy(false);
    if (error) {
      const blocked = error.code === "42501" || /row-level security/i.test(error.message);
      return setError(blocked ? "You can only review a class you've booked and attended." : error.message);
    }
    window.location.reload();
  }

  return (
    <form onSubmit={submit} className="mb-5 rounded-[12px] border border-[#e7ebf6] bg-[#f9fbff] p-4">
      <p className="mb-2 font-black">Write a review</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            <Icon name="star" className={`h-7 w-7 ${(hover || rating) >= n ? "text-[#ffb71b] fill-current" : "text-[#d5ddef]"}`} />
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Share how the class went (optional)"
        className="mt-3 w-full rounded-[10px] border border-[#ecdfe6] px-3 py-2 text-sm font-semibold"
      />
      {error && <p className="mt-2 text-sm font-bold text-[#b00040]">{error}</p>}
      <Button type="submit" variant="blue" className="mt-3">{busy ? "Posting…" : "Submit review"}</Button>
    </form>
  );
}

function InfoBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <article>
      <h3 className="mb-4 text-xl font-black text-baby-lilac">{title}</h3>
      <div className="space-y-2 text-sm font-semibold leading-5 text-[#3e4976]">
        {items.map((item) => <p key={item}>{item}</p>)}
      </div>
    </article>
  );
}

type BookingItem = {
  id: string; status: string; when: string; title: string; slug: string; image: string;
  startsAt: string | null; endsAt: string | null; venue: string;
  activityId: string | null; childId: string | null;
  allowCancel: boolean; allowReschedule: boolean;
  cancelCutoffH: number; resCutoffH: number;
};
type ReviewItem = { id: string; rating: number; comment: string | null; title: string; slug: string; providerResponse: string | null };
type NotifItem = { id: string; title: string; body: string; read_at: string | null; created_at: string };
type TokenItem = { id: string; status: string; provider: string; created_at: string; expires_at: string | null; originSlug: string | null };
type PackageItem = { id: string; name: string; provider: string; total: number; remaining: number; status: string; expiresAt: string | null };

/** [key, label, icon, plusOnly] — the Plus-only tabs are the ones QA listed as
 *  needing to differ between tiers (packages, make-up tokens, favourites). */
const PROFILE_TABS: [string, string, string, boolean][] = [
  ["overview", "Overview", "home", false],
  ["children", "My children", "people", false],
  ["bookings", "Bookings", "calendar", false],
  ["past", "Past activities", "check", false],
  // Packages sits above make-up tokens: parents reach for a pack far more
  // often than a token, so it reads better in that order.
  ["packages", "Packages", "store", true],
  ["makeup", "Make-up tokens", "gift", true],
  ["favorites", "Favourites", "heart", true],
  ["reviews", "Reviews", "star", false],
  ["notifications", "Notifications", "bell", false],
  ["settings", "Settings", "gear", false],
];

/** Stand-in shown where a Plus-only feature would be, with the upgrade path. */
function PlusLock({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-[#f0c3d6] bg-[#fff7fb] p-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#ffe9f2] text-baby-pink">
        <Icon name="lock" className="h-7 w-7" />
      </span>
      <h2 className="mt-4 text-xl font-black">{title}</h2>
      <p className="mx-auto mt-2 max-w-[420px] font-semibold text-[#68718f]">{copy}</p>
      <Button href="/pricing" className="mt-5"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
    </div>
  );
}

function tokenStatusStyle(status: string) {
  if (status === "issued") return "bg-[#eefbf1] text-green-700";
  if (status === "redeemed") return "bg-[#fff0f5] text-[#FA5D93]";
  return "bg-[#f1efe8] text-[#7a725c]"; // expired
}

function bookingStatusStyle(status: string) {
  if (status === "confirmed" || status === "completed") return "bg-[#eefbf1] text-green-700";
  if (status === "cancelled") return "bg-[#ffe9ef] text-[#b00040]";
  if (status === "waitlisted") return "bg-amber-50 text-amber-700";
  return "bg-[#fff0f5] text-[#FA5D93]";
}

type ChildRecs = ReturnType<typeof useRecommendations>["data"];

/** Add / edit a child directly against the `children` table (RLS-scoped to the
 *  signed-in parent). Used from the profile so parents can manage kids after
 *  onboarding, without going back through the signup flow. */
function ChildForm({
  parentId,
  initial,
  onSaved,
  onCancel,
}: {
  parentId: string;
  initial?: Child;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [dob, setDob] = useState(initial?.date_of_birth ?? "");
  const [gender, setGender] = useState<string>(initial?.gender ?? "unspecified");
  const [interests, setInterests] = useState<string[]>(initial?.interests ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const input = "h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 text-sm font-semibold";
  const toggle = (v: string) => setInterests((xs) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]));

  async function save() {
    if (!name.trim()) {
      setError("Please add a name.");
      return;
    }
    const dobProblem = dobError(dob);
    if (dobProblem) {
      setError(dobProblem);
      return;
    }
    setBusy(true);
    setError(null);
    // `notes` was removed from the form per QA; existing values are left untouched.
    const payload = { name: name.trim(), date_of_birth: dob, gender: gender as Gender, interests };
    const { error: err } = initial
      ? await supabase.from("children").update(payload).eq("id", initial.id)
      : await supabase.from("children").insert({ parent_id: parentId, ...payload });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    onSaved();
  }

  return (
    <div className="mt-4 rounded-[14px] border border-[#f0d9e6] bg-white p-5 shadow-card">
      <h3 className="text-lg font-black">{initial ? `Edit ${initial.name}` : "Add a child"}</h3>
      {error && <p className="mt-2 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
      <div className="mt-3 space-y-3">
        <div><label className="mb-1 block text-sm font-black">Child's name</label><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emma" /></div>
        <div>
          <label className="mb-1 block text-sm font-black">Date of birth</label>
          <DateInput value={dob} onChange={setDob} min={MIN_CHILD_DOB} max={todayIso()} className={input} />
          <p className="mt-1 text-xs font-semibold text-[#8a93b2]">Day first, e.g. 14/03/2024.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[["male", "Boy"], ["female", "Girl"], ["unspecified", "Prefer not to say"]].map(([v, l]) => (
            <Chip key={v} on={gender === v} onClick={() => setGender(v)}>{l}</Chip>
          ))}
        </div>
        <div>
          <p className="mb-1 text-sm font-black">Interests</p>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => <Chip key={c.slug} on={interests.includes(c.slug)} onClick={() => toggle(c.slug)}>{c.name}</Chip>)}
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        <Button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : "Add child"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ChildClassRow({ b }: { b: BookingItem }) {
  return (
    <a href={b.slug ? `/activity?slug=${b.slug}` : "/profile?tab=bookings"} className="flex items-center gap-3 rounded-[12px] border border-[#eef1f7] bg-white p-3 shadow-card transition hover:border-baby-pink">
      <img src={b.image} alt="" className="h-14 w-14 rounded-[10px] object-cover" />
      <div className="min-w-0 flex-1">
        <h4 className="truncate font-black">{b.title}</h4>
        <p className="text-xs font-semibold text-[#59658d]">{b.when || "Schedule TBC"}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${bookingStatusStyle(b.status)}`}>{b.status}</span>
    </a>
  );
}

/** The per-child panel shown when a parent taps a child: their booked classes
 *  (split upcoming vs. past) plus matched suggestions for that child. */
function ChildClasses({ child, bookings, recs }: { child: Child; bookings: BookingItem[]; recs: ChildRecs[number]["recs"] }) {
  const now = Date.now();
  const isUpcoming = (b: BookingItem) => !!b.startsAt && new Date(b.startsAt).getTime() >= now && b.status !== "cancelled";
  const upcoming = bookings.filter(isUpcoming);
  const past = bookings.filter((b) => !isUpcoming(b));
  const suggestions = recs.filter((r) => r.activity);

  return (
    <section className="mt-5 rounded-[16px] border border-[#f0d9e6] bg-[#fff7fb] p-5">
      <h2 className="text-xl font-black">{child.name}'s classes</h2>
      {bookings.length === 0 ? (
        <p className="mt-3 rounded-[12px] bg-white p-4 text-sm font-semibold text-[#68718f]">
          No classes booked for {child.name} yet. <a href="/explore" className="font-black text-baby-pink">Explore activities →</a>
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-black text-[#46527d]">Upcoming</h3>
              <div className="space-y-2">{upcoming.map((b) => <ChildClassRow key={b.id} b={b} />)}</div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-black text-[#46527d]">Past &amp; cancelled</h3>
              <div className="space-y-2">{past.map((b) => <ChildClassRow key={b.id} b={b} />)}</div>
            </div>
          )}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-black text-[#46527d]">Suggested for {child.name}</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {suggestions.slice(0, 3).map((r) => <ActivityCard key={r.id} activity={toCard(r.activity as Parameters<typeof toCard>[0])} />)}
          </div>
        </div>
      )}
    </section>
  );
}

/** "My Children" tab: list + add/edit/remove, and tap a child to see their classes. */
function ChildrenTab({
  parentId,
  kids,
  refresh,
  bookings,
  recsByChild,
}: {
  parentId: string;
  kids: Child[];
  refresh: () => Promise<void>;
  bookings: BookingItem[];
  recsByChild: ChildRecs;
}) {
  const [form, setForm] = useState<null | { child?: Child }>(null);
  const [viewId, setViewId] = useState<string | null>(null);

  async function remove(c: Child) {
    if (!window.confirm(`Remove ${c.name}'s profile? This can't be undone.`)) return;
    await supabase.from("children").delete().eq("id", c.id);
    if (viewId === c.id) setViewId(null);
    await refresh();
  }

  const viewChild = kids.find((c) => c.id === viewId) ?? null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-black">My children</h1>
        {!form && <Button type="button" onClick={() => { setForm({}); }}><Icon name="user" className="h-4 w-4" /> Add a child</Button>}
      </div>

      {form && (
        <ChildForm
          parentId={parentId}
          initial={form.child}
          onCancel={() => setForm(null)}
          onSaved={async () => { setForm(null); await refresh(); }}
        />
      )}

      {!form && (
        <>
          {kids.length === 0 ? (
            <p className="mt-4 rounded-[12px] bg-[#fff7fb] p-5 text-center font-semibold text-[#68718f]">
              No child profiles yet — add one to get personalised matches and track their classes.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {kids.map((c) => {
                const booked = bookings.filter((b) => b.childId === c.id).length;
                const open = viewId === c.id;
                return (
                  <div key={c.id} className={`rounded-[14px] border bg-white p-5 shadow-card transition ${open ? "border-baby-pink ring-1 ring-baby-pink/30" : "border-[#e7ebf6] hover:border-baby-pink"}`}>
                    <button type="button" onClick={() => setViewId(open ? null : c.id)} className="flex w-full items-center gap-4 text-left">
                      <AnimalAvatar seed={c.name} kind="child" className="h-16 w-16 ring-4 ring-white shadow-soft" />
                      <div>
                        <h3 className="font-black">{c.name}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">{formatChildAge(c.date_of_birth)}</p>
                        <p className="mt-0.5 text-xs font-bold text-baby-pink">{open ? "Hide classes ▲" : `View classes ▾${booked ? ` · ${booked} booked` : ""}`}</p>
                      </div>
                    </button>
                    {c.interests.length > 0 && (
                      <p className="mt-3 text-sm font-semibold capitalize leading-6 text-[#4a5685]"><span className="font-black text-baby-ink">Interests:</span> {c.interests.map((i) => i.replace(/-/g, " ")).join(", ")}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <Button type="button" variant="outline" size="sm" onClick={() => setForm({ child: c })}><Icon name="pen" className="h-4 w-4" /> Edit</Button>
                      <button type="button" onClick={() => remove(c)} className="text-xs font-bold text-[#b00040] hover:underline">Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {viewChild && (
            <ChildClasses
              child={viewChild}
              bookings={bookings.filter((b) => b.childId === viewChild.id)}
              recs={recsByChild.find((r) => r.child.id === viewChild.id)?.recs ?? []}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Twelve deterministic avatar options — the generator is seeded by string, so
 *  storing the chosen seed is all we need to reproduce the picture. */
const AVATAR_SEEDS = Array.from({ length: 12 }, (_, i) => `bb-avatar-${i + 1}`);

/** Edit an existing parent profile.
 *
 *  QA: "When you click edit profile, the form should be pre-populated with what
 *  you have completed before rather than having to do it all again" and "Tried
 *  to edit profile and it added a child instead". Both came from Edit Profile
 *  pointing at /onboarding — the sign-up form, which always inserts a new
 *  child. Children are managed on their own tab; this page never creates one.
 */
function EditProfilePage() {
  const { session, profile, loading, refresh } = useAuth();
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  const [interests, setInterests] = useState<string[]>([]);
  const [budgetMin, setBudgetMin] = useState<number | null>(null);
  const [budgetMax, setBudgetMax] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill from what the parent has already told us.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? "");
    setPhone(profile.phone ?? "");
    setPostcode(profile.postal_code ?? "");
    setAvatarSeed(profile.avatar_seed ?? null);
  }, [profile]);

  useEffect(() => {
    if (!session) return;
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
    supabase
      .from("user_preferences")
      .select("preferred_days, preferred_times, preferred_regions, interests, budget_min, budget_max")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDays(data.preferred_days ?? []);
          setTimes(data.preferred_times ?? []);
          setRegions(data.preferred_regions ?? []);
          setInterests(data.interests ?? []);
          setBudgetMin(data.budget_min);
          setBudgetMax(data.budget_max);
        }
        setReady(true);
      });
  }, [session]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 text-sm font-semibold";
  const weekdayKeys = ["mon", "tue", "wed", "thu", "fri"];
  const weekendKeys = ["sat", "sun"];
  const weekdaysOn = weekdayKeys.every((d) => days.includes(d));
  const weekendOn = weekendKeys.every((d) => days.includes(d));

  async function save() {
    if (!session) return;
    if (!fullName.trim()) return setError("Please add your full name.");
    const postcodeProblem = postcodeError(postcode);
    if (postcodeProblem) return setError(postcodeProblem);
    setBusy(true);
    setError(null);
    const { error: pErr } = await supabase
      .from("parent_profiles")
      .update({
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        postal_code: postcode.trim(),
        avatar_seed: avatarSeed,
      })
      .eq("id", session.user.id);
    const { error: prefErr } = await supabase
      .from("user_preferences")
      .update({
        preferred_days: days as never,
        preferred_times: times as never,
        preferred_regions: regions as never,
        interests,
        budget_min: budgetMin,
        budget_max: budgetMax,
      })
      .eq("user_id", session.user.id);
    setBusy(false);
    if (pErr || prefErr) return setError((pErr ?? prefErr)!.message);
    await refresh();
    setSaved(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!loading && !session) {
    return (
      <PageShell active="/profile">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Log in to edit your profile.</p>
          <Button href="/login" className="mt-4">Log in</Button>
        </main>
      </PageShell>
    );
  }

  return (
    <PageShell active="/profile">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <a href="/profile" className="text-sm font-bold text-baby-lilac">← Back to my account</a>
        <h1 className="mt-3 text-[30px] font-black">Edit your profile</h1>
        <p className="mt-1 text-sm font-semibold text-[#44507b]">Update your details and what you'd like us to suggest.</p>

        {saved && (
          <p className="mt-4 rounded-[10px] bg-[#eefbf1] px-4 py-3 text-sm font-bold text-green-700">
            Your profile has been updated.
          </p>
        )}

        <section className="mt-4 rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h2 className="font-black">Your avatar</h2>
          <p className="mt-1 text-xs font-semibold text-[#8a93b2]">Pick the one you like — it shows on your account and in class chats.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[null, ...AVATAR_SEEDS].map((seed) => {
              const on = avatarSeed === seed;
              return (
                <button
                  key={seed ?? "default"}
                  type="button"
                  aria-label={seed ? `Avatar option ${seed}` : "Default avatar"}
                  aria-pressed={on}
                  onClick={() => setAvatarSeed(seed)}
                  className={`rounded-full p-0.5 transition ${on ? "ring-2 ring-baby-pink" : "ring-1 ring-[#eceff7] hover:ring-[#f0c3d6]"}`}
                >
                  <AnimalAvatar seed={seed ?? fullName} kind="parent" className="h-12 w-12" />
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h2 className="font-black">Your details</h2>
          <div className="mt-3 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div><label className="mb-1 block text-sm font-black">Postcode</label><input className={input} inputMode="numeric" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#9aa4c2]">Email</p>
              <p className="font-black">{session?.user.email}</p>
              <p className="text-xs font-semibold text-[#8a93b2]">Contact us if you need to change the email on your account.</p>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h2 className="flex items-center gap-2 font-black"><Icon name="pin" className="h-4 w-4 text-baby-pink" /> Areas you'd like activities in</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGION_FILTERS.map(([v, l]) => (
              <Chip key={v} on={regions.includes(v)} onClick={() => toggle(regions, v, setRegions)}>{l}</Chip>
            ))}
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="heart" className="h-4 w-4 text-baby-pink" /> Your preferences</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip
              on={weekdaysOn}
              onClick={() => setDays((d) => (weekdaysOn ? d.filter((x) => !weekdayKeys.includes(x)) : [...new Set([...d, ...weekdayKeys])]))}
            >
              Weekdays
            </Chip>
            <Chip
              on={weekendOn}
              onClick={() => setDays((d) => (weekendOn ? d.filter((x) => !weekendKeys.includes(x)) : [...new Set([...d, ...weekendKeys])]))}
            >
              Weekend
            </Chip>
            {TIME_CHIPS.map(([v, l]) => <Chip key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Chip>)}
            {BUDGET_CHIPS.map(([k, l, lo, hi]) => {
              const on = budgetMin === lo && budgetMax === hi;
              return (
                <Chip key={k} on={on} onClick={() => { setBudgetMin(on ? null : lo); setBudgetMax(on ? null : hi); }}>{l}</Chip>
              );
            })}
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="spark" className="h-4 w-4 text-baby-pink" /> Interests</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {cats.map((c) => <Chip key={c.slug} on={interests.includes(c.slug)} onClick={() => toggle(interests, c.slug, setInterests)}>{c.name}</Chip>)}
          </div>
        </section>

        <section className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[#eadfd2] bg-[#fff7fb] p-5">
          <div>
            <h2 className="font-black">Your children</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Add, edit or remove a child on their own tab — editing your profile never changes them.</p>
          </div>
          <Button href="/profile?tab=children" variant="outline" className="shrink-0"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#ffd2de] bg-[#ffe9ef] px-4 py-3 text-sm font-bold text-[#b00040]">{error}</p>
        )}
        <div className="mt-4 flex gap-3">
          <Button type="button" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Save changes"}</Button>
          <Button href="/profile" variant="outline">Cancel</Button>
        </div>
      </main>
      <Footer />
    </PageShell>
  );
}

function ProfilePage() {
  const { session, profile, children, loading, signOut, refresh } = useAuth();
  const child = children[0];
  const journey = useJourney(child?.id);
  const { data: recsByChild } = useRecommendations(children);
  const [favs, setFavs] = useState<ReturnType<typeof toCard>[]>([]);
  const [bookings, setBookings] = useState<BookingItem[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [savedProviders, setSavedProviders] = useState<{ id: string; name: string }[]>([]);
  const [billingPlan, setBillingPlan] = useState<{
    plan: "free" | "plus";
    status: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    terms_accepted_at: string | null;
    terms_version: string | null;
  } | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const tab = getParam("tab") || "overview";

  function loadBookings() {
    supabase
      .from("bookings")
      .select("id, status, created_at, child_id, activity_sessions(starts_at, ends_at, activity_id, activities(title, slug, image_urls, address, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, reschedule_cutoff_hours))")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          status: string;
          child_id: string | null;
          activity_sessions: {
            starts_at: string;
            ends_at: string | null;
            activity_id: string;
            activities: {
              title: string; slug: string; image_urls: string[]; address: string | null;
              allow_cancellation: boolean; allow_rescheduling: boolean;
              cancellation_cutoff_hours: number; reschedule_cutoff_hours: number;
            } | null;
          } | null;
        }>;
        setBookings(
          rows.map((r) => {
            const s = r.activity_sessions;
            const act = s?.activities;
            return {
              id: r.id,
              status: r.status,
              when: s?.starts_at ? sgDateTime(s.starts_at) : "",
              title: act?.title ?? "Class",
              slug: act?.slug ?? "",
              image: act?.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`,
              startsAt: s?.starts_at ?? null,
              endsAt: s?.ends_at ?? null,
              venue: act?.address ?? "",
              activityId: s?.activity_id ?? null,
              childId: r.child_id ?? null,
              allowCancel: act?.allow_cancellation ?? true,
              allowReschedule: act?.allow_rescheduling ?? true,
              cancelCutoffH: act?.cancellation_cutoff_hours ?? 24,
              resCutoffH: act?.reschedule_cutoff_hours ?? 24,
            };
          })
        );
      });
  }

  function loadPackages() {
    supabase
      .from("package_purchases")
      .select("id, credits_total, credits_remaining, status, expires_at, packages(name), providers(business_name)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          credits_total: number;
          credits_remaining: number;
          status: string;
          expires_at: string | null;
          packages: { name: string } | null;
          providers: { business_name: string } | null;
        }>;
        setPackages(
          rows.map((r) => ({
            id: r.id,
            name: r.packages?.name ?? "Class package",
            provider: r.providers?.business_name ?? "A provider",
            total: r.credits_total,
            remaining: r.credits_remaining,
            status: r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status,
            expiresAt: r.expires_at,
          }))
        );
      });
  }

  async function manageBilling() {
    setBillingBusy(true);
    try {
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/portal", {});
      if (url) window.location.href = url;
    } catch {
      /* portal unavailable — button stays put */
    } finally {
      setBillingBusy(false);
    }
  }

  useEffect(() => {
    if (!session) return;
    supabase
      .from("favorites")
      .select("activities(*, activity_categories(name))")
      .then(({ data }) => {
        setFavs(
          (data ?? [])
            .map((f) => {
              const a = f.activities as unknown as
                | (Parameters<typeof toCard>[0] & { activity_categories?: { name: string } })
                | null;
              return a ? toCard({ ...a, category_name: a.activity_categories?.name }) : null;
            })
            .filter((x): x is ReturnType<typeof toCard> => Boolean(x))
        );
      });

    loadBookings();

    supabase
      .from("reviews")
      .select("id, rating, comment, provider_response, activities(title, slug)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          rating: number;
          comment: string | null;
          provider_response: string | null;
          activities: { title: string; slug: string } | null;
        }>;
        setReviews(
          rows.map((r) => ({
            id: r.id,
            rating: r.rating,
            comment: r.comment,
            title: r.activities?.title ?? "Activity",
            slug: r.activities?.slug ?? "",
            providerResponse: r.provider_response,
          }))
        );
      });

    supabase
      .from("notifications")
      .select("id, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .then(({ data }) => setNotifications((data ?? []) as unknown as NotifItem[]));

    loadPackages();

    supabase
      .from("favorite_providers")
      .select("provider_id, providers(business_name)")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ provider_id: string; providers: { business_name: string } | null }>;
        setSavedProviders(rows.map((r) => ({ id: r.provider_id, name: r.providers?.business_name ?? "Provider" })));
      });

    (async () => {
      const { data } = await supabase
        .from("make_up_tokens")
        .select("id, status, created_at, expires_at, origin_booking_id, providers(business_name)")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        status: string;
        created_at: string;
        expires_at: string | null;
        origin_booking_id: string | null;
        providers: { business_name: string } | null;
      }>;
      // Resolve the origin class slug so "Redeem" can link to its booking page.
      const originIds = [...new Set(rows.map((r) => r.origin_booking_id).filter((x): x is string => !!x))];
      const slugByBooking = new Map<string, string>();
      if (originIds.length) {
        const { data: bks } = await supabase
          .from("bookings")
          .select("id, activity_sessions(activities(slug))")
          .in("id", originIds);
        for (const b of (bks ?? []) as unknown as Array<{ id: string; activity_sessions: { activities: { slug: string } | null } | null }>) {
          const slug = b.activity_sessions?.activities?.slug;
          if (slug) slugByBooking.set(b.id, slug);
        }
      }
      setTokens(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          created_at: r.created_at,
          expires_at: r.expires_at,
          provider: r.providers?.business_name ?? "A provider",
          originSlug: r.origin_booking_id ? slugByBooking.get(r.origin_booking_id) ?? null : null,
        }))
      );
    })();

    const fetchPlan = () => {
      apiGet<{
        plan: "free" | "plus";
        status: string | null;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
        terms_accepted_at: string | null;
        terms_version: string | null;
      }>("/api/customer/stripe/subscription")
        .then(setBillingPlan)
        .catch(() => {});
    };

    // Coming back from Stripe Checkout: apply the result straight away rather
    // than waiting on the webhook, which QA found could leave a paid-for
    // upgrade reading "Free" and a bought class pack missing from Packages.
    const checkoutSession = getParam("session_id");
    if (checkoutSession) {
      apiPost("/api/stripe/reconcile", { session_id: checkoutSession })
        .catch(() => {})
        .finally(() => {
          invalidatePlan();
          fetchPlan();
          loadPackages();
        });
    } else {
      fetchPlan();
    }
  }, [session]);

  if (!loading && !session) {
    return (
      <PageShell active="/profile">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Log in to view your dashboard.</p>
          <Button href="/login" className="mt-4">Log in</Button>
        </main>
      </PageShell>
    );
  }

  const recs = recsByChild[0]?.recs ?? [];
  const parentName = profile?.full_name || "Your family";
  const isPlus = billingPlan?.plan === "plus";
  // A class is "past" once its start time has gone by. Attendance decides
  // which of the two past lists it lands in.
  const now = Date.now();
  const isPast = (b: BookingItem) =>
    b.status !== "cancelled" && !!b.startsAt && new Date(b.startsAt).getTime() < now;
  const upcomingBookings = bookings.filter((b) => !isPast(b));
  const pastBookings = bookings.filter(isPast);

  return (
    <PageShell active="/profile">
      {/* On mobile the order is nav → tab content → referral/contact, so
          switching tabs shows the content straight away instead of burying it
          under the promo blocks. On desktop both sidebar cards stack on the
          left with the content beside them. */}
      <main className="mx-auto flex max-w-[1122px] flex-col gap-5 px-4 py-5 sm:px-6 lg:grid lg:grid-cols-[235px_1fr] lg:items-start">
        <aside className="order-1 lg:col-start-1 lg:row-start-1">
          <div className="rounded-[12px] border border-[#e7ebf6] bg-white p-5 shadow-card">
            <div className="flex items-center gap-3">
              <AnimalAvatar seed={profile?.avatar_seed ?? parentName} kind="parent" className="h-14 w-14" />
              <div className="min-w-0"><h2 className="truncate font-black">{parentName}</h2>{child && <p className="truncate text-sm font-semibold text-[#59658d]">{child.name} · {formatChildAge(child.date_of_birth)}</p>}</div>
            </div>
            <a
              href={isPlus ? "/profile?tab=settings" : "/pricing"}
              className={`mt-4 flex items-center justify-between rounded-[10px] px-3 py-2 text-sm font-bold ${isPlus ? "bg-[#ffe9f2] text-[#e5487f]" : "bg-[#fff4ec] text-[#c2571f]"}`}
            >
              <span className="flex items-center gap-1.5">
                <Icon name={isPlus ? "star" : "spark"} className="h-4 w-4" />
                {isPlus ? "Plus plan" : "Free plan"}
              </span>
              <span className="text-xs">{isPlus ? "Manage" : "Upgrade →"}</span>
            </a>
            <nav className="mt-4 space-y-1.5">
              {PROFILE_TABS.map(([key, item, icon, plusOnly]) => {
                const locked = plusOnly && !isPlus;
                return (
                  <a
                    key={key}
                    href={`/profile?tab=${key}`}
                    className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-bold ${tab === key ? "bg-[#ffe9f2] text-[#e5487f]" : locked ? "text-[#9aa3bd] hover:bg-[#f5f8ff]" : "text-[#5a6484] hover:bg-[#f5f8ff]"}`}
                  >
                    <Icon name={icon} className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} /> {item}
                    {locked && <Icon name="lock" className="ml-auto h-3.5 w-3.5 shrink-0" />}
                  </a>
                );
              })}
            </nav>
          </div>
        </aside>
        <aside className="order-3 space-y-4 lg:col-start-1 lg:row-start-2">
          <div className="rounded-[12px] border border-[#f0e2c6] bg-[#fff9e9] p-5 shadow-card">
            <h3 className="text-lg font-black">Invite a friend</h3>
            <p className="mt-3 text-sm font-semibold leading-6">Get $10 credits when your friend makes their first booking!</p>
            <img src={`${import.meta.env.BASE_URL}assets/crops/invite-gift.png`} alt="" className="mx-auto my-3 h-20 object-contain" />
            <Button
              type="button"
              onClick={() => {
                const url = `${window.location.origin}/onboarding?ref=friend`;
                if (navigator.share) {
                  navigator.share({ title: "BabyBrain.sg", text: "Join me on BabyBrain — find great activities for your little one!", url }).catch(() => {});
                } else {
                  navigator.clipboard?.writeText(url);
                  alert("Referral link copied — share it with a friend!");
                }
              }}
              variant="blue"
              className="w-full"
            >
              Invite friends
            </Button>
          </div>
          <div className="rounded-[12px] bg-[#f4f8ff] p-5">
            <h3 className="font-black">Need help?</h3>
            <p className="mt-2 text-sm font-semibold">Our support team is here for you.</p>
            <a href="/contact" className="mt-4 block font-black text-[#FA5D93]">Contact support →</a>
          </div>
        </aside>
        <section className="order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {tab === "overview" && (
          <>
          <div className="grid items-center gap-5 rounded-[14px] border border-[#e7ebf6] bg-white p-6 shadow-card lg:grid-cols-[120px_1fr_235px]">
            <AnimalAvatar seed={child?.name} kind="child" className="h-24 w-24 ring-4 ring-white shadow-soft" />
            <div>
              <h1 className="text-[30px] font-black">{child?.name ?? "Your child"}</h1>
              {child && <p className="mt-1.5 text-base font-semibold">{formatChildAge(child.date_of_birth)}</p>}
              {child && child.interests.length > 0 && (
                <>
                  <p className="mt-4 flex items-center gap-2 font-bold"><Icon name="heart" className="h-4 w-4 text-[#FA5D93]" /> Interests</p>
                  <p className="mt-2 max-w-[200px] text-sm font-semibold capitalize leading-6">{child.interests.map((i) => i.replace(/-/g, " ")).join(", ")}</p>
                </>
              )}
              <Button href="/edit-profile" variant="outline" className="mt-6"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
            </div>
            <div className="rounded-[10px] bg-[#fff0f5] p-5">
              <h2 className="mb-4 text-lg font-black">{child ? `${child.name}'s journey` : "Journey"}</h2>
              {[
                [`${journey?.classes_attended ?? 0} activities attended`, "calendar"],
                [`${journey?.venues_explored ?? 0} venues explored`, "pin"],
                [`${journey?.hours_of_learning ?? 0} hours completed`, "clock"],
              ].map(([item, icon]) => (
                <p key={item} className="mb-4 flex items-center gap-2 text-base font-black text-[#0d62e8]"><Icon name={icon} className="h-4 w-4" /> <span className="text-baby-ink">{item}</span></p>
              ))}
            </div>
          </div>

          <section className="mt-6">
            <SectionTitle action={<a href="/profile?tab=favorites" className="font-bold text-[#FA5D93]">View all →</a>}>Saved activities</SectionTitle>
            <div className="grid gap-4 md:grid-cols-3">
              {favs.slice(0, 3).map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
              {favs.length === 0 && <p className="font-semibold text-[#68718f]">Nothing saved yet — tap the heart on any activity.</p>}
            </div>
          </section>

          <section className="mt-6">
            <SectionTitle action={<a href="/matches" className="font-bold text-[#FA5D93]">See all matches →</a>}>Suggested activities</SectionTitle>
            <div className="grid gap-4 md:grid-cols-3">
              {recs.slice(0, 3).map((r) => r.activity && <ActivityCard key={r.id} activity={toCard(r.activity)} />)}
              {recs.length === 0 && <p className="font-semibold text-[#68718f]">Recommendations appear once your child profile is complete.</p>}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="mb-3 text-[22px] font-black">Quick access</h2>
            <div className="grid gap-3 md:grid-cols-4">
              {[
                { label: "My bookings", icon: "calendar", href: "/profile?tab=bookings", copy: "Manage your activities" },
                { label: "Favourites", icon: "heart", href: "/profile?tab=favorites", copy: "Activities you've saved" },
                { label: "Packages", icon: "store", href: "/profile?tab=packages", copy: "Use your passes" },
                { label: "Explore nearby", icon: "pin", href: "/explore", copy: "Discover activities near you" },
              ].map((t) => <CategoryTile key={t.label} icon={t.icon} label={t.label} copy={t.copy} href={t.href} />)}
            </div>
          </section>
          </>
          )}

          {tab === "children" && session && (
            <ChildrenTab
              parentId={session.user.id}
              kids={children}
              refresh={refresh}
              bookings={bookings}
              recsByChild={recsByChild}
            />
          )}

          {tab === "bookings" && (
            <div>
              <h1 className="mb-1 text-[26px] font-black">Bookings</h1>
              <p className="text-sm font-semibold text-[#59658d]">Classes still to come. Once a class time has passed it moves to Past activities.</p>
              <BookingList items={upcomingBookings} emptyCopy="You haven't booked any upcoming classes yet." onChanged={loadBookings} isPlus={isPlus} />
            </div>
          )}

          {tab === "past" && (
            <PastActivitiesTab items={pastBookings} onChanged={loadBookings} />
          )}

          {tab === "packages" && !isPlus && (
            <PlusLock
              title="Packages are a Plus feature"
              copy="With Plus, every class pack you buy through BabyBrain is stored here and you can click straight through to book. On the free plan we email your pack details to you instead."
            />
          )}
          {tab === "packages" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Packages</h1>
              <p className="mt-1 text-sm font-semibold text-[#59658d]">Class packs you've bought through BabyBrain — each booking with that provider can use a credit. Packs bought directly with a provider won't appear here.</p>
              {packages.length === 0 ? (
                <EmptyPanel icon="store" copy="No packages yet. Providers offering class packs show a 'Buy pack' option on their class pages." cta="Browse activities" href="/explore" />
              ) : (
                <div className="mt-4 space-y-3">
                  {packages.map((p) => (
                    <div key={p.id} className={`flex items-center gap-4 rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card ${p.status === "expired" ? "opacity-60" : ""}`}>
                      <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#ffe9f2] text-baby-pink"><Icon name="store" className="h-6 w-6" /></span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-black">{p.name}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">{p.provider}</p>
                        {p.expiresAt && (
                          <p className={`text-xs font-bold ${p.status === "expired" ? "text-[#b00040]" : "text-[#9aa4c2]"}`}>
                            {p.status === "expired" ? "Expired" : "Expires"} {sgDay(p.expiresAt)}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        {p.status === "expired" ? (
                          <span className="rounded-full bg-[#f1efe8] px-3 py-1 text-xs font-bold text-[#7a725c]">Expired</span>
                        ) : (
                          <>
                            <p className="text-lg font-black text-baby-pink">{p.remaining}<span className="text-sm text-[#9aa4c2]">/{p.total}</span></p>
                            <p className="text-xs font-bold text-[#9aa4c2]">credits left</p>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "makeup" && !isPlus && (
            <PlusLock
              title="Make-up tokens are a Plus feature"
              copy="With Plus, tokens from every provider are gathered here and you can click straight through to rebook. On the free plan they come to you by email."
            />
          )}
          {tab === "makeup" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Make-up tokens</h1>
              <p className="mt-1 text-sm font-semibold text-[#59658d]">Credits from a provider for a missed class — redeem them when you book a future session with that provider.</p>
              {tokens.length === 0 ? (
                <EmptyPanel icon="gift" copy="No make-up tokens yet. If you miss a class, your provider can issue one here." />
              ) : (
                <div className="mt-4 space-y-3">
                  {tokens.map((t) => (
                    <div key={t.id} className="flex items-center gap-4 rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                      <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#fff4d6] text-[#8a6d1a]"><Icon name="gift" className="h-6 w-6" /></span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-black">{t.provider}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">
                          Issued {sgDay(t.created_at)}
                          {t.expires_at ? ` · expires ${sgDay(t.expires_at)}` : ""}
                        </p>
                      </div>
                      {t.status === "issued" && t.originSlug && (
                        <Button href={`/book?slug=${t.originSlug}&token=${t.id}`} size="sm" variant="outline">Redeem</Button>
                      )}
                      <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${tokenStatusStyle(t.status)}`}>{t.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "favorites" && !isPlus && (
            <PlusLock
              title="Saved favourites are a Plus feature"
              copy="Upgrade to keep your favourite activities and providers on your own list and map, so you can come back to them any time."
            />
          )}
          {tab === "favorites" && isPlus && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Favourites</h1>
              {favs.length === 0 ? (
                <EmptyPanel icon="heart" copy="Nothing saved yet — tap the heart on any activity." cta="Browse activities" href="/explore" />
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {favs.map((activity) => (
                    <ActivityCard
                      key={activity.id}
                      activity={activity}
                      onFavoriteToggled={(id, saved) => {
                        if (!saved) setFavs((prev) => prev.filter((a) => a.id !== id));
                      }}
                    />
                  ))}
                </div>
              )}

              {savedProviders.length > 0 && (
                <div className="mt-8">
                  <h2 className="mb-3 text-xl font-black">Saved providers</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {savedProviders.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                        <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-[#ffe9f2] text-baby-pink"><Icon name="store" className="h-5 w-5" /></span>
                        <h3 className="truncate font-black">{p.name}</h3>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "reviews" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Reviews</h1>
              {reviews.length === 0 ? (
                <EmptyPanel icon="star" copy="You haven't written any reviews yet." cta="Browse activities" href="/explore" />
              ) : (
                <div className="space-y-3">
                  {reviews.map((r) => (
                    <div key={r.id} className="rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                      <div className="flex items-center justify-between">
                        <a href={r.slug ? `/activity?slug=${r.slug}` : "/explore"} className="font-black hover:text-baby-pink">{r.title}</a>
                        <span className="flex gap-0.5 text-[#ffb71b]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-4 w-4 fill-current" />)}</span>
                      </div>
                      {r.comment && <p className="mt-1.5 font-semibold text-[#34406f]">{r.comment}</p>}
                      {r.providerResponse && (
                        <div className="mt-2 rounded-[10px] bg-[#fff7fb] p-3">
                          <p className="text-xs font-black text-baby-pink">Response from the provider</p>
                          <p className="mt-1 text-sm font-semibold text-[#34406f]">{r.providerResponse}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "notifications" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Notifications</h1>
              {notifications.length === 0 ? (
                <EmptyPanel icon="bell" copy="No notifications yet — booking updates and reminders will show up here." />
              ) : (
                <div className="space-y-2.5">
                  {notifications.map((n) => (
                    <div key={n.id} className={`rounded-[12px] border p-4 shadow-card ${n.read_at ? "border-[#e7ebf6] bg-white" : "border-[#cfe2ff] bg-[#fff4f8]"}`}>
                      <div className="flex items-start gap-2">
                        {!n.read_at && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-baby-pink" />}
                        <div>
                          <p className="font-black">{n.title}</p>
                          {n.body && <p className="mt-0.5 text-sm font-semibold text-[#59658d]">{n.body}</p>}
                          <p className="mt-1 text-xs font-semibold text-[#9aa4c2]">{sgDateTime(n.created_at)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Settings</h1>

              {getParam("billing") === "success" && (
                <div className="mb-4 rounded-[12px] border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700">
                  🎉 Welcome to Plus! Your subscription is active — your first month is free.
                </div>
              )}

              {/* Plan & Billing */}
              <div className="mb-4 rounded-[14px] border border-[#e7ebf6] bg-white p-6 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-[#9aa4c2]">Plan</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-black">
                      <Icon name={billingPlan?.plan === "plus" ? "star" : "heart"} className="h-5 w-5 text-baby-pink" />
                      {billingPlan?.plan === "plus" ? "BabyBrain Plus" : "Free"}
                      {billingPlan?.status === "trialing" && (
                        <span className="rounded-full bg-[#ffe9f2] px-2 py-0.5 text-xs font-bold text-baby-pink">Free trial</span>
                      )}
                      {billingPlan?.cancel_at_period_end && (
                        <span className="rounded-full bg-[#fff4e5] px-2 py-0.5 text-xs font-bold text-[#8a5a00]">Cancels at period end</span>
                      )}
                    </p>
                    {billingPlan?.plan === "plus" && billingPlan.current_period_end && (
                      <p className="mt-1 text-sm font-semibold text-[#59658d]">
                        {billingPlan.cancel_at_period_end ? "Access until" : "Renews on"}{" "}
                        {sgDay(billingPlan.current_period_end)}
                      </p>
                    )}
                  </div>
                  {billingPlan?.plan === "plus" ? (
                    <Button type="button" variant="outline" onClick={manageBilling} disabled={billingBusy}>
                      {billingBusy ? "Opening…" : "Manage / Cancel"}
                    </Button>
                  ) : (
                    <Button href="/pricing"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
                  )}
                </div>
                {billingPlan?.terms_accepted_at && (
                  <p className="mt-4 border-t border-[#eef1f7] pt-3 text-xs font-semibold text-[#9aa4c2]">
                    <Icon name="check" className="mr-1 inline h-3.5 w-3.5 text-green-500" />
                    Terms &amp; Conditions accepted on {sgDay(billingPlan.terms_accepted_at)}
                    {billingPlan.terms_version ? ` (v${billingPlan.terms_version})` : ""} ·{" "}
                    <a href="/terms" className="text-baby-pink underline">View terms</a>
                  </p>
                )}
              </div>

              <div className="space-y-4 rounded-[14px] border border-[#e7ebf6] bg-white p-6 shadow-card">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-[#9aa4c2]">Name</p>
                  <p className="font-black">{profile?.full_name || "—"}</p>
                </div>
                <div className="border-t border-[#eef1f7] pt-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-[#9aa4c2]">Email</p>
                  <p className="font-black">{session?.user.email || "—"}</p>
                </div>
                <div className="flex flex-wrap gap-3 border-t border-[#eef1f7] pt-4">
                  <Button href="/edit-profile" variant="outline"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
                  <Button href="/forgot-password" variant="outline"><Icon name="lock" className="h-4 w-4" /> Change password</Button>
                  <Button type="button" variant="soft" onClick={() => signOut()}>Sign out</Button>
                </div>
              </div>

              <DeleteAccountPanel isPlus={isPlus} />
            </div>
          )}
        </section>
      </main>
    </PageShell>
  );
}

/** Settings → Delete account. Typing DELETE is the confirmation; the route
 *  cancels any live Plus subscription before removing the account. */
function DeleteAccountPanel({ isPlus }: { isPlus: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/customer/account", { confirm: "DELETE" });
      await supabase.auth.signOut();
      window.location.href = "/?deleted=1";
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "We couldn't delete your account — please contact hello@babybrain.sg.");
    }
  }

  return (
    <div className="mt-4 rounded-[14px] border border-[#ffd2de] bg-white p-6 shadow-card">
      <h2 className="font-black text-[#b00040]">Delete your account</h2>
      <p className="mt-1 text-sm font-semibold text-[#59658d]">
        This removes your profile, your children's details, preferences and saved activities.
        {isPlus ? " Your Plus subscription is cancelled at the same time, so you won't be charged again." : ""}
        {" "}It can't be undone.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-[11px] border border-[#ffd2de] px-5 py-2.5 text-sm font-extrabold text-[#d63964] hover:bg-[#fff5f8]"
        >
          Delete account
        </button>
      ) : (
        <div className="mt-4 rounded-[12px] bg-[#fff5f8] p-4">
          {/* The input is `block` so it sits under the instruction rather than
              running on beside it, and lines up with the buttons below. */}
          <label htmlFor="delete-confirm" className="block text-sm font-black text-[#b00040]">
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2 block h-11 w-full max-w-[220px] rounded-[10px] border border-[#ffd2de] px-3 text-sm font-semibold"
            placeholder="DELETE"
          />
          {error && <p className="mt-3 text-sm font-bold text-[#b00040]">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={confirm !== "DELETE" || busy}
              onClick={remove}
              className={`rounded-[11px] px-5 py-2.5 text-sm font-extrabold text-white ${
                confirm === "DELETE" && !busy ? "bg-[#d63964] hover:brightness-105" : "cursor-not-allowed bg-[#e6a9bd]"
              }`}
            >
              {busy ? "Deleting…" : "Permanently delete"}
            </button>
            <Button type="button" variant="outline" onClick={() => { setOpen(false); setConfirm(""); setError(null); }}>
              Keep my account
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Past classes, split by whether the parent (or the provider) marked them as
 *  attended. QA: "Once time has passed for a class, it was still showing in
 *  bookings… Can we call this Past activities and have an attended and not
 *  attended section?" */
function PastActivitiesTab({ items, onChanged }: { items: BookingItem[]; onChanged: () => void }) {
  const [marks, setMarks] = useState<Record<string, "present" | "absent">>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (items.length === 0) return;
    supabase
      .from("attendance")
      .select("booking_id, status")
      .in("booking_id", items.map((b) => b.id))
      .then(({ data }) => {
        const next: Record<string, "present" | "absent"> = {};
        for (const row of (data ?? []) as unknown as { booking_id: string; status: string }[]) {
          if (row.status === "present" || row.status === "late") next[row.booking_id] = "present";
          else if (row.status === "absent") next[row.booking_id] = "absent";
        }
        setMarks(next);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((b) => b.id).join(",")]);

  async function mark(b: BookingItem, status: "present" | "absent") {
    setBusyId(b.id);
    setError(null);
    const { error: err } = await supabase.rpc("mark_own_attendance", {
      p_booking_id: b.id,
      p_status: status,
    });
    setBusyId(null);
    if (err) {
      setError(err.message.replace(/^.*?:\s*/, ""));
      return;
    }
    setMarks((m) => ({ ...m, [b.id]: status }));
    onChanged();
  }

  // A completed booking counts as attended even if nobody ticked it.
  const statusOf = (b: BookingItem) => marks[b.id] ?? (b.status === "completed" ? "present" : null);
  const attended = items.filter((b) => statusOf(b) === "present");
  const notAttended = items.filter((b) => statusOf(b) === "absent");
  const unmarked = items.filter((b) => statusOf(b) === null);

  function Row({ b }: { b: BookingItem }) {
    const state = statusOf(b);
    return (
      <div className="rounded-[12px] border border-[#e7ebf6] bg-white p-3 shadow-card">
        <div className="flex items-center gap-4">
          <img src={b.image} alt="" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover" />
          <div className="min-w-0 flex-1">
            <a href={b.slug ? `/activity?slug=${b.slug}` : "/explore"} className="block truncate font-black hover:text-baby-pink">{b.title}</a>
            {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
          </div>
          {state && (
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${state === "present" ? "bg-[#eefbf1] text-green-700" : "bg-[#f1efe8] text-[#7a725c]"}`}>
              {state === "present" ? "Attended" : "Not attended"}
            </span>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2 border-t border-[#f2f4fa] pt-2">
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "present")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "present" ? "border border-green-200 bg-[#eefbf1] text-green-700" : "border border-[#ecdfe6] text-[#FA5D93] hover:bg-[#fff4f8]"}`}
          >
            We went
          </button>
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "absent")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "absent" ? "border border-[#e3e7f2] bg-[#f5f6fa] text-[#5a6484]" : "border border-[#ecdfe6] text-[#FA5D93] hover:bg-[#fff4f8]"}`}
          >
            We missed it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-[26px] font-black">Past activities</h1>
      <p className="text-sm font-semibold text-[#59658d]">Classes whose time has passed. Tell us whether you made it — your provider can mark this too.</p>
      {error && <p className="mt-3 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}

      {items.length === 0 ? (
        <EmptyPanel icon="check" copy="Nothing here yet — classes move across once their time has passed." cta="Browse activities" href="/explore" />
      ) : (
        <div className="mt-4 space-y-6">
          {unmarked.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-black text-[#46527d]">Did you make it? ({unmarked.length})</h2>
              <div className="space-y-3">{unmarked.map((b) => <Row key={b.id} b={b} />)}</div>
            </section>
          )}
          <section>
            <h2 className="mb-2 text-sm font-black text-[#46527d]">Attended ({attended.length})</h2>
            {attended.length === 0
              ? <p className="rounded-[12px] bg-[#fff7fb] p-4 text-sm font-semibold text-[#68718f]">No attended classes recorded yet.</p>
              : <div className="space-y-3">{attended.map((b) => <Row key={b.id} b={b} />)}</div>}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-black text-[#46527d]">Not attended ({notAttended.length})</h2>
            {notAttended.length === 0
              ? <p className="rounded-[12px] bg-[#fff7fb] p-4 text-sm font-semibold text-[#68718f]">Nothing missed — nice work.</p>
              : <div className="space-y-3">{notAttended.map((b) => <Row key={b.id} b={b} />)}</div>}
          </section>
        </div>
      )}
    </div>
  );
}

function BookingList({ items, emptyCopy, onChanged, isPlus = true }: { items: BookingItem[]; emptyCopy: string; onChanged?: () => void; isPlus?: boolean }) {
  // 2.2: cancel / reschedule with vendor-configured policies. Unavailable
  // actions grey out and explain themselves in a pop-up.
  const [notice, setNotice] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<BookingItem | null>(null);
  const [reschedSessions, setReschedSessions] = useState<{ id: string; starts_at: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const hoursLabel = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);
  const upcoming = (b: BookingItem) =>
    b.startsAt != null && new Date(b.startsAt) > new Date() && ["pending", "confirmed", "waitlisted"].includes(b.status);
  const cutoffPassed = (b: BookingItem, hours: number) =>
    b.startsAt != null && new Date(b.startsAt).getTime() - hours * 36e5 < Date.now();

  const cancelBlockReason = (b: BookingItem) =>
    !b.allowCancel
      ? "The provider does not allow cancellations for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.cancelCutoffH)
        ? `The cancellation window for this class has closed — cancellations close ${hoursLabel(b.cancelCutoffH)} before the session.`
        : null;
  const reschedBlockReason = (b: BookingItem) =>
    !b.allowReschedule
      ? "The provider does not allow rescheduling for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.resCutoffH)
        ? `The rescheduling window for this class has closed — rescheduling closes ${hoursLabel(b.resCutoffH)} before the session.`
        : null;

  async function doCancel(b: BookingItem) {
    if (!window.confirm(`Cancel your booking for ${b.title}?`)) return;
    setBusyId(b.id);
    const { error } = await supabase.rpc("cancel_booking", { p_booking_id: b.id });
    setBusyId(null);
    if (error) setNotice(error.message.replace(/^.*?:\s*/, ""));
    else onChanged?.();
  }

  async function openReschedule(b: BookingItem) {
    if (!b.activityId) return;
    setReschedFor(b);
    const { data } = await supabase
      .from("activity_sessions")
      .select("id, starts_at")
      .eq("activity_id", b.activityId)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(12);
    setReschedSessions((data ?? []).filter((s) => s.starts_at !== b.startsAt));
  }

  async function doReschedule(newSessionId: string) {
    if (!reschedFor) return;
    setBusyId(reschedFor.id);
    const { error } = await supabase.rpc("reschedule_booking", { p_booking_id: reschedFor.id, p_new_session_id: newSessionId });
    setBusyId(null);
    setReschedFor(null);
    if (error) setNotice(error.message.replace(/^.*?:\s*/, ""));
    else onChanged?.();
  }

  if (items.length === 0) return <EmptyPanel icon="calendar" copy={emptyCopy} cta="Browse activities" href="/explore" />;
  // Non-cancelled classes with a scheduled time can be exported as one calendar.
  const exportable = items.filter((b) => b.startsAt && b.status !== "cancelled");
  return (
    <div className="mt-4 space-y-3">
      {exportable.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {/* Calendar sync and the exportable schedule are Plus features. */}
          {isPlus ? (
            <>
              <button
                type="button"
                onClick={() =>
                  downloadScheduleIcs(
                    exportable.map((b) => ({ id: b.id, title: b.title, startsAt: b.startsAt!, endsAt: b.endsAt, venue: b.venue }))
                  )
                }
                className="flex items-center gap-1.5 rounded-[9px] border border-[#ecdfe6] px-3 py-1.5 text-xs font-bold text-[#FA5D93] hover:bg-[#fff4f8]"
                title={`Export all ${exportable.length} classes to your calendar`}
              >
                <Icon name="calendar" className="h-3.5 w-3.5" /> Export all to calendar
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadSchedulePdf(
                    exportable.map((b) => ({
                      title: b.title,
                      startsAt: b.startsAt!,
                      endsAt: b.endsAt,
                      venue: b.venue,
                      status: b.status,
                    }))
                  )
                }
                className="flex items-center gap-1.5 rounded-[9px] border border-[#ecdfe6] px-3 py-1.5 text-xs font-bold text-[#FA5D93] hover:bg-[#fff4f8]"
                title="Open a printable schedule you can save as PDF"
              >
                <Icon name="open" className="h-3.5 w-3.5" /> Download PDF schedule
              </button>
            </>
          ) : (
            <a
              href="/pricing"
              className="flex items-center gap-1.5 rounded-[9px] border border-[#e3e7f2] bg-[#f5f6fa] px-3 py-1.5 text-xs font-bold text-[#9aa3bd] hover:border-baby-pink hover:text-[#FA5D93]"
              title="Calendar sync and PDF export are Plus features"
            >
              <Icon name="lock" className="h-3.5 w-3.5" /> Calendar &amp; PDF export — Plus
            </a>
          )}
        </div>
      )}
      {items.map((b) => {
        const cancelWhy = cancelBlockReason(b);
        const reschedWhy = reschedBlockReason(b);
        return (
          <div key={b.id} className="rounded-[12px] border border-[#e7ebf6] bg-white p-3 shadow-card transition hover:border-baby-pink">
            <a href={b.slug ? `/activity?slug=${b.slug}` : "/explore"} className="flex items-center gap-4">
              <img src={b.image} alt="" className="h-16 w-16 flex-shrink-0 rounded-[10px] object-cover" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-black">{b.title}</h3>
                {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
              </div>
              {b.startsAt && b.status !== "cancelled" && isPlus && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    downloadBookingIcs({ id: b.id, title: b.title, startsAt: b.startsAt!, endsAt: b.endsAt, venue: b.venue });
                  }}
                  className="hidden items-center gap-1 rounded-[9px] border border-[#ecdfe6] px-3 py-1.5 text-xs font-bold text-[#FA5D93] hover:bg-[#fff4f8] sm:flex"
                  title="Add to calendar"
                >
                  <Icon name="calendar" className="h-3.5 w-3.5" /> Add to calendar
                </button>
              )}
              <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${bookingStatusStyle(b.status)}`}>{b.status}</span>
            </a>
            {upcoming(b) && (
              <div className="mt-2 flex justify-end gap-2 border-t border-[#f2f4fa] pt-2">
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => (reschedWhy ? setNotice(reschedWhy) : openReschedule(b))}
                  className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${
                    reschedWhy
                      ? "cursor-not-allowed border border-[#e3e7f2] bg-[#f5f6fa] text-[#9aa3bd]"
                      : "border border-[#ecdfe6] text-[#FA5D93] hover:bg-[#fff4f8]"
                  }`}
                  title={reschedWhy ?? "Move this booking to another session"}
                >
                  Reschedule
                </button>
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => (cancelWhy ? setNotice(cancelWhy) : doCancel(b))}
                  className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${
                    cancelWhy
                      ? "cursor-not-allowed border border-[#e3e7f2] bg-[#f5f6fa] text-[#9aa3bd]"
                      : "border border-[#ffd2de] text-[#d63964] hover:bg-[#fff5f8]"
                  }`}
                  title={cancelWhy ?? "Cancel this booking"}
                >
                  {busyId === b.id ? "Working…" : "Cancel booking"}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Explanatory pop-up for unavailable actions / errors */}
      {notice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setNotice(null)}>
          <div className="w-full max-w-sm rounded-[16px] bg-white p-6 text-center shadow-card" onClick={(e) => e.stopPropagation()}>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-amber-500"><Icon name="bell" className="h-6 w-6" /></span>
            <p className="mt-4 font-semibold text-[#3f4b78]">{notice}</p>
            <Button type="button" className="mt-5 w-full" onClick={() => setNotice(null)}>Got it</Button>
          </div>
        </div>
      )}

      {/* Reschedule picker */}
      {reschedFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setReschedFor(null)}>
          <div className="w-full max-w-md rounded-[16px] bg-white p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-black">Reschedule {reschedFor.title}</h3>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Pick a new session — your booking moves instantly.</p>
            <div className="mt-4 max-h-64 space-y-2 overflow-auto">
              {reschedSessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => doReschedule(s.id)}
                  className="flex w-full items-center justify-between rounded-[10px] border border-[#e7ebf6] px-4 py-2.5 text-left text-sm font-bold text-[#3f4b78] hover:border-baby-pink hover:bg-[#fff4f8]"
                >
                  {sgDateTime(s.starts_at)}
                  <Icon name="calendar" className="h-4 w-4 text-[#FA5D93]" />
                </button>
              ))}
              {reschedSessions.length === 0 && <p className="py-4 text-center text-sm font-semibold text-[#8a93b2]">No other upcoming sessions for this class.</p>}
            </div>
            <Button type="button" variant="outline" className="mt-4 w-full" onClick={() => setReschedFor(null)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyPanel({ icon, copy, cta, href }: { icon: string; copy: string; cta?: string; href?: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-[#dbe3f4] bg-white p-10 text-center">
      <Icon name={icon} className="mx-auto h-8 w-8 text-[#b9c3de]" />
      <p className="mt-3 font-semibold text-[#68718f]">{copy}</p>
      {cta && href && <Button href={href} variant="outline" className="mt-4">{cta}</Button>}
    </div>
  );
}

const SUPPORT_EMAIL = "hello@babybrain.sg";
const SUPPORT_PHONE = "+65 8996 6716"; // BabyBrain support line (call + WhatsApp)
const phoneDigits = (p: string) => p.replace(/[^\d]/g, "");

const FAQ_LINK = "font-black text-baby-pink hover:underline";
const FAQ_GROUPS: { group: string; items: [string, React.ReactNode][] }[] = [
  {
    group: "Booking & getting started",
    items: [
      ["How does booking work?", "For providers integrated with BabyBrain, you find a class you like, select your package and session, and book directly through us — no contact forms, no waiting for a reply. For providers who aren't integrated, we'll redirect you to their site to book."],
      ["Why can I book some providers on BabyBrain but get sent to others' websites?", "It depends on the plan each provider is on. Some are fully set up to book directly through BabyBrain; others aren't there yet or have decided not to integrate, so we send you to their site to book. We're working on getting more providers fully integrated to make the process smoother for you."],
      ["What happens after I book?", "You'll get a booking confirmation by email, along with reminders before your class so nothing slips."],
      ["What if I need to cancel or reschedule?", "Cancellation and rescheduling policies are set by each provider and vary, so check the provider's page for the details before you book."],
      ["Can I get a refund?", "Whether a refund is issued is decided by each provider, under the policy on their page. Have a look there before booking so you know where you stand."],
      ["What happens if a provider cancels a class?", "You'll get an email letting you know. What happens next — a make-up token, a refund, or something else — depends on that provider's policy."],
      ["Do I have to create an account?", "Yes — you'll need a free account to book and to receive your confirmations and reminders. It only takes a minute."],
    ],
  },
  {
    group: "Cost & payment",
    items: [
      ["Does BabyBrain cost anything to use?", "BabyBrain is free to browse and book — you just pay the price of the activity. If you'd like extras like saved profiles, pass tracking and calendar sync, our Plus plan is SGD 9/month or SGD 99/year on top of activity prices."],
      ["How do I pay?", "PayNow, Apple Pay, Google Pay or card — whatever's easiest for you."],
      ["Is my payment secure?", "Payments are handled by Stripe, a global provider trusted by millions of businesses. Your card details are never stored by BabyBrain."],
    ],
  },
  {
    group: "Managing your account",
    items: [
      ["Can I manage passes I've already bought?", "Yes — with Plus, your packages and make-up tokens across every provider live in one place on your profile, so you never lose track of what you've paid for. Just click through to use them. On the free plan, these are sent to you by email to use from there."],
      ["How do make-up classes work?", "Make-up tokens follow each provider's own rules. With Plus, they're gathered on your profile and you click through to book one. On the free plan, they come to you by email and you book from the link there."],
      ["What if I have more than one child?", "With Plus, your saved profile holds all your children, and you'll see recommendations based on their ages and your preferences — with every booking, for all of them, in one place."],
      ["Why should I upgrade to Plus?", "Free covers everything you need to browse & book. Plus (SGD 9/month or SGD 99/year) makes planning and managing your bookings seamless: saved profiles for multiple children, all your passes and make-up tokens in one place, saved favourites, curated activity emails, calendar sync and an exportable schedule for grandparents and helpers, messaging, and priority support."],
      ["Can I cancel my Plus subscription anytime?", "Yes. On the monthly plan you can cancel anytime with 14 days' notice. The annual plan runs for the full year and isn't refundable if you cancel partway through."],
      ["Why can I see messages from parents and the provider but not respond?", "Seeing messages on your booked classes comes with every account. Sending them is a Plus feature — and the provider needs to offer messaging too. Upgrade to Plus, and where the provider has it enabled, you'll be able to message them and other parents in the class."],
      ["How do I refer a friend?", <>Refer a friend to Plus, and when they sign up for a paid subscription, you get a free month. Your referral link lives on your <a href="/profile" className={FAQ_LINK}>account page</a> under “Invite friends”.</>],
    ],
  },
  {
    group: "Providers & activities",
    items: [
      ["Are the providers on BabyBrain vetted or endorsed?", "Every provider here has been tried and tested by the parent community behind BabyBrain. That's not formal vetting, and we don't take liability for the activities — but it does mean real parents have used them."],
      ["There's an activity I love that I can't find here — can I ask for it to be added?", <>Yes, please do — we're always growing our list, just drop us a message via our <a href="/contact" className={FAQ_LINK}>Contact Us page</a>.</>],
      ["I'm an activity provider — how do I join?", <>We'd love to have a conversation with you. Head to our <a href="/vendor/" className={FAQ_LINK}>For Partners page</a> and send us an enquiry.</>],
    ],
  },
  {
    group: "Privacy & safety",
    items: [
      ["How is my data — and my children's information — handled?", <>We take your family's privacy seriously and only collect what we need to run your account and bookings — like your details, your children's ages and preferences, and payment through Stripe (we never store your card). Full details are in our <a href="/terms#privacy" className={FAQ_LINK}>Privacy Policy</a>.</>],
      ["Does BabyBrain advise on what's right for my child's development?", "We share recommendations to make finding activities easier, but we do not provide professional advice. For anything to do with your child's health or development, always speak to a qualified professional."],
    ],
  },
];

/** Contact form that emails the support inbox.
 *
 *  QA: "Bottom of contact page, doesn't make sense to have 'still need help'
 *  and 'send us a message' since that is directly above — could we add a
 *  contact form here which sends to the e-mail?" */
function ContactForm() {
  const { session, profile } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill for signed-in parents so they don't retype what we already know.
  useEffect(() => {
    if (profile?.full_name) setName(profile.full_name);
    if (session?.user.email) setEmail(session.user.email);
  }, [profile, session]);

  const input = "h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 text-sm font-semibold focus:border-baby-pink focus:outline-none";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Please tell us your name.");
    const emailProblem = emailError(email);
    if (emailProblem) return setError(emailProblem);
    if (message.trim().length < 10) return setError("Please add a little more detail to your message.");
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/contact", {
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        message: message.trim(),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't send that — please email us directly.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-[18px] border border-[#e7ebf6] bg-white p-8 text-center shadow-card">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eafaf0] text-[#28a765]"><Icon name="check" className="h-8 w-8" /></span>
        <h2 className="mt-4 text-2xl font-black">Message sent</h2>
        <p className="mt-2 font-semibold text-[#59658d]">Thanks {name.split(" ")[0]} — we endeavour to reply within 3 days.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[18px] border border-[#e7ebf6] bg-white p-6 shadow-card sm:p-8">
      <h2 className="text-[28px] font-black leading-tight text-baby-orange">Still don't have the answer you are looking for?</h2>
      <h3 className="mt-2 text-2xl font-black">Send us a message</h3>
      <p className="mt-1 font-semibold text-[#68718f]">Fill this in and it comes straight to our inbox.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-black">Your name</label>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sarah Tan" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-black">Email address</label>
          <input type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
        </div>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-sm font-black">Subject <span className="font-semibold text-[#8a93b2]">(optional)</span></label>
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's this about?" />
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-sm font-black">Message</label>
        <textarea
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help?"
          className="w-full rounded-[10px] border border-[#ecdfe6] px-3 py-2.5 text-sm font-semibold focus:border-baby-pink focus:outline-none"
        />
      </div>
      {error && <p role="alert" className="mt-3 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
      <Button type="submit" className="mt-4 w-full justify-center sm:w-auto" disabled={busy}>
        {busy ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}

function ContactPage() {
  const { session } = useAuth();
  const [support, setSupport] = useState(false);
  const openSupport = () => {
    if (!session) { window.location.href = "/login"; return; }
    setSupport(true);
  };

  // Vite renders after the browser has already tried to resolve #faq, so a
  // link from another page landed at the top of Contact. Scroll once mounted.
  useEffect(() => {
    if (window.location.hash !== "#faq") return;
    const t = setTimeout(() => {
      document.getElementById("faq")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
    {support && <SupportChat onClose={() => setSupport(false)} />}
    <PageShell active="/contact">
      <main className="mx-auto max-w-[1024px] px-6 py-8">
        <section className="grid items-center gap-7 md:grid-cols-[1fr_420px]">
          <div>
            <p className="mb-5 flex items-center gap-2 text-lg font-black text-baby-pink">We're here to help! <Icon name="heart" className="h-5 w-5 fill-current" /></p>
            <h1 className="text-[40px] font-black leading-tight">How can our team support you today?</h1>
            <p className="mt-5 text-lg font-semibold leading-8 text-[#68718f]">Have a question, feedback, or need assistance? Our team is happy to help.</p>
          </div>
          <div className="relative">
            <div className="absolute left-4 top-16 rounded-[16px] bg-white p-5 font-semibold leading-7 shadow-soft">We endeavor to<br />respond within 3 days.<br />If more urgent,<br />please call us. <Icon name="heart" className="inline h-4 w-4 fill-current text-baby-pink" /></div>
            <img src={`${import.meta.env.BASE_URL}assets/crops/baby-character.png`} alt="" className="ml-auto h-[280px] object-contain" />
          </div>
        </section>

        <section className="mt-8">
          <SectionTitle>Get in touch</SectionTitle>
          <div className="grid gap-5 md:grid-cols-4">
            {[
              { icon: "whatsapp", title: "WhatsApp us", tag: "Recommended", copy: "Message us on WhatsApp for the quickest response.", label: "Chat on WhatsApp", variant: "pink", href: `https://wa.me/${phoneDigits(SUPPORT_PHONE)}` },
              { icon: "pen", title: "Message us", tag: "", copy: "Plus subscribers can chat with our team in real time.", label: "Message us", variant: "outline", onClick: openSupport },
              { icon: "mail", title: "Email us", tag: "", copy: "For more complex enquiries, send us an e-mail and we'll get back to you.", label: "Email us", variant: "outline", href: `mailto:${SUPPORT_EMAIL}` },
              { icon: "phone", title: "Call us", tag: "", copy: "Speak with our friendly support team if urgent.", label: "Call us", variant: "outline", href: `tel:+${phoneDigits(SUPPORT_PHONE)}` },
            ].map((c) => (
              <article key={c.title} className="rounded-[16px] border border-[#ecdfe6] bg-white/70 p-5 text-center shadow-card">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#fff0f5] to-[#ffe9f2] text-baby-pink"><Icon name={c.icon} className="h-9 w-9" /></div>
                <h3 className="text-xl font-black">{c.title} {c.tag && <span className="rounded-full bg-[#ffe4ef] px-2 py-1 text-[10px] text-baby-pink">{c.tag}</span>}</h3>
                <p className="my-5 text-sm font-semibold leading-6 text-[#28345f]">{c.copy}</p>
                <Button variant={c.variant === "pink" ? "pink" : "outline"} className="w-full" href={c.href} onClick={c.onClick}>{c.label}</Button>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="mt-9 scroll-mt-24">
          <SectionTitle>Frequently asked questions</SectionTitle>
          <div className="space-y-5">
            {FAQ_GROUPS.map(({ group, items }) => (
              <div key={group}>
                <h3 className="mb-2 px-1 text-lg font-black text-baby-lilac">{group}</h3>
                <div className="overflow-hidden rounded-[16px] border border-[#e8ecf6] bg-white">
                  {items.map(([question, answer]) => (
                    <details key={question} className="border-b border-[#eef1f7] px-6 py-4 last:border-b-0">
                      <summary className="cursor-pointer list-none font-bold">Q&nbsp;&nbsp; {question} <span className="float-right">⌄</span></summary>
                      <p className="mt-3 text-sm font-semibold leading-6 text-[#59658b]">{answer}</p>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="contact-form" className="mt-9 grid items-start gap-6 scroll-mt-24 md:grid-cols-[1fr_240px]">
          <ContactForm />
          <img src={`${import.meta.env.BASE_URL}assets/crops/envelope-cta.png`} alt="" className="mx-auto hidden h-40 object-contain md:block" />
        </section>
      </main>
      <Footer />
    </PageShell>
    </>
  );
}

function TermsPage() {
  const sections: { id?: string; title: string; body: React.ReactNode }[] = [
    {
      title: "1. Acceptance of Terms",
      body: "By creating an account, browsing, booking, or subscribing on BabyBrain.sg (\"BabyBrain\", \"we\", \"us\"), you agree to these Terms & Conditions and the disclosures below. If you do not agree, please do not use the platform.",
    },
    {
      title: "2. Accounts & Eligibility",
      body: "You must be at least 18 and provide accurate information. You are responsible for activity under your account and for keeping your login secure.",
    },
    {
      id: "privacy",
      title: "3. Privacy & PDPA",
      body: "We collect and process personal data in accordance with Singapore's Personal Data Protection Act (PDPA). We collect what we need to run the service (your profile, your children's ages/interests, bookings, and usage). You consent to this processing when you use BabyBrain. Our full Privacy Policy forms part of these Terms.",
    },
    {
      title: "4. Cookie Consent",
      body: "We use cookies and similar technologies for authentication, preferences, and basic analytics. By continuing to use the site you consent to essential cookies; non-essential cookies are used only where permitted.",
    },
    {
      title: "5. Children's Data",
      body: "Child details (name, date of birth, interests) are provided by you as the parent/guardian to personalise recommendations. We process them solely to deliver the service and never sell them. You may edit or delete them at any time.",
    },
    {
      title: "6. Vendor Data Sharing",
      body: "When you book, enquire, or join a class chat, we share the information necessary to fulfil that booking (e.g. your name and relevant details) with the activity provider. Providers are independent businesses responsible for their own services.",
    },
    {
      title: "7. Bookings & Payments",
      body: "Bookings are contracts between you and the provider. Payments are processed securely by Stripe; by paying you accept Stripe's payment terms. BabyBrain is not the provider of the classes and is not liable for the conduct or cancellation of a class by a provider.",
    },
    {
      title: "8. BabyBrain Plus — Subscription Terms",
      body: "BabyBrain Plus costs SGD 9/month or SGD 99/year, plus GST. New subscribers get a 30-day free trial (first month free). Billing and card details are handled by Stripe.",
    },
    {
      title: "9. Auto-Renewal Disclosure",
      body: "Plus is a recurring subscription. After any free trial, it automatically renews at the end of each billing period (monthly or yearly) and your payment method is charged until you cancel. The renewal date is shown in Profile → Settings.",
    },
    {
      title: "10. Managing & Cancelling Your Subscription",
      body: "You can view, update your card, or cancel Plus at any time from Profile → Settings → Manage / Cancel, which opens the Stripe billing portal. Cancelling stops future renewals; you keep Plus access until the end of the current paid period. See our refund policy below.",
    },
    {
      title: "11. Refunds & Cancellation Policy",
      body: "Subscription fees are non-refundable except where required by law; cancelling prevents the next charge. Class booking refunds and reschedules follow the individual provider's cancellation policy shown at booking.",
    },
    {
      title: "12. AI Planner Disclaimer",
      body: "The AI planning tool provides suggestions to help you organise activities around your schedule. It may be inaccurate or incomplete and is not professional, medical, or developmental advice. Always use your own judgement; you are responsible for decisions made using it.",
    },
    {
      title: "13. Recommendations & Personalisation",
      body: "We generate recommendations from the preferences and child details you provide and your activity on the platform. Recommendations are suggestions only and are not guarantees of suitability.",
    },
    {
      title: "14. Marketing Consent",
      body: "With your consent, we send curated-activity emails and updates. You can opt in or out at any time in your settings or via the unsubscribe link in any marketing email. Essential service messages (bookings, billing) are always sent.",
    },
    {
      title: "15. Calendar Integration Consent",
      body: "If you enable calendar reminders/sync or export, you consent to BabyBrain creating calendar entries for your bookings. You can disable this at any time.",
    },
    {
      title: "16. Reviews & Moderation",
      body: "You may review classes you have booked. Reviews must be honest and lawful. We may moderate or remove content that is abusive, misleading, or violates these Terms.",
    },
    {
      title: "17. Messaging Rules",
      body: "All users can read messages on their booked classes. Sending messages to other parents and providers is a Plus feature. Messaging must be respectful and used only for coordinating activities; misuse may lead to suspension.",
    },
    {
      title: "18. Data Retention, Deletion & Account Closure",
      body: "You have the right to access and delete your personal data. You can delete your account from your settings or by contacting us; we then remove or anonymise your data except where we must retain records (e.g. transaction records) under applicable law.",
    },
    {
      title: "19. Security",
      body: "We apply reasonable technical and organisational controls (encryption in transit, access controls, RLS) to protect your data. No system is perfectly secure, so please protect your own credentials.",
    },
    {
      title: "20. Changes & Contact",
      body: "We may update these Terms; material changes will be notified in-app or by email. Questions? Contact hello@babybrain.sg.",
    },
  ];

  return (
    <PageShell active="/terms" auth="public">
      <main className="mx-auto max-w-[820px] px-6 py-10">
        <h1 className="text-[36px] font-black leading-tight">Terms &amp; Conditions</h1>
        <p className="mt-2 text-sm font-bold text-[#9aa4c2]">Last updated: July 2026</p>
        <p className="mt-4 font-semibold leading-7 text-[#59658d]">
          These Terms cover your use of BabyBrain, including bookings, the BabyBrain Plus
          subscription, privacy, and the disclosures we're required to make. Please read them.
        </p>
        <div className="mt-8 space-y-7">
          {sections.map((s) => (
            <section key={s.title} id={s.id} className="scroll-mt-24">
              <h2 className="text-lg font-black text-baby-ink">{s.title}</h2>
              <p className="mt-2 font-semibold leading-7 text-[#59658d]">{s.body}</p>
            </section>
          ))}
        </div>
      </main>
    </PageShell>
  );
}

function PricingPage() {
  const { session } = useAuth();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [plan, setPlan] = useState<"free" | "plus">("free");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getParam("billing") === "cancelled") {
      setError("Checkout cancelled — you have not been charged.");
    }
    if (!session) return;
    apiGet<{ plan: "free" | "plus" }>("/api/customer/stripe/subscription")
      .then((s) => setPlan(s.plan))
      .catch(() => {});
  }, [session]);

  async function upgrade() {
    if (!session) {
      window.location.href = "/login";
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (plan === "plus") {
        const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/portal", {});
        if (url) window.location.href = url;
        return;
      }
      const { url } = await apiPost<{ url?: string }>(
        "/api/customer/stripe/subscription",
        { billing }
      );
      if (url) window.location.href = url;
      else setError("Could not start checkout — please try again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payments aren't available right now.");
    } finally {
      setBusy(false);
    }
  }

  const freeItems = [
    "Browse & book activities",
    "Leave reviews",
    "See messages from parents and class providers on booked classes",
  ];
  const plusItems = [
    "Everything in Free",
    "Saved profile with personalised recommendations",
    "Packages & make-up tokens for all vendors in one place",
    "Save favourite providers & places on your own map/list",
    "Emails with curated activities",
    "AI planning tool (map against nap schedules & availability)",
    "Booking reminders & calendar integration",
    "Calendar schedule view to export to grandparents & helpers",
    "Message others booked on an activity, and the provider",
    "Priority support",
  ];
  const plusPrice = billing === "monthly" ? "9" : "99";
  const plusPeriod = billing === "monthly" ? "/mo" : "/yr";

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[960px] px-6 py-8">
        <section className="text-center">
          <Icon name="heart" className="mx-auto h-9 w-9 text-baby-pink" />
          <h1 className="mt-2 text-[36px] font-black leading-tight">
            Choose the plan that's right for your family
          </h1>
          <p className="mt-2 text-lg font-semibold text-[#68718f]">
            Discover, book and enjoy the best activities for your little ones.
          </p>
          <div className="mx-auto mt-5 grid h-11 max-w-[360px] grid-cols-2 rounded-full border border-[#e2e7f4] bg-white p-1 font-black">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={billing === "monthly" ? "rounded-full bg-baby-pink text-white" : "text-[#59658d]"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={billing === "annual" ? "rounded-full bg-baby-pink text-white" : "text-[#59658d]"}
            >
              Annual <span className="text-baby-pink">(1 month free)</span>
            </button>
          </div>
        </section>

        {error && (
          <p className="mx-auto mt-5 max-w-[560px] rounded-[10px] bg-[#fff4e5] px-4 py-3 text-center text-sm font-bold text-[#8a5a00]">
            {error}
          </p>
        )}

        <section className="mt-7 grid gap-5 md:grid-cols-2">
          {/* Free */}
          <article className="relative rounded-[18px] border border-[#e7ebf6] bg-white p-6 shadow-card">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#ffe9f2] text-baby-pink">
              <Icon name="heart" className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Free</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">0</span>
            </p>
            <div className="my-5 border-t border-[#eef1f7]" />
            <div className="space-y-3">
              {freeItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-baby-pink text-baby-pink">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
            <Button href="/" variant="outline" className="mt-5 w-full">
              {plan === "free" ? "Continue Free" : "Included"}
            </Button>
          </article>

          {/* Plus */}
          <article className="relative rounded-[18px] border border-baby-pink bg-white p-6 shadow-card ring-1 ring-baby-pink/20">
            <span className="absolute left-1/2 top-[-15px] -translate-x-1/2 rounded-full bg-baby-pink px-8 py-2 text-sm font-black text-white">
              MOST POPULAR
            </span>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#f4ecff] text-baby-lilac">
              <Icon name="star" className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Plus</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">{plusPrice}</span>
              <span className="font-bold text-[#68718f]"> {plusPeriod}</span>
            </p>
            <p className="text-center text-xs font-bold text-[#9aa4c2]">+ GST</p>
            <div className="my-5 border-t border-[#eef1f7]" />
            <div className="space-y-3">
              {plusItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-baby-pink text-baby-pink">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
            <p className="mt-5 rounded-[10px] bg-[#fff0f5] px-4 py-3 text-center text-sm font-black text-baby-pink">
              First month free — cancel anytime
            </p>
            <Button
              type="button"
              onClick={upgrade}
              disabled={busy}
              variant="primary"
              className="mt-5 w-full"
            >
              {busy
                ? "Please wait…"
                : plan === "plus"
                  ? "Manage subscription"
                  : "Upgrade to Plus"}
            </Button>
            <p className="mt-3 text-center text-xs font-semibold text-[#9aa4c2]">
              Auto-renews {billing === "monthly" ? "monthly" : "yearly"} after the free month. Cancel any time from your profile.
              {" "}By subscribing you agree to our{" "}
              <a href="/terms" className="text-baby-pink underline">Terms &amp; Conditions</a>.
            </p>
          </article>
        </section>

        <section className="mt-5 grid gap-4 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card md:grid-cols-3">
          {[
            ["store", "Corporate discounts", "available for bulk packages"],
            ["calendar", "Monthly or annual billing", "Choose the plan that works for you"],
            ["shield", "Cancel anytime", "Manage your subscription from your profile"],
          ].map(([icon, title, copy]) => (
            <div key={title} className="flex items-center gap-4">
              <Icon name={icon} className="h-8 w-8 text-baby-pink" />
              <p><strong className="block">{title}</strong><span className="text-sm font-semibold text-[#59658d]">{copy}</span></p>
            </div>
          ))}
        </section>
      </main>
    </PageShell>
  );
}

function PaymentPage() {
  // Card details are collected on Stripe's hosted Checkout, never here. This
  // page just kicks off (or resumes) that secure flow for anyone landing on
  // /payment directly, then redirects.
  const { session, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      window.location.href = "/login";
      return;
    }
    apiPost<{ url?: string }>("/api/customer/stripe/subscription", { billing: "monthly" })
      .then(({ url }) => {
        if (url) window.location.href = url;
        else setError("Could not start checkout — please try again.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Payments aren't available right now."));
  }, [session, loading]);

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[520px] px-6 py-24 text-center">
        <BrandStacked className="h-24" />
        {error ? (
          <>
            <h1 className="mt-6 text-2xl font-black">We couldn't start checkout</h1>
            <p className="mt-3 font-semibold text-[#68718f]">{error}</p>
            <Button href="/pricing" className="mt-6">Back to plans</Button>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-black">Taking you to secure checkout…</h1>
            <p className="mt-3 font-semibold text-[#68718f]">You'll be redirected to Stripe to start your Plus subscription.</p>
          </>
        )}
      </main>
    </PageShell>
  );
}

/** One selectable row in the booking flow's "Choose your package" step. */
/** A row in booking step 4 — name and price on the left, the action on the
 *  right, as in the design. Selecting the row drives the main CTA; pack rows
 *  additionally offer "Buy pack", which goes straight to Stripe. */
function PackageOption({
  selected,
  onSelect,
  title,
  price,
  badge,
  action,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  badge?: string;
  /** Shown on the right for packs you can buy outright. */
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  return (
    <div
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer items-center gap-4 rounded-[12px] border-2 p-4 transition ${
        selected ? "border-baby-blue bg-[#f2f8ff]" : "border-[#dfe5f2] bg-white hover:border-[#bcd9f8]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-black">{title}</span>
          {badge && <span className="rounded-full bg-[#fff4d6] px-2 py-0.5 text-[10px] font-bold text-[#8a6d1a]">{badge}</span>}
        </div>
        <span className="mt-0.5 block text-sm font-semibold text-[#59658d]">{price}</span>
      </div>
      {action && (
        <Button
          type="button"
          variant="blue"
          size="sm"
          className={action.busy ? "shrink-0 opacity-60" : "shrink-0"}
          onClick={() => {
            onSelect();
            action.onClick();
          }}
        >
          {action.busy ? "…" : action.label}
        </Button>
      )}
    </div>
  );
}

function BookingPage() {
  const { activity, sessions, loading } = useActivityDetail(getParam("slug"));
  const { session: auth, children: kids } = useAuth();
  const redeemToken = getParam("token");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [childId, setChildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  type CreditPurchase = {
    id: string; remaining: number; expires_at: string | null;
    activity_id: string | null; allowed_weekday: number | null; allowed_start_time: string | null;
  };
  const [purchases, setPurchases] = useState<CreditPurchase[]>([]);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  // Step 4: "single" | "credit" | "pack:<id>"
  const [payWith, setPayWith] = useState<string>("single");

  // Packs this provider sells that apply to this class (or to all of theirs).
  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("packages")
      .select("id, name, credits, price_cents, activity_id")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_id: string | null }>;
        setPacks(rows.filter((p) => p.activity_id === null || p.activity_id === activity.id));
      });
  }, [activity?.provider_id, activity?.id]);

  useEffect(() => {
    if (!auth || !activity?.provider_id) return;
    supabase
      .from("package_purchases")
      .select("id, credits_remaining, expires_at, packages(activity_id, allowed_weekday, allowed_start_time)")
      .eq("provider_id", activity.provider_id)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string; credits_remaining: number; expires_at: string | null;
          packages: { activity_id: string | null; allowed_weekday: number | null; allowed_start_time: string | null } | null;
        }>;
        setPurchases(
          rows
            .filter((r) => !r.expires_at || new Date(r.expires_at) > new Date())
            .map((r) => ({
              id: r.id,
              remaining: r.credits_remaining,
              expires_at: r.expires_at,
              activity_id: r.packages?.activity_id ?? null,
              allowed_weekday: r.packages?.allowed_weekday ?? null,
              allowed_start_time: r.packages?.allowed_start_time ?? null,
            }))
        );
      });
  }, [auth, activity?.provider_id]);

  // 1.2: a credit is only offered when the package's restrictions match the
  // chosen class and session slot (e.g. "Monday 4:00 pm only").
  function creditMatches(p: CreditPurchase, sess: ActivitySession | null) {
    if (p.activity_id && p.activity_id !== activity?.id) return false;
    if (!sess) return p.allowed_weekday == null && !p.allowed_start_time;
    const sg = new Date(sess.starts_at);
    const sgWeekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Singapore", weekday: "short" }).format(sg)
    );
    if (p.allowed_weekday != null && sgWeekday !== p.allowed_weekday) return false;
    if (p.allowed_start_time) {
      const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false }).format(sg);
      if (t !== p.allowed_start_time.slice(0, 5)) return false;
    }
    return true;
  }
  const packageCredit = purchases.find((p) => creditMatches(p, selectedForCredit())) ?? null;
  const restrictedCredit = !packageCredit && purchases.length > 0 ? purchases[0] : null;
  function selectedForCredit() {
    return sessions.find((s) => s.id === sessionId) ?? null;
  }

  // Group upcoming sessions by date so the user picks a date, then a time.
  const byDate: Record<string, ActivitySession[]> = {};
  sessions.forEach((s) => {
    (byDate[sgDay(s.starts_at)] ||= []).push(s);
  });
  const dates = Object.keys(byDate);

  useEffect(() => {
    if (dates.length && !dateKey) setDateKey(dates[0]);
  }, [dates, dateKey]);

  // Default to an available credit — it's the cheapest option for the parent.
  useEffect(() => {
    if (packageCredit && payWith === "single") setPayWith("credit");
    else if (!packageCredit && payWith === "credit") setPayWith("single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageCredit?.id]);

  const times = dateKey ? byDate[dateKey] ?? [] : [];
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const bookChildId = childId ?? kids[0]?.id ?? null;
  const price = activity?.price != null ? Number(activity.price) : null;
  const total = price != null ? price * count : null;

  async function pay() {
    setErr(null);
    if (!auth) {
      window.location.href = "/login";
      return;
    }
    if (!sessionId) {
      setErr("Please choose a date and time first.");
      return;
    }
    setBusy(true);
    let status: string | null = null;
    if (redeemToken) {
      // Redeeming a make-up token: books the session and consumes the token atomically.
      const { data, error } = await supabase.rpc("redeem_make_up_token", {
        p_token_id: redeemToken,
        p_session_id: sessionId,
      });
      setBusy(false);
      if (error) {
        setErr(error.message.replace(/^.*?:\s*/, ""));
        return;
      }
      status = (data as string | null) ?? "confirmed";
    } else {
      const { data, error } = await supabase
        .from("bookings")
        .insert({ user_id: auth.user.id, session_id: sessionId, child_id: bookChildId })
        .select("id, status")
        .single();
      if (error) {
        setBusy(false);
        setErr(error.message);
        return;
      }
      // Paid class → hand off to Stripe Checkout; the webhook confirms on payment.
      // Free class (no price) stays a direct confirmed/pending booking.
      if (activity?.price != null && Number(activity.price) > 0 && data?.status !== "waitlisted") {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/bookings/checkout", { booking_id: data.id });
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
      }
      setBusy(false);
      status = data?.status ?? "pending";
    }
    const q = new URLSearchParams({
      title: activity?.title ?? "your class",
      slug: activity?.slug ?? "",
      when: selected ? sgDateTime(selected.starts_at) : "",
      status: status ?? "pending",
      start: selected?.starts_at ?? "",
      end: selected?.ends_at ?? "",
      venue: activity?.address ?? "",
    });
    window.location.href = `/booked?${q.toString()}`;
  }

  async function payWithPackage() {
    if (!auth) { window.location.href = "/login"; return; }
    if (!sessionId) { setErr("Please choose a date and time first."); return; }
    if (!packageCredit) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("redeem_package_credit", {
      p_purchase_id: packageCredit.id,
      p_session_id: sessionId,
    });
    setBusy(false);
    if (error) { setErr(error.message.replace(/^.*?:\s*/, "")); return; }
    const q = new URLSearchParams({
      title: activity?.title ?? "your class",
      slug: activity?.slug ?? "",
      when: selected ? sgDateTime(selected.starts_at) : "",
      status: (data as string | null) ?? "confirmed",
      start: selected?.starts_at ?? "",
      end: selected?.ends_at ?? "",
      venue: activity?.address ?? "",
    });
    window.location.href = `/booked?${q.toString()}`;
  }

  /** Buy a multi-class pack, then come back here to book with a credit. */
  async function buyPack(packageId: string) {
    if (!auth) { window.location.href = "/login"; return; }
    setBusy(true);
    setErr(null);
    try {
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/package", { package_id: packageId });
      if (url) window.location.href = url;
      else setErr("Could not start checkout — please try again.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
    } finally {
      setBusy(false);
    }
  }

  /** Route the CTA to whichever option was picked in step 4. */
  function checkout() {
    if (redeemToken) return pay();
    if (payWith === "credit") return payWithPackage();
    if (payWith.startsWith("pack:")) return buyPack(payWith.slice(5));
    return pay();
  }

  const selectedPack = payWith.startsWith("pack:") ? packs.find((p) => p.id === payWith.slice(5)) : undefined;
  const payLabel = !auth
    ? "Log in to book"
    : redeemToken
      ? "Confirm with make-up token"
      : payWith === "credit"
        ? "Confirm with a package credit"
        : selectedPack
          ? `Buy pack — $${(selectedPack.price_cents / 100).toFixed(0)}`
          : total != null && total > 0
            ? `Pay $${total.toFixed(2)}`
            : "Confirm booking";

  if (loading) {
    return (
      <PageShell active="/book">
        <main className="mx-auto max-w-[1024px] px-6 py-16 text-center font-bold text-[#5a6690]">Loading…</main>
      </PageShell>
    );
  }
  if (!activity) {
    return (
      <PageShell active="/book">
        <main className="mx-auto max-w-[1024px] px-6 py-16 text-center font-bold text-[#5a6690]">
          Class not found. <a href="/explore" className="text-baby-pink">Browse activities →</a>
        </main>
      </PageShell>
    );
  }

  const img = activity.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/detail-hero.png`;
  const ageText = formatAgeRange(activity.age_min_months, activity.age_max_months);

  return (
    <PageShell active="/book">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><a href={`/activity?slug=${activity.slug}`}>{activity.title}</a><span>›</span><span className="text-baby-pink">Book</span></div>
        <section className="rounded-[18px] border border-[#e7ebf6] bg-white shadow-card">
          <header className="grid items-center gap-5 border-b border-[#eef1f7] p-6 md:grid-cols-[90px_1fr_240px]">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="calendar" className="h-10 w-10" /></span>
            <div><h1 className="text-[34px] font-black">Book your class</h1><p className="text-lg font-semibold">Choose your preferred date, time &amp; package.</p></div>
            <img src={`${import.meta.env.BASE_URL}assets/crops/book-mascot-confetti.png`} alt="" className="hidden h-24 object-contain md:block" />
          </header>
          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
            <section>
              <div className="grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={img} alt={activity.title} className="h-52 w-full rounded-[12px] object-cover" />
                <div>
                  <h2 className="text-xl font-black">{activity.title}</h2>
                  <p className="mt-2 font-semibold">{ageText}</p>
                  <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                    {activity.address && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 text-baby-lilac" /> {activity.address}</p>}
                    {activity.category_name && <p className="flex gap-2"><Icon name="music" className="h-5 w-5 text-baby-lilac" /> {activity.category_name}</p>}
                    <p className="flex gap-2"><Icon name="star" className="h-5 w-5 text-baby-lilac" /> {activity.rating_count > 0 ? `${Number(activity.rating_avg).toFixed(1)} (${activity.rating_count} reviews)` : "New class"}</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-6 border-t border-[#eef1f7] pt-5">
                {sessions.length === 0 ? (
                  <p className="rounded-[12px] bg-[#fff7fb] p-4 font-semibold text-[#5a6690]">No upcoming sessions scheduled yet — try “Enquire Now” on the class page to ask the provider.</p>
                ) : (
                  <>
                    <section>
                      <h3 className="mb-4 text-xl font-black">1. Choose a date</h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                        {dates.map((d) => (
                          <button key={d} onClick={() => { setDateKey(d); setSessionId(null); }} className={`rounded-[10px] border px-3 py-4 text-sm font-bold ${d === dateKey ? "border-baby-pink bg-[#fff0f5] text-baby-pink" : "border-[#dfe5f2] bg-white"}`}>{d}<span className="mt-2 block text-xs font-semibold text-[#7a86a8]">{byDate[d].length} {byDate[d].length === 1 ? "time" : "times"}</span></button>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h3 className="mb-4 text-xl font-black">2. Choose a time</h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                        {times.map((s) => (
                          <button key={s.id} onClick={() => setSessionId(s.id)} className={`rounded-[10px] border px-3 py-4 font-bold ${s.id === sessionId ? "border-baby-pink bg-[#fff0f5] text-baby-pink" : "border-[#dfe5f2] bg-white"}`}>{sgTime(s.starts_at)}<span className="mt-2 block text-xs font-semibold text-[#7a86a8]">{s.capacity != null ? `${s.capacity} spots` : "Available"}</span></button>
                        ))}
                      </div>
                    </section>
                    {kids.length > 1 && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">Who's this class for?</h3>
                        <div className="flex flex-wrap gap-2">
                          {kids.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              onClick={() => setChildId(k.id)}
                              className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 text-sm font-bold ${bookChildId === k.id ? "border-baby-pink bg-[#fff0f5] text-baby-pink" : "border-[#dfe5f2] bg-white"}`}
                            >
                              <AnimalAvatar seed={k.name} kind="child" className="h-6 w-6" /> {k.name}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}
                    <section>
                      <h3 className="mb-2 text-xl font-black">3. Number of children</h3>
                      <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#dfe5f2] text-xl font-black">
                        <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} className="h-12 w-12">-</button>
                        <span className="grid h-12 w-14 place-items-center">{count}</span>
                        <button type="button" onClick={() => setCount((c) => Math.min(6, c + 1))} className="h-12 w-12">+</button>
                      </div>
                    </section>
                    {/* Step 4: how to pay for the class — a single drop-in, an
                        unused credit from a pack, or buying a pack now. */}
                    {!redeemToken && (
                      <section>
                        <h3 className="mb-2 text-xl font-black">4. Select package</h3>
                        <p className="mb-4 text-sm font-semibold text-[#59658d]">Pay for this class on its own, or use a multi-class pack.</p>
                        <div className="space-y-3">
                          <PackageOption
                            selected={payWith === "single"}
                            onSelect={() => setPayWith("single")}
                            title="Single class"
                            price={price != null ? `$${(price * count).toFixed(2)}` : "Price on enquiry"}
                          />
                          {packageCredit && (
                            <PackageOption
                              selected={payWith === "credit"}
                              onSelect={() => setPayWith("credit")}
                              title={`Use a package credit — ${packageCredit.remaining} left`}
                              price="No charge"
                            />
                          )}
                          {packs.map((p) => (
                            <PackageOption
                              key={p.id}
                              selected={payWith === `pack:${p.id}`}
                              onSelect={() => setPayWith(`pack:${p.id}`)}
                              title={p.name}
                              price={`$${(p.price_cents / 100).toFixed(0)}`}
                              badge={price != null && p.credits > 0 && p.price_cents / 100 / p.credits < price ? "Best value" : undefined}
                              action={{ label: "Buy pack", onClick: () => buyPack(p.id), busy: busy && payWith === `pack:${p.id}` }}
                            />
                          ))}
                        </div>
                        {restrictedCredit && !packageCredit && (
                          <p className="mt-3 rounded-[10px] bg-[#f4ecff] p-3 text-xs font-bold text-[#7a5cc8]">
                            You have package credits with this provider, but they can't be used for this{" "}
                            {restrictedCredit.activity_id && restrictedCredit.activity_id !== activity?.id ? "class" : "session slot"} — check your package's designated class or weekly slot.
                          </p>
                        )}
                      </section>
                    )}
                  </>
                )}
              </div>
            </section>

            <aside className="rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 flex gap-4">
                <img src={img} alt="" className="h-24 w-28 rounded-[10px] object-cover" />
                <div><h3 className="font-black">{activity.title}</h3><p className="mt-1 text-sm font-semibold">{ageText}</p>{activity.category_name && <span className="mt-2 inline-block rounded-full bg-[#fff0f5] px-3 py-1 text-xs font-bold text-baby-pink">{activity.category_name}</span>}</div>
              </div>
              <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 text-baby-lilac" /> {selected ? sgDateTime(selected.starts_at) : "Select a date & time"}</p>
                {activity.address && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 text-baby-lilac" /> {activity.address}</p>}
                <p className="flex gap-2"><Icon name="user" className="h-5 w-5 text-baby-lilac" /> {count} {count === 1 ? "child" : "children"}, {ageText}</p>
              </div>
              <div className="my-5 border-t border-[#eef1f7]" />
              <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-pink">{total != null ? `$${total.toFixed(2)}` : "Price on enquiry"}</span></p>
              <div className="mt-5 rounded-[12px] bg-[#fff7fb] p-4"><h3 className="font-black">Why parents love us</h3>{["Trusted by thousands of parents", "Safe & engaging environments", "Expert-led activities", "Hassle-free booking"].map((item) => <p key={item} className="mt-3 flex gap-2 text-sm font-semibold"><Icon name="check" className="h-4 w-4 text-baby-pink" /> {item}</p>)}</div>
            </aside>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#fff0f7] text-baby-pink"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total amount</span><strong className="text-3xl">{total != null ? `$${total.toFixed(2)}` : "—"}</strong></p></div>
            {err && <p className="mt-3 text-sm font-bold text-baby-pink">{err}</p>}
          </div>
          {redeemToken && (
            <p className="mb-3 rounded-[10px] bg-[#fff4d6] px-4 py-2.5 text-sm font-bold text-[#8a6d1a]"><Icon name="gift" className="mr-1 inline h-4 w-4" /> Using a make-up token — this class is on the house.</p>
          )}
          {activity?.bookings_paused ? (
            /* 1.1: the vendor has paused bookings for this class */
            <div className="rounded-[12px] bg-amber-50 p-4 text-center font-bold text-amber-700">
              <Icon name="bell" className="mr-2 inline h-5 w-5" /> Bookings for this class are temporarily paused by the provider. Please check back later or enquire with them directly.
            </div>
          ) : (
            <Button type="button" size="lg" onClick={checkout} className={busy || !sessionId ? "opacity-60" : ""}>
              <Icon name="lock" className="h-5 w-5" /> {busy ? "Confirming…" : payLabel}
            </Button>
          )}
          {total != null && total > 0 && !redeemToken && (
            <p className="mt-2 text-center text-xs font-semibold text-[#8a93b2] md:col-span-2">Secure and encrypted payment via Stripe</p>
          )}
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

function BookedPage() {
  const title = getParam("title") || "your class";
  const when = getParam("when") || "";
  const status = getParam("status") || "confirmed";
  const start = getParam("start");
  const end = getParam("end");
  const venue = getParam("venue") || "";
  const slug = getParam("slug") || "";
  const waitlisted = status === "waitlisted";

  // Paid bookings come back through Stripe; apply the payment immediately
  // rather than waiting on the webhook.
  useEffect(() => {
    const checkoutSession = getParam("session_id");
    if (checkoutSession) {
      apiPost("/api/stripe/reconcile", { session_id: checkoutSession }).catch(() => {});
    }
  }, []);
  return (
    <PageShell active="/booked" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Class details</span><span>›</span><span className="text-baby-pink">Book</span></div>
        <section className="grid items-center gap-5 rounded-[18px] border border-[#e7ebf6] bg-gradient-to-r from-[#fff0f7] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="check" className="h-12 w-12" /></span>
          <div><h1 className="text-[36px] font-black">{waitlisted ? "You're on the waitlist!" : "Your class is booked!"}</h1><p className="mt-2 text-lg font-semibold">{waitlisted ? "This session is full — we'll notify you the moment a spot opens up." : "We can't wait to see your little one there."}</p></div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/book-mascot-confetti.png`} alt="" className="hidden h-24 object-contain md:block" />
        </section>
        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
          <div className="space-y-5">
            <article className="rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Class details</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={`${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`} alt="" className="h-52 w-full rounded-[12px] object-cover" />
                <div><h3 className="text-xl font-black">{title}</h3>{when && <div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />{when}</p></div>}</div>
              </div>
              <div className="mt-5 border-t border-[#eef1f7] pt-5"><h3 className="font-black">About this class</h3><p className="mt-3 font-semibold leading-7 text-[#3f4b78]">A fun and interactive music class that helps little ones explore rhythms, sounds, and movement while boosting coordination, listening skills and confidence.</p></div>
            </article>
            <article className="rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">What to bring & know</h2>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {[["bell", "Arrive 10 mins early"], ["shoe", "Dress comfortably"], ["bottle", "Bring essentials"]].map(([icon, title]) => <div key={title} className="text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#fff0f7] text-baby-pink"><Icon name={icon} className="h-8 w-8" /></span><h3 className="mt-3 font-black">{title}</h3><p className="mt-2 text-sm font-semibold text-[#59658d]">Helpful notes for a smooth class experience.</p></div>)}
              </div>
            </article>
          </div>
          <aside className="space-y-5">
            <article className="rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Class</span><span className="text-right">{title}</span></p>{when && <p className="flex justify-between"><span>When</span><span className="text-right">{when}</span></p>}<p className="flex justify-between"><span>Status</span><strong className={waitlisted ? "text-amber-600" : "text-green-600"}>{waitlisted ? "Waitlisted" : "Confirmed"}</strong></p></div>
              <p className={`mt-5 rounded-[12px] p-4 font-semibold ${waitlisted ? "bg-amber-50 text-amber-700" : "bg-[#eefbf1] text-green-700"}`}><Icon name="check" className="mr-2 inline h-5 w-5" /> {waitlisted ? "Added to the waitlist" : "Booking confirmed"}</p>
              <Button href="/profile?tab=bookings" className="mt-5 w-full">View my bookings</Button>
              {start && (
                <Button
                  variant="outline"
                  type="button"
                  className="mt-3 w-full"
                  onClick={() => downloadBookingIcs({ id: `${start}-${title}`, title, startsAt: start, endsAt: end || null, venue })}
                >
                  <Icon name="calendar" className="h-4 w-4" /> Add to calendar
                </Button>
              )}
            </article>
            <article className="rounded-[16px] bg-[#f4ecff] p-6">
              <h2 className="text-xl font-black text-baby-lilac">Need help?</h2>
              <p className="mt-3 font-semibold">Questions about this class? Message the provider directly.</p>
              <Button
                href={slug ? `/activity?slug=${encodeURIComponent(slug)}#enquire` : "/contact"}
                variant="outline"
                className="mt-4 w-full"
              >
                <Icon name="mail" className="h-4 w-4" /> Message the provider
              </Button>
              <a href="/contact" className="mt-3 block text-center text-sm font-black text-baby-lilac hover:underline">
                Contact BabyBrain support →
              </a>
            </article>
          </aside>
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

// Confetti scatter for the About page, matching the design's placement.
// Colours come from the brand palette.
const ABOUT_HERO_CONFETTI: React.ComponentProps<typeof Confetti>["pieces"] = [
  { kind: "heart", top: "4%", left: "47%", color: "#9568DF", size: 30 },
  { kind: "dot", top: "17%", left: "44%", color: "#A8E59A", size: 18 },
  { kind: "dot", top: "35%", left: "45%", color: "#FA5D93", size: 16 },
  { kind: "star", top: "50%", left: "44%", color: "#FFB77A", size: 26 },
  // Kept in the column gap and the strip above the photo so nothing lands on
  // top of the image itself.
  { kind: "dash", top: "0%", right: "16%", color: "#FA5D93", size: 26, rotate: -30 },
  { kind: "dash", top: "3%", right: "12%", color: "#FA5D93", size: 22, rotate: -30 },
  { kind: "star", top: "0%", right: "4%", color: "#FFD77A", size: 28 },
  { kind: "dot", top: "72%", left: "45%", color: "#C7B1E6", size: 16 },
  { kind: "heart", top: "85%", left: "43%", color: "#FA5D93", size: 30 },
  { kind: "dot", top: "94%", right: "6%", color: "#A8E59A", size: 18 },
];

const ABOUT_FOUNDER_CONFETTI: React.ComponentProps<typeof Confetti>["pieces"] = [
  { kind: "heart", top: "8%", left: "3%", color: "#FA5D93", size: 30 },
  { kind: "star", top: "32%", left: "1%", color: "#FFD77A", size: 28 },
  { kind: "dash", top: "62%", left: "4%", color: "#C7B1E6", size: 24, rotate: -35 },
  { kind: "dash", top: "72%", left: "1%", color: "#C7B1E6", size: 24, rotate: -35 },
  { kind: "dash", top: "22%", left: "36%", color: "#A7D8F8", size: 24, rotate: -40 },
  { kind: "dash", top: "29%", left: "37%", color: "#FA5D93", size: 24, rotate: -40 },
  { kind: "dash", top: "48%", left: "36%", color: "#A8E59A", size: 26, rotate: -15 },
  { kind: "heart", top: "6%", right: "3%", color: "#FA5D93", size: 30 },
  { kind: "star", top: "30%", right: "2%", color: "#FFD77A", size: 28 },
  { kind: "dot", top: "58%", right: "1%", color: "#A7D8F8", size: 16 },
  { kind: "dot", top: "80%", right: "5%", color: "#C7B1E6", size: 16 },
];

function AboutPage() {
  return (
    <PageShell active="/about" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-8">
        <section className="relative grid items-center gap-8 md:grid-cols-[1fr_520px]">
          <Confetti pieces={ABOUT_HERO_CONFETTI} />
          <div className="relative z-10">
            <h1 className="text-[54px] font-black leading-tight text-baby-lilac">About</h1>
            <p className="mt-5 text-2xl font-black leading-tight">BabyBrain helps parents to discover &amp; book amazing activities for their little ones.</p>
            <p className="mt-5 max-w-[420px] font-semibold leading-7 text-[#3f4b78]">We curate options based on your children's age, interests and your location, making it quicker and easier to find great activities and less overwhelming to adjust plans when the schedule changes.</p>
            <Button href="/explore" className="mt-6">Explore →</Button>
          </div>
          {/* Square source (see scripts/hide-face.py) — the frame matches so
              nothing is cropped away. */}
          <img
            src={`${import.meta.env.BASE_URL}assets/crops/about-family.jpg`}
            alt="Katie, BabyBrain's founder, holding her son"
            width={1000}
            height={1000}
            className="relative z-10 mx-auto aspect-square w-full max-w-[460px] rounded-[24px] object-cover shadow-soft"
          />
        </section>

        <section className="relative mt-8 grid items-center gap-8 overflow-hidden rounded-[24px] bg-gradient-to-r from-[#fdeef4] to-[#fdf3f7] p-8 md:grid-cols-[300px_1fr]">
          <Confetti pieces={ABOUT_FOUNDER_CONFETTI} />
          <img
            src={`${import.meta.env.BASE_URL}assets/crops/founder-katie.jpg`}
            alt="Katie Crowson, founder of BabyBrain"
            width={720}
            height={880}
            className="relative z-10 mx-auto h-[340px] w-full max-w-[290px] rounded-[18px] object-cover shadow-soft"
          />
          <div className="relative z-10">
            <p className="font-black text-baby-lilac">Meet our founder</p>
            <h2 className="mt-1 text-[38px] font-black leading-tight">Katie Crowson</h2>
            <p className="mt-4 font-semibold leading-7 text-[#3f4b78]">Hi! I'm Katie, a mum, and the founder of BabyBrain.</p>
            <p className="mt-3 font-semibold leading-7 text-[#3f4b78]">After having our son, I realised how unnecessarily difficult it was to find out what activities are on offer and book, only to have to start afresh when the schedule changes.</p>
            <p className="mt-3 font-semibold leading-7 text-[#3f4b78]">BabyBrain was created to make that journey quicker and easier.</p>
            <p className="mt-4 flex items-center gap-2 font-black"><Icon name="heart" className="h-5 w-5 text-baby-lilac" /> Made by a parent, for parents.</p>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-6 rounded-[18px] bg-[#fffaf0] p-8 md:grid-cols-[1fr_320px]">
          <div>
            <h2 className="text-[46px] font-black leading-none text-baby-lilac">Our mission</h2>
            <p className="mt-5 text-2xl font-black leading-tight">To reduce the mental load for parents in Singapore.</p>
            <p className="mt-4 max-w-[440px] font-semibold leading-7 text-[#3f4b78]">We want to help you spend less time on administration and more time having meaningful experiences.</p>
            <Button href="/onboarding" size="lg" className="mt-6">Join today →</Button>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/mission-target.png`} alt="" className="mx-auto h-48 object-contain" />
        </section>
        <section className="mt-7 text-center">
          <h2 className="text-2xl font-black">Why we built BabyBrain</h2>
          <p className="font-semibold text-[#59658d]">Parents told us they faced the same challenges:</p>
          <div className="mt-5 grid gap-4 md:grid-cols-5">
            {[["search", "Too many options"], ["mail", "Information scattered"], ["people", "Age uncertainty"], ["target", "No easy comparison"], ["calendar", "Time-consuming planning"]].map(([icon, text]) => <div key={text} className="text-center"><Icon name={icon} className="mx-auto h-10 w-10 text-baby-pink" /><p className="mt-3 text-sm font-black">{text}</p></div>)}
          </div>
        </section>
        <section className="mt-7 rounded-[18px] bg-[#ffe9f2] p-7">
          <div className="grid items-center gap-6 md:grid-cols-[180px_1fr_320px]">
            <BrandBlock />
            <div><h2 className="text-[28px] font-black">Ready to discover activities your child will love?</h2><p className="mt-2 font-semibold text-[#3f4b78]">Join parents using BabyBrain to find classes, events and play experiences across Singapore.</p></div>
            <div className="flex gap-3"><Button href="/explore">Explore activities</Button><Button href="/onboarding" variant="outline">Sign up</Button></div>
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function BrandBlock() {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/brand/logo-horizontal.png`}
      alt="BabyBrain"
      className="h-16 w-auto object-contain"
    />
  );
}

function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) return setError(error);
    // Honour ?next= for gated pages that bounced here — same-origin
    // relative paths only ("//host" would be an open redirect).
    const next = getParam("next");
    window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/profile";
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-6 py-12">
        <div className="rounded-[18px] border border-[#ecdfe6] bg-white p-8 shadow-card">
          <h1 className="text-2xl font-black">Welcome back <span>👋</span></h1>
          <p className="mt-1 font-semibold text-[#5a6690]">Log in to see activity suggestions for your children.</p>
          {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-black">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 font-semibold" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-black">Password</label>
                <a href="/forgot-password" className="text-xs font-bold text-baby-pink hover:underline">Forgot password?</a>
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 font-semibold" />
            </div>
            <Button type="submit" className="w-full justify-center">{busy ? "Signing in…" : "Log in"}</Button>
          </form>
          <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
            New here? <a href="/onboarding" className="font-black text-baby-pink">Create a profile</a>
          </p>
        </div>
      </main>
    </PageShell>
  );
}

function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await resetPassword(email);
    setBusy(false);
    if (error) return setError(error);
    setSent(true);
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-4 py-12 sm:px-6">
        <div className="rounded-[18px] border border-[#ecdfe6] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Reset your password</h1>
          {sent ? (
            <div className="mt-3">
              <p className="rounded-[10px] bg-[#eefbf1] px-3 py-3 text-sm font-semibold text-green-700">
                If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
              </p>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                <a href="/login" className="font-black text-baby-pink">← Back to log in</a>
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Enter your email and we'll send you a link to set a new password.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 font-semibold" />
                </div>
                <Button type="submit" className="w-full justify-center">{busy ? "Sending…" : "Send reset link"}</Button>
              </form>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                Remembered it? <a href="/login" className="font-black text-baby-pink">Log in</a>
              </p>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
}

function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Supabase parses the recovery token from the URL and fires PASSWORD_RECOVERY;
  // until we have a session the user can't set a new password.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY" || s) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match.");
    if (password.length < 6) return setError("Use at least 6 characters.");
    setBusy(true);
    setError(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) return setError(error);
    setDone(true);
    setTimeout(() => (window.location.href = "/profile"), 1500);
  }

  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-4 py-12 sm:px-6">
        <div className="rounded-[18px] border border-[#ecdfe6] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Set a new password</h1>
          {done ? (
            <p className="mt-3 rounded-[10px] bg-[#eefbf1] px-3 py-3 text-sm font-semibold text-green-700">
              Password updated. Taking you to your profile…
            </p>
          ) : !ready ? (
            <p className="mt-3 rounded-[10px] bg-[#fff7e6] px-3 py-3 text-sm font-semibold text-[#8a6d1a]">
              This page only works from the reset link in your email. Open that link, or <a href="/forgot-password" className="font-black text-baby-pink">request a new one</a>.
            </p>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Choose a new password for your account.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">New password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 font-semibold" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-black">Confirm password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#ecdfe6] px-3 font-semibold" />
                </div>
                <Button type="submit" className="w-full justify-center">{busy ? "Saving…" : "Update password"}</Button>
              </form>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
}

function App() {
  const { session, loading } = useAuth();
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/login") return <LoginPage />;
  if (pathname === "/forgot-password") return <ForgotPasswordPage />;
  if (pathname === "/reset-password") return <ResetPasswordPage />;
  if (pathname === "/pricing") return <PricingPage />;
  if (pathname === "/payment") return <PaymentPage />;
  if (pathname === "/book") return <BookingPage />;
  if (pathname === "/booked") return <BookedPage />;
  if (pathname === "/about") return <AboutPage />;
  if (pathname === "/onboarding") return <OnboardingPage />;
  if (pathname === "/matches") return <MatchesPage />;
  if (pathname === "/explore") return <ExplorePage />;
  if (pathname === "/activity") return <ActivityDetailPage />;
  if (pathname === "/profile") return <ProfilePage />;
  if (pathname === "/edit-profile") return <EditProfilePage />;
  if (pathname === "/contact") return <ContactPage />;
  if (pathname === "/terms") return <TermsPage />;
  // Home: signed-in parents land on their personalised dashboard (matched
  // classes for their child), not the marketing page.
  if (!loading && session) return <MatchesPage active="/" />;
  return <HomePage />;
}

export default App;
