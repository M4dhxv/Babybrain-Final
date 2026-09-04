import {
  ActivityCard,
  ActivityRow,
  AnimalAvatar,
  Button,
  BrandStacked,
  CategoryTile,
  DateInput,
  Footer,
  Icon,
  MiniActivityGrid,
  PageShell,
  PlusFeatureDialog,
  ConfirmDialog,
  SectionTitle,
} from "./components/ui";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MessagesTab } from "./components/MessagesTab";
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
  primePlan,
  toCard,
} from "./lib/data";
import { supabase } from "./lib/supabase";
import { apiGet, apiPost } from "./lib/api";
import { goTo } from "./lib/nav";
import { downloadBookingIcs, downloadScheduleIcs } from "./lib/ics";
import { downloadSchedulePdf, withinRange } from "./lib/schedule-pdf";
import { formatChildAge, formatAgeRange, formatDuration, regionLabel, ageInMonths } from "./lib/database.types";
import {
  PASSWORD_RULES,
  dobError,
  emailError,
  passwordError,
  postcodeError,
} from "./lib/validation";
import { CHILD_AVATARS, PARENT_AVATARS, type AvatarOption } from "./lib/avatars";
import type { ActivitySession, Child, Gender, ProviderPolicy } from "./lib/database.types";
import { EnquiryChat } from "./components/EnquiryChat";
import { ClassGroupChat } from "./components/ClassGroupChat";
import { ExploreMap } from "./components/ExploreMap";
import { SupportChat } from "./components/SupportChat";
import { RainbowLoader } from "./components/RainbowLoader";

function getParam(name: string) {
  return new URLSearchParams(window.location.search).get(name);
}

const GENERIC_RPC_ERROR = "Something went wrong — please try again or contact support.";

/**
 * Internal database errors that must never be read by a parent. Matching on
 * shape is only the backstop for when `code` is missing (a non-Postgres
 * failure, or an older client shape); the SQLSTATE check below is the real
 * gate.
 */
const INTERNAL_DB_ERROR = new RegExp(
  [
    'has no field',
    'does not exist',
    'invalid input syntax',
    'violates [a-z-]+ constraint',
    'null value in column',
    'permission denied',
    'out of range',
    '^(record|column|relation|operator|function) ',
  ].join('|'),
  'i',
);

/**
 * Turn an RPC failure into something a parent can act on.
 *
 * Our own `raise exception` messages in PL/pgSQL are written for parents and
 * come back as SQLSTATE P0001, so those are shown as-is. Anything else is the
 * database talking to itself — a dropped column, a failed cast, a constraint
 * — and gets the generic line instead. Checking the code rather than the text
 * is what matters here: a half-applied migration surfaced
 * `record "v_pkg" has no field "activity_id"` on the checkout screen, and it
 * slipped through the old text-only version because that message happens to
 * contain no colon (see 00075_repair_redeem_package_credit.sql).
 *
 * The label-stripping below is kept for the wrapped `label: text` form. It
 * only strips a prefix that looks like a genuine short label, and never
 * surfaces a quoted or oversized remainder — a raw Postgres error can quote
 * the offending value verbatim (seen for real: a Wix slot id sent where a
 * session uuid was expected put "wix:<encoded slot>" on screen, because the
 * naive strip-to-first-colon this used to do stopped at *that* inner colon).
 */
function cleanRpcErrorMessage(error: { message: string; code?: string | null } | string): string {
  const message = typeof error === "string" ? error : error.message;
  const code = typeof error === "string" ? undefined : error.code ?? undefined;
  if (!message) return GENERIC_RPC_ERROR;

  // P0001 is a plain `raise exception` — i.e. a message we wrote on purpose.
  // Any other SQLSTATE is internal. No code at all (network/transport) falls
  // through to the shape check.
  if (code && code !== "P0001") return GENERIC_RPC_ERROR;
  if (INTERNAL_DB_ERROR.test(message)) return GENERIC_RPC_ERROR;

  const m = message.match(/^([A-Za-z0-9 _.'()-]{1,60}):\s*(.*)$/s);
  if (!m) return message;
  const rest = m[2];
  if (rest.startsWith('"') || rest.length > 200) return GENERIC_RPC_ERROR;
  return rest;
}

function HomePage() {
  return (
    <PageShell active="/" auth="public">
      <main>
        <section className="mx-auto grid max-w-[1120px] items-center gap-8 px-6 pb-4 pt-6 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[#FED7E4] px-4 py-2.5 text-[13px] font-bold text-baby-cta">
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
            <div className="absolute -left-6 top-40 h-14 w-14 rounded-full bg-[#C7B1E6]" />
            <Icon name="star" className="absolute right-[-18px] top-14 h-8 w-8 fill-[#FFD77A] text-[#FFD77A]" />
            <img
              src={`${import.meta.env.BASE_URL}assets/crops/hero-ball-pit.jpg`}
              alt="A toddler wading through a ball pit at an indoor play space"
              width={1400}
              height={933}
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
              <span className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#FED7E4] to-[#FEEBF2] text-baby-cta">
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
          <div className="rounded-[22px] border border-[#EBE3E5] bg-white/80 p-5 shadow-card">
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
            {/* Stacked on mobile, each row used to centre itself, so "Locations"
                — much shorter than "Curated activities" — sat visibly right of
                the rows above it. The inner wrapper shrinks to the widest row
                and centres as one block, giving every row a shared left edge;
                from md up they're columns again and centre individually. */}
            <div className="mt-5 rounded-[18px] border border-[#EBE3E5] bg-white p-3">
              <div className="mx-auto grid w-fit gap-3 md:w-full md:grid-cols-3">
                {[
                  ["people", "1000+", "Curated activities"],
                  ["store", "100+", "Verified providers"],
                  ["chart", "200+", "Locations"],
                ].map(([icon, stat, label]) => (
                  <div key={stat} className="flex items-center justify-start gap-3 md:justify-center">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta">
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
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <SectionTitle>Explore activities by age</SectionTitle>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {/* Drawn from AGE_BANDS so these tiles can't drift out of step with
                the Explore filter — they used to say "0 – 6 months" but link to
                ?age=6, which lands on the 6–11 month band. */}
            {AGE_BANDS.map((band, i) => (
              <a
                key={band.key}
                href={`/explore?age=${band.key}`}
                className="flex min-h-[92px] flex-col justify-center rounded-[16px] border border-[#EBE3E5] bg-gradient-to-br from-[#FEEBF2] to-[#EDF7FD] px-4 py-3 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-soft"
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
            <article key={name} className="flex gap-4 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
              <AnimalAvatar seed={name} kind="parent" className="h-11 w-11" />
              <div>
                <div className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: 5 }).map((_, starIndex) => <Icon key={starIndex} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
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
          <div className="grid items-center gap-6 overflow-hidden rounded-[18px] border border-[#E9E1F5] bg-gradient-to-r from-[#FEEBF2] via-white to-[#F4F0FA] px-10 py-5 md:grid-cols-[220px_1fr_280px]">
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="h-28 object-contain object-left" />
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
        className="mt-2 h-10 w-full rounded-[8px] border border-[#DCD2D5] bg-white px-3 text-sm font-semibold outline-none focus:border-baby-pink"
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

/** Ticked budget bands → the single {budget_min, budget_max} span we store.
 *  Shared by sign-up and edit-profile so both accept several bands. */
function budgetRange(keys: string[]): { budget_min: number | null; budget_max: number | null } {
  const chosen = BUDGET_CHIPS.filter(([k]) => keys.includes(k));
  if (!chosen.length) return { budget_min: null, budget_max: null };
  return {
    budget_min: Math.min(...chosen.map(([, , lo]) => lo ?? 0)),
    // An open-ended band ("$120+") means no upper limit at all.
    budget_max: chosen.every(([, , , hi]) => hi != null)
      ? Math.max(...chosen.map(([, , , hi]) => hi as number))
      : null,
  };
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-[8px] border px-3 py-2 text-xs font-bold ${on ? "border-baby-pink bg-[#FED7E4] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
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
    goTo("/matches");
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

/** No session (signed out, or the refresh token expired while the tab sat
 *  open): leave for the public landing page instead of showing a signed-in
 *  page's logged-out panel. Rendered as a placeholder while the hard
 *  navigation this fires actually happens. */
function RedirectToLanding() {
  useEffect(() => { goTo("/"); }, []);
  return (
    <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
      <RainbowLoader className="py-4" label="Taking you back" />
    </main>
  );
}

function MatchesPage({ active = "/matches" }: { active?: string }) {
  const { session, profile, children, loading, dataResolved } = useAuth();
  const { data: recsByChild, loading: recsLoading } = useRecommendations(children);
  // Which child's suggestions are on screen; defaults to the first.
  const [homeChildId, setHomeChildId] = useState<string | null>(null);

  if (!loading && !session) return <RedirectToLanding />;
  // Only claim there are no children once the fetch has actually answered —
  // an unresolved lookup used to send signed-in parents to onboarding.
  if (!loading && dataResolved && children.length === 0) {
    return (
      <PageShell active={active}>
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Tell us about your child to get matches.</p>
          <Button href="/onboarding" className="mt-4">Complete your profile</Button>
        </main>
      </PageShell>
    );
  }

  /* QA: "How do I know which child the suggested activities are for? On Home
     page just see one child?" — recommendations have always been per child
     (user_recommendations.child_id), but Home silently showed the first
     child's and never said so. The name is now on the heading and, with more
     than one child, a chip switches between them. */
  const shown = recsByChild.find((r) => r.child.id === homeChildId) ?? recsByChild[0];
  const child = shown?.child;
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  return (
    <PageShell active={active}>
      <main className="mx-auto max-w-[1180px] px-6 py-6">
        <section>
          <div className="grid items-center gap-6 lg:grid-cols-[1fr_340px]">
            <div>
              {/* The greeting is the page header; the suggestion line sits a
                  step below it. */}
              <h1 className="text-[36px] font-black leading-tight">
                Hi <span className="text-baby-lilac">{firstName}</span>!
              </h1>
              <p className="mt-2 text-[26px] font-black leading-tight">
                Here are some suggested activities for <span className="text-baby-lilac">{child?.name ?? "your child"}</span>
              </p>
              <p className="mt-4 text-[17px] font-semibold text-[#47527d]">Based on age, interests and your preferences.</p>
              {recsByChild.length > 1 && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-[#6D748A]">Suggestions for</span>
                  {recsByChild.map((r) => {
                    const on = r.child.id === (child?.id ?? null);
                    return (
                      <button
                        key={r.child.id}
                        type="button"
                        onClick={() => setHomeChildId(r.child.id)}
                        aria-pressed={on}
                        className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                          on ? "bg-[#FED7E4] text-baby-cta" : "border border-[#EBE3E5] bg-white text-[#6D748A] hover:border-baby-pink"
                        }`}
                      >
                        {r.child.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {child && (
              <article className="flex gap-4 rounded-[18px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                <AnimalAvatar seed={child.avatar_seed ?? child.name} kind="child" gender={child.gender} className="h-32 w-32 ring-8 ring-[#FEEBF2]" />
                <div>
                  <h2 className="text-xl font-black">{child.name}</h2>
                  <p className="mb-3 font-bold">{formatChildAge(child.date_of_birth)}</p>
                  {child.interests.map((item) => (
                    <p key={item} className="mb-1.5 rounded-full bg-[#FEF4EB] px-3 py-1.5 text-xs font-bold text-[#596184]">enjoys {item.replace(/-/g, " ")}</p>
                  ))}
                </div>
              </article>
            )}
          </div>
        </section>

        <section className="mt-6">
          {/* On mobile the "See activity options" link sits below the cards
              rather than crowding the heading. */}
          <SectionTitle
            action={<a href="/explore" className="hidden font-bold text-[#FFC1D6] sm:inline">Explore more activities →</a>}
          >
            {child ? `Matching activities for ${child.name}` : "Matching activities"}
          </SectionTitle>
          {recsLoading ? (
            <RainbowLoader className="py-6" label="Loading matches" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {(shown?.recs ?? []).slice(0, 4).map((r) =>
                r.activity ? <ActivityCard key={r.id} activity={toCard(r.activity)} /> : null
              )}
              {shown && shown.recs.length === 0 && <p className="font-semibold text-[#68718f]">No matches yet — new activities are added regularly.</p>}
            </div>
          )}
          <a href="/explore" className="mt-4 block text-left font-bold text-[#FFC1D6] sm:hidden">Explore more activities →</a>
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
      {/* Signed-in parents land here instead of the marketing home, and this
          page was the one route that never rendered the footer. */}
      <Footer />
    </PageShell>
  );
}

// Age bands, as brackets rather than a single "child is N months old" probe.
// The old filter matched any class whose range *contained* the age, so picking
// "0 – 6 months" surfaced classes running up to 2 years. A band matches only
// when the class's own age range overlaps it.
const AGE_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "0-5", label: "0 – 5 months", min: 0, max: 5 },
  { key: "6-11", label: "6 – 11 months", min: 6, max: 11 },
  { key: "12-17", label: "12 – 17 months", min: 12, max: 17 },
  { key: "18-35", label: "18 months – 3 years", min: 18, max: 35 },
  { key: "36+", label: "Over 3 years", min: 36, max: 132 },
];
/** Marketing sub-line for each band, used by the home page tiles. */
const AGE_BAND_COPY = [
  "Social awakening",
  "Curious little movers",
  "First little steps",
  "Busy toddlers",
  "Confident explorers",
];

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
/** Same centroids as `sg_region()` in migration 00032, for parents who deny
 *  (or don't have) precise geolocation — picking an area beats no sort at all. */
const REGION_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  central: { lat: 1.300, lng: 103.830 },
  east: { lat: 1.335, lng: 103.940 },
  "north-east": { lat: 1.385, lng: 103.895 },
  north: { lat: 1.430, lng: 103.820 },
  west: { lat: 1.335, lng: 103.720 },
  sentosa: { lat: 1.2494, lng: 103.8303 },
};
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
        <button type="button" onClick={dismiss} aria-label="Close" className="float-right -mr-1 -mt-1 text-[#6D7488] hover:text-[#3a4468]">
          <Icon name="close" className="h-5 w-5" />
        </button>
        {done ? (
          <div className="py-4 text-center">
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#F1FBEF] text-[#A8E59A]"><Icon name="check" className="h-8 w-8" /></div>
            <h2 className="text-xl font-black">You're in! 🎉</h2>
            <p className="mt-2 text-sm font-semibold text-[#59658d]">Enjoy discovering activities for your family.</p>
            <Button className="mt-5 w-full" onClick={dismiss}>Start exploring</Button>
          </div>
        ) : (
          <>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[#FED7E4] px-3 py-1.5 text-xs font-bold text-baby-cta"><Icon name="heart" className="h-3.5 w-3.5" /> Made for your family</div>
            <h2 className="text-2xl font-black leading-tight">Explore activities for your little one</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-[#59658d]">Pop in your email to find classes, playspaces, holiday camps and more that meet your exact needs.</p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                autoFocus
                className="h-12 w-full rounded-[12px] border border-[#EBE3E5] px-4 font-semibold shadow-card focus:border-baby-pink focus:outline-none"
              />
              {error && <p className="text-sm font-semibold text-baby-pink">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Get started"}</Button>
            </form>
            <button type="button" onClick={dismiss} className="mt-3 w-full text-center text-xs font-bold text-[#6E748D] hover:text-[#59658d]">Maybe later</button>
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

  // The chosen sort wins outright. Instant-book listings used to be pinned
  // above everything regardless, so picking "Nearest" changed nothing and QA
  // saw a class 30 minutes away above ones within 10. Instant book now only
  // breaks ties, which still keeps it first under the default "Most popular".
  const shown = [...filtered].sort((x, y) => {
    if (sort === "soonest") {
      const ax = x.nextSessionAt ? Date.parse(x.nextSessionAt) : Infinity;
      const ay = y.nextSessionAt ? Date.parse(y.nextSessionAt) : Infinity;
      if (ax !== ay) return ax - ay;
    }
    if (sort === "distance" && here) {
      const dx = distanceFrom(here, x);
      const dy = distanceFrom(here, y);
      if (dx !== dy) return dx - dy;
    }
    if (x.instantBook !== y.instantBook) return x.instantBook ? -1 : 1;
    return 0;
  });

  function resetFilters() {
    setCategories([]); setAges([]); setRegions([]);
    setDateFrom(""); setTimeRange([0, 23]); setMaxPrice(PRICE_MAX);
  }

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  // Sorting by distance needs a location; ask only when it's chosen. If the
  // browser won't give one (denied, or no geolocation at all), fall back to the
  // postcode the parent gave us, so "Nearest" still does something sensible.
  useEffect(() => {
    if (sort !== "distance" || here) return;
    let cancelled = false;
    const useProfile = async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user || cancelled) return;
      const { data: p } = await supabase
        .from("parent_profiles")
        .select("latitude, longitude")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!cancelled && p?.latitude != null && p?.longitude != null) {
        setHere({ lat: p.latitude, lng: p.longitude });
      }
    };
    if (!navigator.geolocation) {
      void useProfile();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => !cancelled && setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => void useProfile(),
      { timeout: 8000 }
    );
    return () => {
      cancelled = true;
    };
  }, [sort, here]);

  const selectClass = "h-10 rounded-[10px] border border-[#EBE3E5] bg-white px-3 text-[13px] font-bold shadow-card focus:border-baby-pink focus:outline-none";
  const pinned = shown.filter((a) => a.venues.length > 0 || a.lat != null).length;

  return (
    <PageShell active="/explore">
      <EmailCapturePopup />
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[28px] font-black text-baby-green sm:text-[34px]">Explore activities <Icon name="search" className="inline h-6 w-6 text-baby-green" /></h1>
            <p className="mt-1 text-base font-semibold text-[#4a5680] sm:text-lg">
              {query ? <>Results for “{query}”. <a href="/explore" className="font-black text-baby-pink">Clear search</a></> : "Browse activities across Singapore."}
            </p>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/explore-skyline.png`} alt="" className="hidden h-24 object-contain md:block lg:h-28" />
        </div>

        <div className="mb-4 space-y-3 rounded-[16px] border border-[#EBE3E5] bg-white p-4 shadow-card">
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

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[#F4EFF0] pt-3">
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
              className="h-10 rounded-[10px] border border-[#EBE3E5] bg-white px-4 text-[13px] font-bold text-[#4a5680] hover:border-baby-pink"
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
            <p className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FFF5F8] px-3 py-2 text-xs font-semibold text-[#68718f]">
              <span>Allow location access to sort by how near activities are to you, or</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  const centroid = REGION_CENTROIDS[e.target.value];
                  if (centroid) setHere(centroid);
                }}
                className="h-7 rounded-[8px] border border-[#EBE3E5] bg-white px-2 text-xs font-bold text-[#4a5680] focus:border-baby-pink focus:outline-none"
              >
                <option value="" disabled>pick your area</option>
                {REGION_FILTERS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </p>
          )}

          {showMore && (
            <div className="grid gap-3 border-t border-[#F4EFF0] pt-3 sm:grid-cols-3">
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
          <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-3 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-baby-green">Explore on map</h2>
              <span className="text-xs font-bold text-[#68718f]">{pinned} of {shown.length} pinned</span>
            </div>
            <div className="relative overflow-hidden rounded-[12px]">
              <ExploreMap activities={shown} regions={regions} />
            </div>
          </section>
          <section>
            {!loading && shown.length === 0 ? (
              <div className="rounded-[12px] bg-[#FFF5F8] p-5 text-center font-bold text-black">
                <p>No activities match these filters — try widening your search.</p>
                <p className="mt-3">
                  We are looking for quality providers in this space, if there is a vendor you would like to see listed here please{" "}
                  <a href="/contact" className="font-black text-baby-cta hover:opacity-80">
                    let us know.
                    <Icon name="open" className="ml-0.5 inline h-3.5 w-3.5 align-[-0.125em]" />
                  </a>
                </p>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between">
                  {loading
                    ? <RainbowLoader size="sm" className="justify-start" label="Loading activities" />
                    : <p className="text-sm font-black">{`${shown.length} activities found`}</p>}
                </div>
                <div className="grid gap-2.5 xl:grid-cols-2">
                  {shown.map((activity) => (
                    <ActivityRow key={activity.id} activity={activity} />
                  ))}
                </div>
              </>
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

/** "Wed, 9 Sept – Thu, 29 Oct", collapsing to a single date when both ends
 *  land on the same day (a one-session course, or a course down to its last
 *  session). */
const sgDayRange = (start: string, end: string) =>
  sgDay(start) === sgDay(end) ? sgDay(start) : `${sgDay(start)} – ${sgDay(end)}`;

/** A Wix COURSE runs on more than one weekly slot — e.g. Wednesdays
 *  5:30–6:30 pm and Thursdays 5:30–7:00 pm — and one enrolment covers all
 *  of them. Groups a course's occurrences into those distinct strands
 *  (weekday + start–end time), each with its own date range and count, so
 *  the two show up as separate lines instead of a wall of near-identical
 *  "5:30 pm" cards. */
function courseStrands(sessions: { starts_at: string; ends_at: string | null }[]) {
  const groups: Record<string, { weekday: string; time: string; dates: string[] }> = {};
  for (const s of sessions) {
    const weekday = new Date(s.starts_at).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "long" });
    const time = s.ends_at ? `${sgTime(s.starts_at)} – ${sgTime(s.ends_at)}` : sgTime(s.starts_at);
    const key = `${weekday}|${time}`;
    (groups[key] ||= { weekday, time, dates: [] }).dates.push(s.starts_at);
  }
  return Object.values(groups)
    .map((g) => {
      const sorted = g.dates.slice().sort();
      return { weekday: g.weekday, time: g.time, first: sorted[0], last: sorted[sorted.length - 1], count: g.dates.length };
    })
    .sort((a, b) => a.first.localeCompare(b.first))
    .map((g) => ({
      key: `${g.weekday}|${g.time}`,
      label: `${g.weekday}s · ${g.time}`,
      range: g.first === g.last ? sgDay(g.first) : `${sgDay(g.first)} – ${sgDay(g.last)}`,
      count: g.count,
    }));
}

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
        className="mt-3 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#EBE3E5] bg-[#FAF7F7] px-6 py-3 text-[15px] font-extrabold leading-none text-[#6D7486]"
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

/** One of the direct-contact buttons (WhatsApp / Email / Website).
 *
 *  QA: "Inconsistencies on options on vendor page — Storytime Stretch doesn't
 *  have any of the comms buttons". Each button used to be rendered only when
 *  that provider happened to have that detail on file, so the panel changed
 *  shape from listing to listing. Every listing now shows the same three, and
 *  the ones we have no details for are visibly unavailable instead of absent. */
function ContactLink({
  icon,
  label,
  href,
  tone,
  unavailableReason,
}: {
  icon: string;
  label: string;
  href: string | null;
  tone: { border: string; text: string; hover: string };
  unavailableReason: string;
}) {
  // Three of these across the 295px rail needed 319px, so "Website" was being
  // clipped mid-word. A half-width floor makes them wrap two-up, with the odd
  // one growing to fill its own row.
  const base =
    "inline-flex min-w-[calc(50%-0.25rem)] flex-1 items-center justify-center gap-2 rounded-[11px] border bg-white px-3 py-2.5 text-[13px] font-extrabold leading-none transition";
  if (!href) {
    return (
      <span
        title={unavailableReason}
        className={`${base} cursor-not-allowed border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]`}
      >
        <Icon name={icon} className="h-4 w-4" /> {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`${base} ${tone.border} ${tone.text} ${tone.hover}`}
    >
      <Icon name={icon} className="h-4 w-4" /> {label}
    </a>
  );
}

function ActivityDetailPage() {
  const { activity, sessions, reviews, courseSpan, loading } = useActivityDetail(getParam("slug"));
  const fav = useFavorite(activity?.id);
  const { session } = useAuth();
  const { isPlus } = usePlan();
  const [enquiring, setEnquiring] = useState(false);
  const [groupChat, setGroupChat] = useState(false);
  /** Shown when a free-plan parent taps "Save to favourites". */
  const [favUpgrade, setFavUpgrade] = useState(false);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  /** Index of the photo open in the lightbox, or null when it's closed. */
  const [galleryAt, setGalleryAt] = useState<number | null>(null);

  /* The next session can carry its own venue (migration 00074) — resolve it
     so the sidebar's Location line reflects that session, not just the
     activity's default. Lazy: most classes run at one place. */
  const [nextVenue, setNextVenue] = useState<string | null>(null);
  useEffect(() => {
    const locId = sessions[0]?.location_id ?? null;
    if (!locId) { setNextVenue(null); return; }
    let cancelled = false;
    supabase
      .from("provider_locations")
      .select("name, address")
      .eq("id", locId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const row = data as { name: string | null; address: string | null } | null;
        setNextVenue(row ? [row.name, row.address].filter(Boolean).join(", ") : null);
      });
    return () => { cancelled = true; };
  }, [sessions]);

  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("packages")
      .select("id, name, credits, price_cents, activity_ids")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null }>;
        setPacks(rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id)));
      });
  }, [activity?.provider_id, activity?.id]);

  async function buyPack(packageId: string) {
    if (!session) {
      goTo("/login");
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
        <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16"><RainbowLoader className="py-4" label="Loading activity" /></main>
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
  // A course's run span — Wix's schedule bounds when known, else first/last
  // visible session (future-only, so it can understate a mid-run course).
  const courseRunRange =
    activity.wix_service_type === "COURSE" && sessions.length > 0
      ? sgDayRange(
          courseSpan?.start ?? sessions[0].starts_at,
          courseSpan?.end ??
            sessions.reduce(
              (m, s) => ((s.ends_at ?? s.starts_at) > m ? (s.ends_at ?? s.starts_at) : m),
              sessions[0].ends_at ?? sessions[0].starts_at
            )
        )
      : null;
  /* The sidebar summarises the next available class, so its price/venue are
     that session's when it overrides them (migration 00074), not the
     activity's defaults. Same session-first, activity-fallback resolution the
     booking page and booking trigger use. */
  const nextPrice = next?.price != null ? Number(next.price) : activity.price != null ? Number(activity.price) : null;
  const nextVenueAddress = nextVenue ?? activity.address ?? null;
  const images = activity.image_urls.length ? activity.image_urls : [`${import.meta.env.BASE_URL}assets/crops/detail-hero.png`];

  // Messaging needs an integrated provider on Growth-and-above, and a Plus
  // subscription on the parent's side. Signed-out visitors still get a live
  // button — it sends them to log in.
  const chatBlockedReason = activity.external_booking_url
    ? "This provider takes bookings on their own site, so messaging isn't available here. Use the WhatsApp or email buttons to reach them."
    : !activity.provider_can_message
      ? "This provider hasn't enabled parent messaging yet. Use the WhatsApp or email buttons to reach them."
      : session && !isPlus
        ? "Messaging providers and other parents is a BabyBrain Plus feature."
        : null;
  const requireLogin = (open: () => void) => () => {
    if (!session) goTo("/login");
    else open();
  };

  const whatsappNumber =
    activity.provider_contact?.whatsapp ?? activity.provider_contact?.contact_phone ?? null;
  // Scraped websites aren't consistently prefixed, and a bare "example.com"
  // href would resolve against our own origin.
  const rawWebsite = activity.provider_contact?.website?.trim() || null;
  const providerWebsite = rawWebsite
    ? /^https?:\/\//i.test(rawWebsite)
      ? rawWebsite
      : `https://${rawWebsite}`
    : null;

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
      {/* The booking rail is a page-level sidebar rather than a cell in the top
          row. It used to sit inside that row, so the row took the rail's full
          height and left a tall blank band under the title and hero before
          About started. On desktop it spans all three grid rows in column 2
          while the hero (row 1), About (row 2) and everything else (row 3)
          stack down column 1. On mobile the page is a plain flex column and
          `order` puts it right after About: hero, About, rail, then the
          sessions/packages/reviews block. */}
      <main className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-5 lg:grid lg:grid-cols-[1fr_295px] lg:items-start">
        <section className="order-1 grid gap-5 lg:order-none lg:col-start-1 lg:row-start-1 lg:grid-cols-[285px_1fr]">
          <div className="flex flex-col">
            <a href="/explore" className="font-bold text-baby-lilac">← Back to results</a>
            <div className="flex flex-1 flex-col justify-center">
              <h1 className="text-[29px] font-black">{activity.title}</h1>
              {activity.provider_name &&
                activity.provider_name.trim().toLowerCase() !== activity.title.trim().toLowerCase() && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[14px] font-bold text-[#C7B1E6]">
                    <Icon name="store" className="h-4 w-4" /> {activity.provider_name}
                  </p>
                )}
              {activity.category_name && (
                <span className="mt-4 inline-flex w-fit items-center gap-1 rounded-[9px] bg-[#FEEBF2] px-4 py-1.5 font-bold text-baby-cta"><Icon name="music" className="h-4 w-4" /> {activity.category_name}</span>
              )}
              {activity.rating_count > 0 && (
                <div className="mt-5 flex gap-5 font-bold"><span className="flex items-center gap-1"><Icon name="star" className="h-4 w-4 text-[#FFD77A]" /> {Number(activity.rating_avg).toFixed(1)} ({activity.rating_count})</span></div>
              )}
            </div>
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
        </section>

        {/* About sits on its own so on mobile it can come between the hero and
            the booking rail; on desktop it's just row 2 of column 1. */}
        <section className="order-2 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-1 lg:row-start-2">
          <InfoBlock title="About" items={[activity.description]} />
        </section>

        <div className="order-4 grid gap-5 lg:order-none lg:col-start-1 lg:row-start-3">
          {/* Per the mockup: Upcoming sessions and Packages sit side by side,
              then Reviews. With no packs to show, sessions takes the full
              width rather than leaving a half-empty row. */}
          <div className="grid gap-5 md:grid-cols-2">
            <section className={`rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card${packs.length === 0 || activity.wix_service_type === "COURSE" ? " md:col-span-2" : ""}`}>
              <h2 className="mb-3 text-xl font-black">{activity.wix_service_type === "COURSE" ? "Course schedule" : "Upcoming sessions"}</h2>
              {activity.wix_service_type === "COURSE" && sessions.length > 0 ? (
                <>
                  <p className="mb-3 text-sm font-bold text-[#4a5685]">
                    Runs {courseRunRange} · one booking covers every session
                  </p>
                  <div className="space-y-2">
                    {courseStrands(sessions).map((st) => (
                      <div key={st.key} className="rounded-[10px] border border-[#EBE3E5] px-3 py-2">
                        <p className="text-sm font-black text-[#34406f]">{st.label}</p>
                        <p className="mt-0.5 text-xs font-semibold text-[#68718f]">{st.range} · {st.count} {st.count === 1 ? "session" : "sessions"}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {sessions.map((s) => (
                    <span key={s.id} className="rounded-[10px] border border-[#EBE3E5] px-3 py-2 text-sm font-bold">{sgDateTime(s.starts_at)}</span>
                  ))}
                  {sessions.length === 0 && <p className="text-sm font-semibold text-[#68718f]">No upcoming sessions scheduled.</p>}
                </div>
              )}
              {durationMins && activity.wix_service_type !== "COURSE" && <p className="mt-3 text-sm font-semibold text-[#68718f]">Each session runs about {durationMins} minutes.</p>}
            </section>

            {packs.length > 0 && activity.wix_service_type !== "COURSE" && (
              <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
                <h2 className="mb-3 text-xl font-black">Packages</h2>
                <div className="grid gap-3">
                  {packs.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#EBE3E5] p-4">
                      <div>
                        <h3 className="font-black">{p.name}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</p>
                      </div>
                      <Button type="button" variant="pink" size="sm" onClick={() => buyPack(p.id)} className={buyingPack === p.id ? "opacity-60" : ""}>
                        {buyingPack === p.id ? "…" : "Buy pack"}
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
            <h2 className="mb-3 text-xl font-black">Reviews ({activity.rating_count})</h2>
            <ReviewForm activityId={activity.id} />
            {reviews.map((r) => (
              <div key={r.id} className="mb-3 border-b border-[#F4EFF0] pb-3">
                <div className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
                {r.comment && <p className="mt-1 font-semibold text-[#34406f]">{r.comment}</p>}
                <p className="mt-1 text-xs font-semibold text-[#6D748D]">A BabyBrain parent</p>
                {r.provider_response && (
                  <div className="mt-2 rounded-[10px] bg-[#FFF5F8] p-3">
                    <p className="text-xs font-black text-baby-pink">Response from the provider</p>
                    <p className="mt-1 text-sm font-semibold text-[#34406f]">{r.provider_response}</p>
                  </div>
                )}
              </div>
            ))}
            {reviews.length === 0 && <p className="text-sm font-semibold text-[#68718f]">No reviews yet — be the first!</p>}
          </section>
        </div>
        <aside className="order-3 h-fit rounded-[18px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-2 lg:row-span-3 lg:row-start-1">
            {nextPrice != null ? (
              nextPrice <= 0 ? (
                <p><strong className="text-[30px] text-baby-lilac">Free</strong></p>
              ) : (
                <p><strong className="text-[30px] text-baby-lilac">${nextPrice}</strong> <span className="font-bold">/ class</span></p>
              )
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
              <Button href={`/book?slug=${activity.slug}`} variant="pink" className="mt-4 w-full"><Icon name="calendar" className="h-4 w-4" /> Book a class</Button>
            )}
            {/* Messaging is a Plus feature and needs an integrated provider:
                a listing that books on the provider's own site has no chat to
                open. The button is always present so the panel keeps the same
                shape — it greys out with the reason rather than disappearing. */}
            <ChatButton
              icon="mail"
              label="Chat with provider"
              disabledReason={
                activity.provider_id
                  ? chatBlockedReason
                  : "We don't have this provider on BabyBrain yet, so there's no chat to open."
              }
              onOpen={requireLogin(() => setEnquiring(true))}
            />
            {/* 1.4: direct click-through contact — the same three every time. */}
            <div className="mt-3 flex flex-wrap gap-2">
              <ContactLink
                icon="whatsapp"
                label="WhatsApp"
                href={
                  whatsappNumber
                    ? `https://wa.me/${phoneDigits(whatsappNumber)}`
                    : null
                }
                tone={{ border: "border-[#A8E59A]", text: "text-[#A8E59A]", hover: "hover:bg-[#F1FBEF]" }}
                unavailableReason="We don't have a WhatsApp number for this provider."
              />
              <ContactLink
                icon="mail"
                label="Email"
                href={
                  activity.provider_contact?.contact_email
                    ? `mailto:${activity.provider_contact.contact_email}?subject=${encodeURIComponent(`Enquiry about ${activity.title}`)}`
                    : null
                }
                tone={{ border: "border-[#A7D8F8]", text: "text-[#A7D8F8]", hover: "hover:bg-[#EDF7FD]" }}
                unavailableReason="We don't have an email address for this provider."
              />
              <ContactLink
                icon="open"
                label="Website"
                href={providerWebsite}
                tone={{ border: "border-[#C7B1E6]", text: "text-[#C7B1E6]", hover: "hover:bg-[#F4F0FA]" }}
                unavailableReason="We don't have a website for this provider."
              />
            </div>
            <ChatButton
              icon="people"
              label="Class group chat"
              disabledReason={chatBlockedReason}
              onOpen={requireLogin(() => setGroupChat(true))}
            />
            <Button
              variant="soft"
              type="button"
              onClick={() => fav.toggle().then((ok) => { if (!ok) setFavUpgrade(true); })}
              className="mt-3 w-full text-baby-pink"
            >
              <Icon name="heart" className="h-4 w-4" /> {fav.saved ? "Saved to favourites" : "Save to favourites"}
            </Button>
            {favUpgrade && <PlusFeatureDialog onClose={() => setFavUpgrade(false)} />}
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
            {/* QA: "Location on vendor pages at the bottom of the far right box
                is misaligned". These were floated spans, so a wrapping address
                dropped out of line with the label beside it. Flex rows keep the
                label and value on the same baseline however long the value. */}
            <div className="mt-5 space-y-4 border-t border-[#F4EFF0] pt-4 text-sm font-semibold">
              {nextVenueAddress && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Location</strong>
                  <span className="text-right">{nextVenueAddress}</span>
                </p>
              )}
              {next && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Next available class</strong>
                  <span className="text-right">{sgDateTime(next.starts_at)}</span>
                </p>
              )}
              {next?.capacity != null && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Spaces available</strong>
                  <span className="text-right text-[#A7D8F8]">{next.capacity} spots</span>
                </p>
              )}
              {durationMins != null && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Duration</strong>
                  <span className="text-right">{formatDuration(durationMins)}</span>
                </p>
              )}
            </div>
        </aside>
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
      <p className="mb-4 rounded-[10px] bg-[#EDF7FD] px-4 py-3 text-sm font-semibold text-[#59658d]">
        <a href="/login" className="font-black text-baby-pink">Log in</a> to leave a review.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) return setError("Pick a star rating first.");
    setBusy(true);
    setError(null);
    // QA: "Should be able to leave a review even if haven't been booked onto a
    // class on the platform as may have been another time" — the
    // booked-and-attended requirement is gone from the RLS policy too.
    const { error } = await supabase.from("reviews").upsert(
      { user_id: session!.user.id, activity_id: activityId, rating, comment: comment.trim() || null },
      { onConflict: "user_id,activity_id" }
    );
    setBusy(false);
    if (error) return setError(error.message);
    window.location.reload();
  }

  return (
    <form onSubmit={submit} className="mb-5 rounded-[12px] border border-[#EBE3E5] bg-[#EDF7FD] p-4">
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
            <Icon name="star" className={`h-7 w-7 ${(hover || rating) >= n ? "text-[#FFD77A] fill-current" : "text-[#DCD2D5]"}`} />
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Share how the class went (optional)"
        className="mt-3 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
      />
      {error && <p className="mt-2 text-sm font-bold text-[#FFC1D6]">{error}</p>}
      <Button type="submit" variant="pink" className="mt-3">{busy ? "Posting…" : "Submit review"}</Button>
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
  activityId: string | null; childId: string | null; packagePurchaseId: string | null;
  allowCancel: boolean; allowReschedule: boolean;
  cancelCutoffH: number; resCutoffH: number;
  // Set once the vendor removes the activity (unlinkWixActivities stamps
  // wix_removed_at) — its own detail page is gone, so booking cards for it
  // route back to the activities list instead of a dead link.
  removed: boolean;
  // For a cancelled booking: how it was made good (00080). 'token' = an
  // auto make-up token was issued; 'credit' = a package credit went back.
  compensation: "token" | "credit" | null;
  // What paid for this booking — drives the cancel-confirm heads-up.
  paidWith: "token" | "credit" | "cash" | "free";
  // A Wix ticketed event — parents can't cancel or reschedule these online.
  isEvent: boolean;
  // A Wix COURSE — one enrolment covers the whole run, so there's no single
  // session to move it to; reschedule is blocked.
  isCourse: boolean;
};
type ReviewItem = { id: string; rating: number; comment: string | null; title: string; slug: string; providerResponse: string | null };
type NotifItem = { id: string; title: string; body: string; read_at: string | null; created_at: string };
type TokenItem = { id: string; status: string; provider: string; activityTitle: string | null; created_at: string; expires_at: string | null; originSlug: string | null; childId: string | null };
type PackageItem = { id: string; name: string; provider: string; total: number; remaining: number; status: string; expiresAt: string | null; bookHref: string };

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
  ["messages", "Messages", "chat", true],
  ["reviews", "Reviews", "star", false],
  ["notifications", "Notifications", "bell", false],
  ["settings", "Settings", "gear", false],
];

/** Pick a date range, then export those bookings as a printable PDF or an
 *  .ics calendar file.
 *
 *  The exports used to take everything at once, which is unhelpful once a
 *  parent has a term's worth of classes — QA asked to "choose a range before
 *  download". Presets cover the common cases; the two date fields (which carry
 *  their own calendar pop-out) handle anything else. */
function ExportScheduleDialog({
  items,
  parentName,
  onClose,
}: {
  items: BookingItem[];
  parentName?: string;
  onClose: () => void;
}) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(addDays(30));

  const presets: [string, string, string][] = [
    ["Next 7 days", iso(new Date()), addDays(7)],
    ["Next 30 days", iso(new Date()), addDays(30)],
    ["Next 3 months", iso(new Date()), addDays(90)],
    ["Everything", "", ""],
  ];

  const entries = items
    .filter((b) => b.startsAt && b.status !== "cancelled")
    .map((b) => ({
      title: b.title,
      startsAt: b.startsAt!,
      endsAt: b.endsAt,
      venue: b.venue,
      status: b.status,
    }));
  const selected = withinRange(entries, { from: from || null, to: to || null });
  const invalid = from && to && from > to;

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Export schedule"
        className="w-full max-w-[420px] rounded-[16px] bg-white p-5 shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Export your schedule</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">
              Choose a date range, then save it as a PDF or add it to your calendar.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-full p-1 text-[#6D748A] hover:bg-[#FAF7F7]">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map(([label, f, t]) => {
            const on = from === f && to === t;
            return (
              <button
                key={label}
                type="button"
                onClick={() => { setFrom(f); setTo(t); }}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  on ? "bg-baby-pink text-white" : "border border-[#EBE3E5] text-[#59658d] hover:border-baby-pink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-black">From</span>
            <DateInput value={from} onChange={setFrom} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black">To</span>
            <DateInput value={to} onChange={setTo} className={input} />
          </label>
        </div>

        <p className={`mt-3 text-sm font-bold ${invalid ? "text-[#FFC1D6]" : "text-[#59658d]"}`}>
          {invalid
            ? "The end date is before the start date."
            : `${selected.length} ${selected.length === 1 ? "class" : "classes"} in this range`}
        </p>

        <div className="mt-4 flex gap-3">
          <Button
            type="button"
            disabled={!!invalid || selected.length === 0}
            onClick={() => {
              downloadSchedulePdf(entries, parentName, { from: from || null, to: to || null });
              onClose();
            }}
            className="flex-1 justify-center"
          >
            <Icon name="open" className="h-4 w-4" /> Save as PDF
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!!invalid || selected.length === 0}
            onClick={() => {
              downloadScheduleIcs(
                selected.map((e, i) => ({
                  id: `${i}-${e.startsAt}`,
                  title: e.title,
                  startsAt: e.startsAt,
                  endsAt: e.endsAt ?? null,
                  venue: e.venue,
                }))
              );
              onClose();
            }}
            className="flex-1 justify-center"
          >
            <Icon name="calendar" className="h-4 w-4" /> Calendar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Blurred behind the Saved-activities upsell on Free, so the section shows
 *  the shape of the feature without leaking a parent's real shortlist. */
const PLACEHOLDER_SAVED = [
  { id: "ph-1", slug: "", title: "Music & Movement", category: "Music & Drama", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "6 months – 2 years", venue: "Central", date: "", time: "", rating: "" },
  { id: "ph-2", slug: "", title: "Sensory Play", category: "Sensory & Art", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "12 months – 3 years", venue: "East", date: "", time: "", rating: "" },
  { id: "ph-3", slug: "", title: "Toddler Gym", category: "Gym & Dance", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "18 months – 4 years", venue: "West", date: "", time: "", rating: "" },
];

/** Stand-in shown where a Plus-only feature would be, with the upgrade path. */
function PlusLock({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-[#FFC1D6] bg-[#FFF5F8] p-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FED7E4] text-baby-cta">
        <Icon name="lock" className="h-7 w-7" />
      </span>
      <h2 className="mt-4 text-xl font-black">{title}</h2>
      <p className="mx-auto mt-2 max-w-[420px] font-semibold text-[#68718f]">{copy}</p>
      <Button href="/pricing" className="mt-5"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
    </div>
  );
}

/** Which child a profile tab is showing.
 *
 *  QA: "If you have more than one child, bookings etc are bundled together —
 *  there should be a drop down under overview, bookings, past activities,
 *  packages, make up tokens, favourites to select which child you want to see
 *  the details for with the option to select both and they are split out."
 *  So: one selector, shared by every tab, and "All children" doesn't merge the
 *  lists — it splits them into a section per child. */
function ChildSelect({
  kids,
  value,
  onChange,
  label = "Showing",
}: {
  kids: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
}) {
  if (kids.length < 2) return null;
  return (
    <label className="mb-4 flex items-center gap-2 text-sm font-bold text-[#4a5685]">
      {label}
      <select
        value={value ?? "all"}
        onChange={(e) => onChange(e.target.value === "all" ? null : e.target.value)}
        className="h-10 rounded-[10px] border border-[#DCD2D5] bg-white px-3 text-sm font-bold text-[#4a5685]"
      >
        <option value="all">All children (split out)</option>
        {kids.map((k) => (
          <option key={k.id} value={k.id}>{k.name}</option>
        ))}
      </select>
    </label>
  );
}

/** Split a list into one group per child, in the order the children appear.
 *  Anything with no child on it lands in a trailing "Not assigned" group. */
function groupByChild<T extends { childId?: string | null; child_id?: string | null }>(
  items: T[],
  kids: { id: string; name: string }[]
): { key: string; name: string; items: T[] }[] {
  const childOf = (i: T) => i.childId ?? i.child_id ?? null;
  const groups = kids
    .map((k) => ({ key: k.id, name: k.name, items: items.filter((i) => childOf(i) === k.id) }))
    .filter((g) => g.items.length > 0);
  const loose = items.filter((i) => !childOf(i) || !kids.some((k) => k.id === childOf(i)));
  if (loose.length) groups.push({ key: "unassigned", name: "Not assigned to a child", items: loose });
  return groups;
}

/** One make-up token, shared by the flat and the split-by-child lists. */
function TokenRow({ t }: { t: TokenItem }) {
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#FEF2D7] text-[#FFD77A]"><Icon name="gift" className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-black">{t.activityTitle ?? t.provider}</h3>
          {t.activityTitle && <p className="truncate text-sm font-bold text-[#3f4b78]">{t.provider}</p>}
          <p className="text-sm font-semibold text-[#59658d]">
            Issued {sgDay(t.created_at)}
            {t.expires_at ? ` · expires ${sgDay(t.expires_at)}` : ""}
          </p>
        </div>
      </div>
      {/* On mobile these drop below the text and line up under it (past the
          48px icon + gap); on sm+ they sit inline on the right as before. */}
      <div className="flex flex-shrink-0 items-center gap-3 pl-16 sm:pl-0">
        {t.status === "issued" && t.originSlug && (
          <Button href={`/book?slug=${t.originSlug}&token=${t.id}`} size="sm" variant="outline">Redeem</Button>
        )}
        <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${tokenStatusStyle(t.status)}`}>{t.status}</span>
      </div>
    </div>
  );
}

function tokenStatusStyle(status: string) {
  if (status === "issued") return "bg-[#F1FBEF] text-palette-green";
  if (status === "redeemed") return "bg-[#FEEBF2] text-baby-cta";
  return "bg-[#FEF9EB] text-[#FFD77A]"; // expired
}

/** One class pack, shared by the active and the used/expired lists. */
function PackageCard({ p }: { p: PackageItem }) {
  const clickable = p.status !== "expired" && p.remaining > 0;
  const Card = clickable ? "a" : "div";
  return (
    <Card
      {...(clickable ? { href: p.bookHref, title: "Book a class with this pack" } : {})}
      className={`flex items-center gap-4 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card ${clickable ? "transition hover:border-baby-pink" : "opacity-60"}`}
    >
      <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#FED7E4] text-baby-cta"><Icon name="store" className="h-6 w-6" /></span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-black">{p.name}</h3>
        <p className="text-sm font-semibold text-[#59658d]">{p.provider}</p>
        {p.expiresAt && (
          <p className={`text-xs font-bold ${p.status === "expired" ? "text-[#FFC1D6]" : "text-[#6D748A]"}`}>
            {p.status === "expired" ? "Expired" : "Expires"} {sgDay(p.expiresAt)}
          </p>
        )}
      </div>
      <div className="text-right">
        {p.status === "expired" ? (
          <span className="rounded-full bg-[#FEF9EB] px-3 py-1 text-xs font-bold text-[#FFD77A]">Expired</span>
        ) : p.remaining === 0 ? (
          <span className="rounded-full bg-[#FEEBF2] px-3 py-1 text-xs font-bold text-baby-cta">All used</span>
        ) : (
          <>
            <p className="text-lg font-black text-baby-pink">{p.remaining}<span className="text-sm text-[#6D748A]">/{p.total}</span></p>
            <p className="text-xs font-bold text-[#6D748A]">credits left</p>
          </>
        )}
      </div>
    </Card>
  );
}

/** QA: "Old and active packages are all bundled together — can we split out
 *  packages and make up tokens that have expired/been used from those that are
 *  active". Used as the heading above each half of both lists. */
function PastHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-8 border-b border-[#F4EFF0] pb-2 text-[15px] font-black uppercase tracking-wide text-[#6D748A]">
      {children}
    </h2>
  );
}

/** A pack is finished once it has expired or every credit has been spent. */
const packIsActive = (p: PackageItem) => p.status !== "expired" && p.remaining > 0;
/** Only an 'issued' token can still be redeemed; redeemed/expired are done. */
const tokenIsActive = (t: TokenItem) => t.status === "issued";

/** "Saved for" row under a favourite — assign it to one child, several, or
 *  leave it unassigned, which means the whole family. Only rendered when there
 *  is more than one child, since with one child the distinction is meaningless. */
function FavChildAssign({
  kids,
  assigned,
  onToggle,
}: {
  kids: Child[];
  assigned: string[];
  onToggle: (childId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-bold text-[#6D748A]">Saved for</span>
      {kids.map((k) => {
        const on = assigned.includes(k.id);
        return (
          <button
            key={k.id}
            type="button"
            onClick={() => onToggle(k.id)}
            aria-pressed={on}
            className={`rounded-full px-2.5 py-1 text-xs font-bold transition ${
              on
                // Solid CTA pink with white text — bright and on-brand, and
                // fully legible (unlike #FA4D8D text on the old #FFC1D6 chip,
                // which measured ~2.1:1).
                ? "bg-[#FA4D8D] text-white"
                : "border border-[#EBE3E5] bg-white text-[#6D748A] hover:border-baby-pink"
            }`}
          >
            {k.name}
          </button>
        );
      })}
      {assigned.length === 0 && (
        <span className="text-xs font-semibold text-[#6D748A]">· everyone</span>
      )}
    </div>
  );
}

function bookingStatusStyle(status: string) {
  if (status === "confirmed" || status === "completed") return "bg-[#F1FBEF] text-palette-green";
  if (status === "cancelled") return "bg-[#FEEBF2] text-baby-cta";
  if (status === "waitlisted") return "bg-amber-50 text-palette-yellow";
  return "bg-[#FEEBF2] text-baby-cta";
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
  const [avatarSeed, setAvatarSeed] = useState<string | null>(initial?.avatar_seed ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
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
    const payload = { name: name.trim(), date_of_birth: dob, gender: gender as Gender, interests, avatar_seed: avatarSeed };
    const { error: err } = initial
      ? await supabase.from("children").update(payload).eq("id", initial.id)
      : await supabase.from("children").insert({ parent_id: parentId, ...payload });
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    // Interests live on the child, but parent-level recommendations read
    // `user_preferences.interests` — keep it as the union across the children
    // so editing a child actually changes what gets suggested.
    const { data: all } = await supabase.from("children").select("interests").eq("parent_id", parentId);
    await supabase
      .from("user_preferences")
      .update({ interests: [...new Set((all ?? []).flatMap((c) => c.interests ?? []))] })
      .eq("user_id", parentId);
    setBusy(false);
    onSaved();
  }

  return (
    <div className="mt-4 rounded-[14px] border border-[#FED7E4] bg-white p-5 shadow-card">
      <h3 className="text-lg font-black">{initial ? `Edit ${initial.name}` : "Add a child"}</h3>
      {error && <p className="mt-2 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
      <div className="mt-3 space-y-3">
        <div>
          <p className="text-sm font-black">Avatar</p>
          <AvatarPicker
            options={CHILD_AVATARS}
            value={avatarSeed}
            onChange={setAvatarSeed}
            kind="child"
            fallbackSeed={name}
            gender={gender}
          />
        </div>
        <div><label className="mb-1 block text-sm font-black">Child's name</label><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emma" /></div>
        <div>
          <label className="mb-1 block text-sm font-black">Date of birth</label>
          <DateInput value={dob} onChange={setDob} className={input} />
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Day first, e.g. 14/03/2024.</p>
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
    <a href={b.removed ? "/explore" : b.slug ? `/activity?slug=${b.slug}` : "/profile?tab=bookings"} className="flex items-center gap-3 rounded-[12px] border border-[#F4EFF0] bg-white p-3 shadow-card transition hover:border-baby-pink">
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
    <section className="mt-5 rounded-[16px] border border-[#FED7E4] bg-[#FFF5F8] p-5">
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
            <p className="mt-4 rounded-[12px] bg-[#FFF5F8] p-5 text-center font-semibold text-[#68718f]">
              No child profiles yet — add one to get personalised matches and track their classes.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {kids.map((c) => {
                const booked = bookings.filter((b) => b.childId === c.id).length;
                const open = viewId === c.id;
                return (
                  <div key={c.id} className={`rounded-[14px] border bg-white p-5 shadow-card transition ${open ? "border-baby-pink ring-1 ring-baby-pink/30" : "border-[#EBE3E5] hover:border-baby-pink"}`}>
                    <button type="button" onClick={() => setViewId(open ? null : c.id)} className="flex w-full items-center gap-4 text-left">
                      <AnimalAvatar seed={c.avatar_seed ?? c.name} kind="child" gender={c.gender} className="h-16 w-16 ring-4 ring-white shadow-soft" />
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
                      <button type="button" onClick={() => remove(c)} className="text-xs font-bold text-[#FFC1D6] hover:underline">Remove</button>
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

/** Grid of avatar choices. Storing the chosen option's seed is all we need to
 *  reproduce the picture; `null` means "pick one for me from my name". */
function AvatarPicker({
  options,
  value,
  onChange,
  kind,
  fallbackSeed,
  gender,
}: {
  options: AvatarOption[];
  value: string | null;
  onChange: (seed: string | null) => void;
  kind: "child" | "parent";
  fallbackSeed?: string;
  /** Drives the "Choose for me" swatch, so it previews the girl/boy default. */
  gender?: string | null;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {[null, ...options.map((o) => o.seed)].map((seed) => {
        const on = value === seed;
        const label = seed ? options.find((o) => o.seed === seed)?.label ?? seed : "Choose for me";
        return (
          <button
            key={seed ?? "default"}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => onChange(seed)}
            className={`rounded-full p-0.5 transition ${on ? "ring-2 ring-baby-pink" : "ring-1 ring-[#F4EFF0] hover:ring-[#FFC1D6]"}`}
          >
            <AnimalAvatar seed={seed ?? fallbackSeed} kind={kind} gender={seed ? null : gender} className="h-11 w-11" />
          </button>
        );
      })}
    </div>
  );
}

/** Edit an existing parent profile.
 *
 *  QA: "When you click edit profile, the form should be pre-populated with what
 *  you have completed before rather than having to do it all again" and "Tried
 *  to edit profile and it added a child instead". Both came from Edit Profile
 *  pointing at /onboarding — the sign-up form, which always inserts a new
 *  child. Children are managed on their own tab; this page never creates one.
 */
function EditProfilePage() {
  const { session, profile, children: kids, loading, refresh } = useAuth();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  // QA: "Under account, edit profile, can only select one budget — should be
  // able to select multiple." Sign-up already worked this way: the parent
  // ticks any number of bands and we store the span they cover.
  const [budgets, setBudgets] = useState<string[]>([]);
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
    supabase
      .from("user_preferences")
      .select("preferred_days, preferred_times, preferred_regions, budget_min, budget_max")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDays(data.preferred_days ?? []);
          setTimes(data.preferred_times ?? []);
          setRegions(data.preferred_regions ?? []);
          // Stored as one min/max span; tick every band that span covers.
          const lo = data.budget_min;
          const hi = data.budget_max;
          if (lo != null || hi != null) {
            setBudgets(
              BUDGET_CHIPS.filter(
                ([, , bLo, bHi]) =>
                  (lo == null || (bHi ?? Infinity) > lo) && (hi == null || (bLo ?? 0) < hi)
              ).map(([k]) => k)
            );
          }
        }
        setReady(true);
      });
  }, [session]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
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
    // QA: "interests show up under the parent section — remove, interests are
    // associated with the child". They still drive parent-level
    // recommendations, so we keep the column in step with the children's own
    // interests rather than asking for them twice.
    const { error: prefErr } = await supabase
      .from("user_preferences")
      .update({
        preferred_days: days as never,
        preferred_times: times as never,
        preferred_regions: regions as never,
        interests: [...new Set(kids.flatMap((c) => c.interests))],
        ...budgetRange(budgets),
      })
      .eq("user_id", session.user.id);
    setBusy(false);
    if (pErr || prefErr) return setError((pErr ?? prefErr)!.message);
    await refresh();
    setSaved(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!loading && !session) return <RedirectToLanding />;

  return (
    <PageShell active="/profile">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <a href="/profile" className="text-sm font-bold text-baby-lilac">← Back to my account</a>
        <h1 className="mt-3 text-[30px] font-black">Edit your profile</h1>
        <p className="mt-1 text-sm font-semibold text-[#44507b]">Update your details and what you'd like us to suggest.</p>

        {saved && (
          <p className="mt-4 rounded-[10px] bg-[#F1FBEF] px-4 py-3 text-sm font-bold text-palette-green">
            Your profile has been updated.
          </p>
        )}

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your avatar</h2>
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Pick the one you like — it shows on your account and in class chats.</p>
          <AvatarPicker
            options={PARENT_AVATARS}
            value={avatarSeed}
            onChange={setAvatarSeed}
            kind="parent"
            fallbackSeed={fullName}
          />
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your details</h2>
          <div className="mt-3 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div><label className="mb-1 block text-sm font-black">Postcode</label><input className={input} inputMode="numeric" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Email</p>
              <p className="font-black">{session?.user.email}</p>
              <p className="text-xs font-semibold text-[#6D748D]">Contact us if you need to change the email on your account.</p>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
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
            {BUDGET_CHIPS.map(([k, l]) => (
              <Chip key={k} on={budgets.includes(k)} onClick={() => toggle(budgets, k, setBudgets)}>{l}</Chip>
            ))}
          </div>

        </section>

        <section className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[#FEE9D7] bg-[#FFF5F8] p-5">
          <div>
            <h2 className="font-black">Your children</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Add, edit or remove a child on their own tab — editing your profile never changes them.</p>
          </div>
          <Button href="/profile?tab=children" variant="outline" className="shrink-0"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">{error}</p>
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
  // Plan gating (sidebar pill, tab locks, per-tab Plus panels) reads from
  // usePlan, which is backed by a persisted last-known value — so a hard
  // refresh renders the real plan straight away instead of flashing the
  // free/locked view while the Stripe route catches up. `planKnown` is false
  // only on a device that has never resolved a plan; until then gated UI
  // stays neutral rather than showing "Free".
  const { isPlus, known: planKnown } = usePlan();
  // Which child the journey panel and suggestions describe. Defaults to the
  // first, but every child is listed and selectable — QA: "If I have two
  // children, only one is showing on the overview".
  const [journeyChildId, setJourneyChildId] = useState<string | null>(null);
  // One per-child selection, shared by every tab that can honour it. null =
  // "All children", which splits the lists out by child rather than merging.
  const [childFilter, setChildFilter] = useState<string | null>(null);
  // The child the journey panel and Overview suggestions describe: whoever the
  // selector names, else whichever card was last clicked, else the first.
  const journeyChild =
    (childFilter ? children.find((c) => c.id === childFilter) : children.find((c) => c.id === journeyChildId)) ??
    children[0];
  const journey = useJourney(journeyChild?.id);
  const { data: recsByChild } = useRecommendations(children);
  const [favs, setFavs] = useState<ReturnType<typeof toCard>[]>([]);
  // activity_id -> child ids it's assigned to. Empty/absent = whole family.
  const [favChildren, setFavChildren] = useState<Record<string, string[]>>({});
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

  // Below lg the nav is a left-hand drawer, not a stacked block. Landing on the
  // profile (the Overview tab) auto-reveals it: it slides in, holds for 4s,
  // then rolls back. On the other tabs it stays closed until the edge handle
  // (› / ‹) or a tap on the dimmed page opens it. At lg the Tailwind `lg:`
  // classes drop the fixed positioning and it's a static sidebar again.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (tab !== "overview") return;
    let rollBack: ReturnType<typeof setTimeout>;
    // Open on a short delay so the closed state paints once and the slide-in
    // animates; the 4s hold is chained off the open (not anchored to mount),
    // so a slow first render still gets the full reveal.
    const slideIn = setTimeout(() => {
      setMenuOpen(true);
      rollBack = setTimeout(() => setMenuOpen(false), 4000);
    }, 60);
    return () => {
      clearTimeout(slideIn);
      clearTimeout(rollBack);
    };
  }, [tab]);

  // The mobile drawer's edge handle can be long-pressed (hold > 2s) to enter
  // "adjust mode", then dragged up or down to wherever the parent wants it.
  // The position is clamped to stay HANDLE_EDGE px clear of the top and bottom
  // of the viewport, and remembered on the device. `null` = the default,
  // vertically centred.
  const HANDLE_EDGE = 72;
  const [handleY, setHandleY] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem("bb:profile-handle-y");
      return v == null || Number.isNaN(Number(v)) ? null : Number(v);
    } catch {
      return null;
    }
  });
  const [handleAdjusting, setHandleAdjusting] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adjustingRef = useRef(false);
  const draggedRef = useRef(false);
  const pressStartY = useRef(0);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // While adjusting, kill every touch-scroll on the page — pointer capture
  // alone doesn't stop the page behind from panning, and the listener has to
  // be non-passive (React's own touch listeners are passive) to preventDefault.
  useEffect(() => {
    if (!handleAdjusting) return;
    const block = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [handleAdjusting]);

  const clampHandleY = (y: number) =>
    Math.min(Math.max(y, HANDLE_EDGE), window.innerHeight - HANDLE_EDGE);

  function handlePressStart(e: ReactPointerEvent<HTMLButtonElement>) {
    draggedRef.current = false;
    pressStartY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    holdTimer.current = setTimeout(() => {
      adjustingRef.current = true;
      setHandleAdjusting(true);
      navigator.vibrate?.(25);
    }, 1000);
  }
  function handlePressMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!adjustingRef.current) {
      // Slid away before the hold completed — that's a scroll attempt, not a
      // long-press; abandon the pending timer.
      if (holdTimer.current && Math.abs(e.clientY - pressStartY.current) > 10) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      return;
    }
    draggedRef.current = true;
    setHandleY(clampHandleY(e.clientY));
  }
  function handlePressEnd() {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (adjustingRef.current) {
      adjustingRef.current = false;
      setHandleAdjusting(false);
      // Any adjust-mode session — even a long-press with no drag — must not
      // fall through to toggling the drawer.
      draggedRef.current = true;
      setHandleY((y) => {
        if (y != null) {
          try {
            localStorage.setItem("bb:profile-handle-y", String(Math.round(y)));
          } catch {
            /* private window — the position just won't stick */
          }
        }
        return y;
      });
    }
  }
  function handlePressClick(e: ReactMouseEvent) {
    // A press that turned into a drag must not also toggle the drawer.
    if (draggedRef.current) {
      draggedRef.current = false;
      e.preventDefault();
      return;
    }
    setMenuOpen((v) => !v);
  }

  // Goes through the /api/customer/bookings backend route (service role)
  // instead of querying `bookings` directly from the browser — a direct
  // client-side query is subject to RLS's "published activities are public"
  // policy on the nested activities/activity_sessions join, which has no
  // exception for a parent viewing their own past booking. Once a vendor
  // removes/unpublishes an activity, that join silently came back null and
  // My Bookings fell back to a bare "Class" placeholder with no date.
  function loadBookings() {
    apiGet<{
      bookings: Array<{
        id: string;
        status: string;
        child_id: string | null;
        package_purchase_id: string | null;
        activity_sessions: {
          starts_at: string;
          ends_at: string | null;
          activity_id: string;
          activities: {
            title: string; slug: string; image_urls: string[]; address: string | null;
            allow_cancellation: boolean; allow_rescheduling: boolean;
            cancellation_cutoff_hours: number; reschedule_cutoff_hours: number;
            wix_removed_at: string | null;
            wix_missing_since: string | null;
            wix_service_type: string | null;
          } | null;
        } | null;
        compensation: "token" | "credit" | null;
        paid_with: "token" | "credit" | "cash" | "free";
      }>;
    }>("/api/customer/bookings")
      .then(({ bookings: rows }) => {
        setBookings(
          rows.map((r) => {
            const s = r.activity_sessions;
            const act = s?.activities;
            // A Wix COURSE booking's session row spans the whole run, so it
            // reads as a start–end date range rather than a single class time.
            const courseBooking = act?.wix_service_type === "COURSE";
            return {
              id: r.id,
              status: r.status,
              when: s?.starts_at
                ? courseBooking && s.ends_at
                  ? sgDayRange(s.starts_at, s.ends_at)
                  : sgDateTime(s.starts_at)
                : "",
              title: act?.title ?? "Class",
              slug: act?.slug ?? "",
              // activity-play is the only crop without a category tag baked
              // into the artwork, so it's the safe generic fallback.
              image: act?.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-play.png`,
              startsAt: s?.starts_at ?? null,
              endsAt: s?.ends_at ?? null,
              venue: act?.address ?? "",
              activityId: s?.activity_id ?? null,
              childId: r.child_id ?? null,
              packagePurchaseId: r.package_purchase_id ?? null,
              allowCancel: act?.allow_cancellation ?? true,
              allowReschedule: act?.allow_rescheduling ?? true,
              cancelCutoffH: act?.cancellation_cutoff_hours ?? 24,
              resCutoffH: act?.reschedule_cutoff_hours ?? 24,
              removed: act?.wix_removed_at != null || act?.wix_missing_since != null,
              compensation: r.compensation ?? null,
              paidWith: r.paid_with ?? "free",
              isEvent: act?.wix_service_type === "EVENT",
              isCourse: courseBooking,
            };
          })
        );
      });
  }

  async function loadPackages() {
    // `packages` lost its single `activity_id` column in migration 00068 (it's
    // an `activity_ids` array now), so the old `packages(activities(slug))`
    // embed no longer resolves — PostgREST 400s the whole select and the tab
    // was stuck on "No packages yet" even with credits sitting on the account.
    const { data, error } = await supabase
      .from("package_purchases")
      .select(
        "id, credits_total, credits_remaining, status, expires_at, packages(name, activity_ids), providers(business_name)"
      )
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("[packages] load failed:", error.message);
      return;
    }
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      credits_total: number;
      credits_remaining: number;
      status: string;
      expires_at: string | null;
      packages: { name: string; activity_ids: string[] | null } | null;
      providers: { business_name: string } | null;
    }>;

    // A pack tied to exactly one class can deep-link straight to its booking
    // page — resolve those slugs in one query. Multi-class and open packs go
    // to Explore pre-searched for the provider, since there's no single class
    // to jump into.
    const soloActivityIds = [
      ...new Set(
        rows
          .map((r) => (r.packages?.activity_ids?.length === 1 ? r.packages.activity_ids[0] : null))
          .filter((id): id is string => id != null)
      ),
    ];
    const slugById = new Map<string, string>();
    if (soloActivityIds.length) {
      const { data: acts } = await supabase.from("activities").select("id, slug").in("id", soloActivityIds);
      for (const a of (acts ?? []) as Array<{ id: string; slug: string }>) slugById.set(a.id, a.slug);
    }

    setPackages(
      rows.map((r) => {
        const ids = r.packages?.activity_ids ?? [];
        const slug = ids.length === 1 ? slugById.get(ids[0]) : undefined;
        const bookHref = slug
          ? `/book?slug=${encodeURIComponent(slug)}`
          : `/explore?q=${encodeURIComponent(r.providers?.business_name ?? "")}`;
        return {
          id: r.id,
          name: r.packages?.name ?? "Class package",
          provider: r.providers?.business_name ?? "A provider",
          total: r.credits_total,
          remaining: r.credits_remaining,
          status: r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status,
          expiresAt: r.expires_at,
          bookHref,
        };
      })
    );
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

    // Which children each favourite is assigned to. A favourite with no rows is
    // saved for the whole family, which is what every pre-existing favourite is.
    supabase
      .from("favorite_children")
      .select("activity_id, child_id")
      .then(({ data }) => {
        const m: Record<string, string[]> = {};
        for (const r of (data ?? []) as { activity_id: string; child_id: string }[]) {
          (m[r.activity_id] ??= []).push(r.child_id);
        }
        setFavChildren(m);
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
        .select("id, status, created_at, expires_at, origin_booking_id, child_id, providers(business_name)")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        status: string;
        created_at: string;
        expires_at: string | null;
        origin_booking_id: string | null;
        child_id: string | null;
        providers: { business_name: string } | null;
      }>;
      // Resolve the origin class from its booking — the slug so "Redeem" can
      // link to the booking page, the title so the card can lead with the
      // class name rather than just the provider.
      const originIds = [...new Set(rows.map((r) => r.origin_booking_id).filter((x): x is string => !!x))];
      const originByBooking = new Map<string, { slug: string | null; title: string | null }>();
      if (originIds.length) {
        const { data: bks } = await supabase
          .from("bookings")
          .select("id, activity_sessions(activities(slug, title))")
          .in("id", originIds);
        for (const b of (bks ?? []) as unknown as Array<{ id: string; activity_sessions: { activities: { slug: string; title: string } | null } | null }>) {
          const act = b.activity_sessions?.activities;
          if (act) originByBooking.set(b.id, { slug: act.slug ?? null, title: act.title ?? null });
        }
      }
      setTokens(
        rows.map((r) => {
          const origin = r.origin_booking_id ? originByBooking.get(r.origin_booking_id) ?? null : null;
          return {
            id: r.id,
            status: r.status,
            created_at: r.created_at,
            expires_at: r.expires_at,
            provider: r.providers?.business_name ?? "A provider",
            activityTitle: origin?.title ?? null,
            childId: r.child_id,
            originSlug: origin?.slug ?? null,
          };
        })
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
        .then((p) => {
          setBillingPlan(p);
          // Keep usePlan's persisted value in step with this fuller fetch.
          primePlan(p.plan);
        })
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
          loadBookings();
        });
    } else {
      fetchPlan();
    }
  }, [session]);

  if (!loading && !session) return <RedirectToLanding />;

  const recs =
    recsByChild.find((r) => r.child.id === journeyChild?.id)?.recs ?? recsByChild[0]?.recs ?? [];
  const parentName = profile?.full_name || "Your family";
  // A class is "past" once its start time has gone by. Attendance decides
  // which of the two past lists it lands in.
  const now = Date.now();
  const isPast = (b: BookingItem) =>
    b.status !== "cancelled" && !!b.startsAt && new Date(b.startsAt).getTime() < now;
  const childFiltered = childFilter
    ? bookings.filter((b) => b.childId === childFilter)
    : bookings;
  const upcomingBookings = childFiltered.filter((b) => !isPast(b));
  const pastBookings = childFiltered.filter(isPast);
  // "All children" with more than one child means split out, not merged.
  const splitByChild = childFilter === null && children.length > 1;
  // Overview: picking a child narrows the tab to them; "All children" keeps
  // one card each, which is already split out.
  const overviewChildren = childFilter ? children.filter((c) => c.id === childFilter) : children;
  const filterChild = children.find((c) => c.id === childFilter) ?? null;
  // Packs aren't bought for a particular child — any of them can spend a
  // credit — so a pack belongs to a child once one of their bookings has used
  // it, and an unspent pack belongs to all of them.
  const packChildIds = (purchaseId: string) =>
    new Set(bookings.filter((b) => b.packagePurchaseId === purchaseId && b.childId).map((b) => b.childId as string));
  const packagesForChild = (childId: string | null) =>
    childId === null
      ? packages
      : packages.filter((p) => {
          const used = packChildIds(p.id);
          return used.size === 0 || used.has(childId);
        });
  const visiblePackages = packagesForChild(childFilter);
  const visibleTokens = childFilter ? tokens.filter((t) => t.childId === childFilter) : tokens;

  // QA: packs and tokens that are spent or expired were mixed in with the live
  // ones, so what a parent could still use wasn't obvious. Split, live first.
  const activePackages = visiblePackages.filter(packIsActive);
  const finishedPackages = visiblePackages.filter((p) => !packIsActive(p));
  const activeTokens = visibleTokens.filter(tokenIsActive);
  const finishedTokens = visibleTokens.filter((t) => !tokenIsActive(t));

  // A favourite shows for a child when it's assigned to them, or to nobody in
  // particular (saved for the whole family).
  const visibleFavs = childFilter
    ? favs.filter((a) => {
        const assigned = favChildren[a.id] ?? [];
        return assigned.length === 0 || assigned.includes(childFilter);
      })
    : favs;

  /** Assign / unassign a favourite to a child, writing straight through. */
  async function toggleFavChild(activityId: string, childId: string) {
    if (!session) return;
    const assigned = favChildren[activityId] ?? [];
    const on = assigned.includes(childId);
    // Optimistic — the row is the parent's own, and a failure just reloads.
    setFavChildren((prev) => ({
      ...prev,
      [activityId]: on ? assigned.filter((c) => c !== childId) : [...assigned, childId],
    }));
    const q = supabase.from("favorite_children");
    const { error } = on
      ? await q.delete().eq("activity_id", activityId).eq("child_id", childId)
      : await q.insert({ user_id: session.user.id, activity_id: activityId, child_id: childId });
    if (error) {
      setFavChildren((prev) => ({ ...prev, [activityId]: assigned }));
    }
  }

  return (
    <PageShell active="/profile">
      {/* On mobile the order is nav → tab content → referral/contact, so
          switching tabs shows the content straight away instead of burying it
          under the promo blocks. On desktop both sidebar cards stack on the
          left with the content beside them. */}
      <main className="mx-auto flex max-w-[1122px] flex-col gap-5 px-4 py-5 sm:px-6 lg:grid lg:grid-cols-[235px_1fr] lg:grid-rows-[auto_1fr] lg:items-start">
        {/* Tap-away scrim: covers the ~50% of the page the open drawer leaves
            visible, and closes the drawer when tapped. Mobile only. */}
        {menuOpen && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          />
        )}
        {/* Edge handle — a chunky chevron that points right (>) into the page
            when closed and left (<) toward the drawer when open. It rides the
            drawer's edge as it slides. Mobile only. */}
        <button
          type="button"
          aria-label={
            handleAdjusting
              ? "Drag up or down to reposition, release to set"
              : menuOpen
                ? "Close menu"
                : "Open menu"
          }
          onPointerDown={handlePressStart}
          onPointerMove={handlePressMove}
          onPointerUp={handlePressEnd}
          onPointerCancel={handlePressEnd}
          onClick={handlePressClick}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            top: handleY == null ? "50%" : `${clampHandleY(handleY)}px`,
            transform: `translateY(-50%)${handleAdjusting ? " scale(1.12)" : ""}`,
          }}
          // touch-none is unconditional: it has to be set before the gesture
          // starts, or the browser has already claimed the touch as a scroll.
          className={`fixed z-50 -ml-px grid h-11 w-7 touch-none select-none place-items-center rounded-r-[10px] bg-white text-baby-cta shadow-[4px_1px_10px_rgba(17,26,76,0.10)] ease-out lg:hidden ${
            handleAdjusting
              ? "ring-2 ring-[#FA4D8D]/50 transition-transform"
              : "transition-[left] duration-300"
          } ${menuOpen ? "left-[62%]" : "left-0"}`}
        >
          <Icon name="chevron" strokeWidth={3} className={`h-5 w-5 ${menuOpen ? "rotate-180" : ""}`} />
        </button>
        <aside
          className={`fixed inset-y-0 left-0 z-40 order-1 w-[62%] overflow-y-auto transition-transform duration-300 ease-out lg:static lg:z-auto lg:w-auto lg:overflow-visible lg:transition-none lg:translate-x-0 lg:col-start-1 lg:row-start-1 ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="min-h-full rounded-[12px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:min-h-0">
            <div className="flex items-center gap-3">
              <AnimalAvatar seed={profile?.avatar_seed ?? parentName} kind="parent" className="h-14 w-14" />
              <div className="min-w-0">
                <h2 className="truncate font-black">{parentName}</h2>
                {children.map((c) => (
                  <p key={c.id} className="truncate text-sm font-semibold text-[#59658d]">
                    {c.name} · {formatChildAge(c.date_of_birth)}
                  </p>
                ))}
              </div>
            </div>
            {planKnown ? (
              <a
                href={isPlus ? "/profile?tab=settings" : "/pricing"}
                className={`mt-4 flex items-center justify-between rounded-[10px] px-3 py-2 text-sm font-bold ${isPlus ? "bg-[#FED7E4] text-baby-cta" : "bg-[#FEF4EB] text-[#FFB77A]"}`}
              >
                <span className="flex items-center gap-1.5">
                  <Icon name={isPlus ? "star" : "spark"} className="h-4 w-4" />
                  {isPlus ? "Plus plan" : "Free plan"}
                </span>
                <span className="text-xs">{isPlus ? "Manage" : "Upgrade →"}</span>
              </a>
            ) : (
              <div className="mt-4 flex items-center gap-1.5 rounded-[10px] bg-[#F4EFF0] px-3 py-2 text-sm font-bold text-[#6D7486]">
                <Icon name="spark" className="h-4 w-4 animate-pulse" />
                Checking your plan…
              </div>
            )}
            <nav className="mt-4 space-y-1.5">
              {PROFILE_TABS.map(([key, item, icon, plusOnly]) => {
                const locked = planKnown && plusOnly && !isPlus;
                return (
                  <a
                    key={key}
                    href={`/profile?tab=${key}`}
                    className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-bold ${tab === key ? "bg-[#FED7E4] text-baby-cta" : locked ? "text-[#6D7486] hover:bg-[#EDF7FD]" : "text-[#5a6484] hover:bg-[#EDF7FD]"}`}
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
          {/* Invite a friend removed: the referral mechanism isn't built,
              so the $10-credit promise had nothing behind it. */}
          <div className="rounded-[12px] bg-[#EDF7FD] p-5">
            <h3 className="font-black">Need help?</h3>
            <p className="mt-2 text-sm font-semibold">Our support team is here for you.</p>
            <a href="/contact" className="mt-4 block font-black text-[#FFC1D6]">Contact support →</a>
          </div>
        </aside>
        <section className="order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {tab === "overview" && (
          <>
          {/* QA: "If I have two children, only one is showing on the overview".
              Every child gets their own card; the journey panel follows the
              child whose card is selected. The selector narrows the whole tab
              to one child, or leaves every child's card showing. */}
          <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} label="Overview for" />
          <div className="grid items-start gap-5 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card lg:grid-cols-[1fr_235px]">
            <div>
              {children.length === 0 ? (
                <div className="flex items-center gap-5">
                  <AnimalAvatar kind="child" className="h-24 w-24 ring-4 ring-white shadow-soft" />
                  <div>
                    <h1 className="text-[30px] font-black">Your child</h1>
                    <p className="mt-1.5 text-sm font-semibold text-[#68718f]">
                      Add a child to get personalised matches. <a href="/profile?tab=children" className="font-black text-baby-pink">Add a child →</a>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {overviewChildren.map((c) => {
                    const on = c.id === journeyChild?.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setJourneyChildId(c.id)}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-5 rounded-[12px] border p-3 text-left transition ${
                          children.length > 1
                            ? on
                              ? "border-baby-pink bg-[#FFF5F8] ring-1 ring-baby-pink/30"
                              : "border-[#F4EFF0] hover:border-baby-pink"
                            : "border-transparent"
                        }`}
                      >
                        <AnimalAvatar seed={c.avatar_seed ?? c.name} kind="child" gender={c.gender} className="h-20 w-20 shrink-0 ring-4 ring-white shadow-soft" />
                        <div className="min-w-0">
                          <h1 className="text-[26px] font-black leading-tight">{c.name}</h1>
                          <p className="mt-1 text-base font-semibold">{formatChildAge(c.date_of_birth)}</p>
                          {c.interests.length > 0 && (
                            <p className="mt-2 text-sm font-semibold capitalize leading-6 text-[#4a5685]">
                              <Icon name="heart" className="mr-1 inline h-3.5 w-3.5 text-[#FFC1D6]" />
                              {c.interests.map((i) => i.replace(/-/g, " ")).join(", ")}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="mt-5 flex flex-wrap gap-3">
                <Button href="/edit-profile" variant="outline"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
                {children.length > 0 && (
                  <Button href="/profile?tab=children" variant="outline"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
                )}
              </div>
            </div>
            <div className="rounded-[10px] bg-[#FEEBF2] p-5">
              <h2 className="mb-4 text-lg font-black">{journeyChild ? `${journeyChild.name}'s journey` : "Journey"}</h2>
              {[
                [`${journey?.classes_attended ?? 0} activities attended`, "calendar"],
                [`${journey?.venues_explored ?? 0} venues explored`, "pin"],
                [`${journey?.hours_of_learning ?? 0} hours completed`, "clock"],
              ].map(([item, icon]) => (
                <p key={item} className="mb-4 flex items-center gap-2 text-base font-black text-[#A7D8F8]"><Icon name={icon} className="h-4 w-4" /> <span className="text-baby-ink">{item}</span></p>
              ))}
            </div>
          </div>

          {/* Saved activities is a Plus feature, so on Free it shows as a
              locked teaser rather than real content — QA: "Saved activities
              shouldn't be showing under overview for free subscription". Held
              back until the plan is known so a Plus parent never sees the
              locked teaser flash on a hard refresh. */}
          {planKnown && (
          <section className="mt-6">
            <SectionTitle
              emoji="🩷"
              action={
                isPlus ? (
                  <a href="/profile?tab=favorites" className="font-bold text-[#FFC1D6]">View all →</a>
                ) : (
                  <a href="/pricing" className="flex items-center gap-1 font-bold text-[#FFC1D6]">
                    <Icon name="lock" className="h-3.5 w-3.5" /> Plus feature
                  </a>
                )
              }
            >
              Saved activities
            </SectionTitle>
            {isPlus ? (
              <div className="grid gap-4 md:grid-cols-3">
                {favs.slice(0, 3).map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
                {favs.length === 0 && <p className="font-semibold text-[#68718f]">Nothing saved yet — tap the heart on any activity.</p>}
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-[14px] border border-dashed border-[#FFC1D6] bg-[#FFF5F8]">
                <div aria-hidden="true" className="pointer-events-none grid select-none gap-4 p-4 opacity-40 blur-[3px] md:grid-cols-3">
                  {(favs.length ? favs.slice(0, 3) : PLACEHOLDER_SAVED).map((activity) => (
                    <ActivityCard key={activity.id} activity={activity} />
                  ))}
                </div>
                <div className="absolute inset-0 grid place-items-center bg-white/55 p-6 text-center">
                  <div>
                    <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#FED7E4] text-baby-cta">
                      <Icon name="lock" className="h-6 w-6" />
                    </span>
                    <p className="mt-3 font-black">Saving activities is a Plus feature</p>
                    <p className="mx-auto mt-1 max-w-[360px] text-sm font-semibold text-[#68718f]">
                      Keep a shortlist of the classes you like and come back to them any time.
                    </p>
                    <Button href="/pricing" size="sm" className="mt-3"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
                  </div>
                </div>
              </div>
            )}
          </section>
          )}

          <section className="mt-6">
            {/* Say whose suggestions these are — the list already follows the
                child picked above, but nothing on screen said so. */}
            <SectionTitle action={<a href="/matches" className="font-bold text-[#FFC1D6]">See all matches →</a>}>
              {journeyChild ? `Suggested for ${journeyChild.name}` : "Suggested activities"}
            </SectionTitle>
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
              <p className="mb-4 text-sm font-semibold text-[#59658d]">Classes still to come. Once a class time has passed it moves to Past activities.</p>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {splitByChild ? (
                <div className="space-y-8">
                  {groupByChild(upcomingBookings, children).map((g) => (
                    <section key={g.key}>
                      <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
                      <BookingList items={g.items} emptyCopy="" onChanged={loadBookings} isPlus={isPlus} />
                    </section>
                  ))}
                  {upcomingBookings.length === 0 && (
                    <BookingList items={[]} emptyCopy="You haven't booked any upcoming classes yet." onChanged={loadBookings} isPlus={isPlus} />
                  )}
                </div>
              ) : (
                <BookingList items={upcomingBookings} emptyCopy="You haven't booked any upcoming classes yet." onChanged={loadBookings} isPlus={isPlus} />
              )}
            </div>
          )}

          {tab === "past" && (
            <PastActivitiesTab
              items={pastBookings}
              onChanged={loadBookings}
              filterChips={<ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />}
              groups={splitByChild ? groupByChild(pastBookings, children) : null}
            />
          )}

          {/* The plus-gated tabs: until the plan is known, show a brief
              placeholder rather than the Plus lock (which would flash for a
              parent who is actually on Plus). */}
          {["packages", "makeup", "favorites", "messages"].includes(tab) && !planKnown && (
            <div className="grid place-items-center py-16 text-center font-semibold text-[#6D7486]">
              <Icon name="spark" className="mb-2 h-6 w-6 animate-pulse" />
              Checking your plan…
            </div>
          )}

          {tab === "packages" && planKnown && !isPlus && (
            <PlusLock
              title="Packages are a Plus feature"
              copy="With Plus, every class pack you buy through BabyBrain is stored here and you can click straight through to book. On the free plan we email your pack details to you instead."
            />
          )}
          {tab === "packages" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Packages</h1>
              <p className="mb-4 mt-1 text-sm font-semibold text-[#59658d]">Class packs you've bought through BabyBrain — each booking with that provider can use a credit. Packs bought directly with a provider won't appear here.</p>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {filterChild && (
                <p className="mb-3 rounded-[10px] bg-[#F4F0FA] px-3 py-2 text-xs font-bold text-[#7A67A6]">
                  A pack's credits can be spent on any of your children — this shows the packs {filterChild.name} has used, plus any still untouched.
                </p>
              )}
              {visiblePackages.length === 0 ? (
                <EmptyPanel icon="store" copy="No packages yet. Providers offering class packs show a 'Buy pack' option on their class pages." cta="Browse activities" href="/explore" />
              ) : (
                <>
                  {activePackages.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {activePackages.map((p) => <PackageCard key={p.id} p={p} />)}
                    </div>
                  )}
                  {activePackages.length === 0 && (
                    <EmptyPanel icon="store" copy="No active packs — everything below has been used up or expired." cta="Browse activities" href="/explore" />
                  )}
                  {finishedPackages.length > 0 && (
                    <>
                      <PastHeading>Used &amp; expired</PastHeading>
                      <div className="space-y-3">
                        {finishedPackages.map((p) => <PackageCard key={p.id} p={p} />)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "makeup" && planKnown && !isPlus && (
            <PlusLock
              title="Make-up tokens are a Plus feature"
              copy="With Plus, make-up tokens from every provider who issues through BabyBrain are gathered here and you can click straight through to rebook. On the free plan they come to you by email."
            />
          )}
          {tab === "makeup" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Make-up tokens</h1>
              <p className="mb-4 mt-1 text-sm font-semibold text-[#59658d]">Credits from a provider for a missed class — redeem them when you book a future session with that provider.</p>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {visibleTokens.length === 0 ? (
                <EmptyPanel icon="gift" copy="No make-up tokens yet. If you miss a class, your provider can issue one here." />
              ) : splitByChild ? (
                /* Split by child first, then active/finished within each child,
                   so a parent still sees whose token is whose. */
                <div className="mt-4 space-y-8">
                  {groupByChild(visibleTokens, children).map((g) => {
                    const act = g.items.filter(tokenIsActive);
                    const fin = g.items.filter((t) => !tokenIsActive(t));
                    return (
                      <section key={g.key}>
                        <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
                        {act.length > 0 && <div className="space-y-3">{act.map((t) => <TokenRow key={t.id} t={t} />)}</div>}
                        {fin.length > 0 && (
                          <>
                            <PastHeading>Used &amp; expired</PastHeading>
                            <div className="space-y-3">{fin.map((t) => <TokenRow key={t.id} t={t} />)}</div>
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <>
                  {activeTokens.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {activeTokens.map((t) => <TokenRow key={t.id} t={t} />)}
                    </div>
                  )}
                  {activeTokens.length === 0 && (
                    <EmptyPanel icon="gift" copy="No tokens left to redeem — everything below has been used or has expired." />
                  )}
                  {finishedTokens.length > 0 && (
                    <>
                      <PastHeading>Used &amp; expired</PastHeading>
                      <div className="space-y-3">
                        {finishedTokens.map((t) => <TokenRow key={t.id} t={t} />)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "favorites" && planKnown && !isPlus && (
            <PlusLock
              title="Saved favourites are a Plus feature"
              copy="Upgrade to keep your favourite activities and providers on your own list, so you can come back to them any time."
            />
          )}
          {tab === "favorites" && isPlus && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Favourites</h1>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {filterChild && (
                <p className="mb-3 rounded-[10px] bg-[#F4F0FA] px-3 py-2 text-xs font-bold text-[#7A67A6]">
                  Showing what's saved for {filterChild.name}, plus anything saved for the whole family.
                </p>
              )}
              {favs.length === 0 ? (
                <EmptyPanel icon="heart" copy="Nothing saved yet — tap the heart on any activity." cta="Browse activities" href="/explore" />
              ) : visibleFavs.length === 0 ? (
                <EmptyPanel icon="heart" copy={`Nothing saved for ${filterChild?.name ?? "this child"} yet — use "Saved for" on any favourite to assign it.`} cta="Browse activities" href="/explore" />
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {visibleFavs.map((activity) => (
                    <div key={activity.id}>
                      <ActivityCard
                        activity={activity}
                        onFavoriteToggled={(id, saved) => {
                          if (!saved) setFavs((prev) => prev.filter((a) => a.id !== id));
                        }}
                      />
                      {children.length > 1 && (
                        <FavChildAssign
                          kids={children}
                          assigned={favChildren[activity.id] ?? []}
                          onToggle={(childId) => toggleFavChild(activity.id, childId)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {savedProviders.length > 0 && (
                <div className="mt-8">
                  <h2 className="mb-3 text-xl font-black">Saved providers</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {savedProviders.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                        <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-[#FED7E4] text-baby-cta"><Icon name="store" className="h-5 w-5" /></span>
                        <h3 className="truncate font-black">{p.name}</h3>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "messages" && planKnown && !isPlus && (
            <PlusLock
              title="Messages are a Plus feature"
              copy="With Plus, every conversation with an integrated provider — enquiries, class group chats, support — lives in one inbox. You can still read messages on your booked classes for free; sending needs Plus and the provider to have messaging enabled."
            />
          )}
          {tab === "messages" && isPlus && session && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Messages</h1>
              <MessagesTab userId={session.user.id} />
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
                    <div key={r.id} className="rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                      <div className="flex items-center justify-between">
                        <a href={r.slug ? `/activity?slug=${r.slug}` : "/explore"} className="font-black hover:text-baby-pink">{r.title}</a>
                        <span className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-4 w-4 fill-current" />)}</span>
                      </div>
                      {r.comment && <p className="mt-1.5 font-semibold text-[#34406f]">{r.comment}</p>}
                      {r.providerResponse && (
                        <div className="mt-2 rounded-[10px] bg-[#FFF5F8] p-3">
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
                    <div key={n.id} className={`rounded-[12px] border p-4 shadow-card ${n.read_at ? "border-[#EBE3E5] bg-white" : "border-[#DAEEFB] bg-[#FFF5F8]"}`}>
                      <div className="flex items-start gap-2">
                        {!n.read_at && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-baby-pink" />}
                        <div>
                          <p className="font-black">{n.title}</p>
                          {n.body && <p className="mt-0.5 text-sm font-semibold text-[#59658d]">{n.body}</p>}
                          <p className="mt-1 text-xs font-semibold text-[#6D748A]">{sgDateTime(n.created_at)}</p>
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
                <div className="mb-4 rounded-[12px] border border-green-300 bg-green-50 px-4 py-3 text-sm font-bold text-palette-green">
                  🎉 Welcome to Plus! Your subscription is active — your first month is free.
                </div>
              )}

              {/* Plan & Billing */}
              <div className="mb-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Plan</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-black">
                      <Icon name={billingPlan?.plan === "plus" ? "star" : "heart"} className="h-5 w-5 text-baby-pink" />
                      {billingPlan?.plan === "plus" ? "BabyBrain Plus" : "Free"}
                      {billingPlan?.status === "trialing" && (
                        <span className="rounded-full bg-[#FED7E4] px-2 py-0.5 text-xs font-bold text-baby-cta">Free trial</span>
                      )}
                      {billingPlan?.cancel_at_period_end && (
                        <span className="rounded-full bg-[#FEF4EB] px-2 py-0.5 text-xs font-bold text-[#FFD77A]">Cancels at period end</span>
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
                  <p className="mt-4 border-t border-[#F4EFF0] pt-3 text-xs font-semibold text-[#6D748A]">
                    <Icon name="check" className="mr-1 inline h-3.5 w-3.5 text-palette-green" />
                    Terms &amp; Conditions accepted on {sgDay(billingPlan.terms_accepted_at)}
                    {billingPlan.terms_version ? ` (v${billingPlan.terms_version})` : ""} ·{" "}
                    <a href="/terms" className="text-baby-pink underline">View terms</a>
                  </p>
                )}
              </div>

              <div className="space-y-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Name</p>
                  <p className="font-black">{profile?.full_name || "—"}</p>
                </div>
                <div className="border-t border-[#F4EFF0] pt-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Email</p>
                  <p className="font-black">{session?.user.email || "—"}</p>
                </div>
                <div className="flex flex-wrap gap-3 border-t border-[#F4EFF0] pt-4">
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
      <Footer />
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
      goTo("/?deleted=1");
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "We couldn't delete your account — please contact hello@babybrain.sg.");
    }
  }

  return (
    <div className="mt-4 rounded-[14px] border border-[#FED7E4] bg-white p-6 shadow-card">
      <h2 className="font-black text-[#FFC1D6]">Delete your account</h2>
      <p className="mt-1 text-sm font-semibold text-[#59658d]">
        This removes your profile, your children's details, preferences and saved activities.
        {isPlus ? " Your Plus subscription is cancelled at the same time, so you won't be charged again." : ""}
        {" "}It can't be undone.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-[11px] border border-[#FED7E4] px-5 py-2.5 text-sm font-extrabold text-[#FFC1D6] hover:bg-[#FFF5F8]"
        >
          Delete account
        </button>
      ) : (
        <div className="mt-4 rounded-[12px] bg-[#FFF5F8] p-4">
          {/* The input is `block` so it sits under the instruction rather than
              running on beside it, and lines up with the buttons below. */}
          <label htmlFor="delete-confirm" className="block text-sm font-black text-[#FFC1D6]">
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2 block h-11 w-full max-w-[220px] rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold"
            placeholder="DELETE"
          />
          {error && <p className="mt-3 text-sm font-bold text-[#FFC1D6]">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={confirm !== "DELETE" || busy}
              onClick={remove}
              className={`rounded-[11px] px-5 py-2.5 text-sm font-extrabold text-white ${
                confirm === "DELETE" && !busy ? "bg-[#FFC1D6] hover:brightness-105" : "cursor-not-allowed bg-[#FFC1D6]"
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
function PastActivitiesTab({
  items,
  onChanged,
  filterChips,
  groups,
}: {
  items: BookingItem[];
  onChanged: () => void;
  filterChips?: ReactNode;
  /** Set when "All children" is chosen and there's more than one child: the
   *  same three attendance sections, repeated under each child's name. */
  groups?: { key: string; name: string; items: BookingItem[] }[] | null;
}) {
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
      setError(cleanRpcErrorMessage(err));
      return;
    }
    setMarks((m) => ({ ...m, [b.id]: status }));
    onChanged();
  }

  // A completed booking counts as attended even if nobody ticked it.
  const statusOf = (b: BookingItem) => marks[b.id] ?? (b.status === "completed" ? "present" : null);

  function Row({ b }: { b: BookingItem }) {
    const state = statusOf(b);
    return (
      <div className="rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card">
        <div className="flex items-center gap-4">
          <img src={b.image} alt="" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover" />
          <div className="min-w-0 flex-1">
            <a href={b.slug && !b.removed ? `/activity?slug=${b.slug}` : "/explore"} className="block truncate font-black hover:text-baby-pink">{b.title}</a>
            {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
          </div>
          {state && (
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${state === "present" ? "bg-[#F1FBEF] text-palette-green" : "bg-[#FEF9EB] text-[#FFD77A]"}`}>
              {state === "present" ? "Attended" : "Not attended"}
            </span>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2 border-t border-[#FAF7F7] pt-2">
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "present")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "present" ? "border border-green-300 bg-[#F1FBEF] text-palette-green" : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"}`}
          >
            We went
          </button>
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "absent")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "absent" ? "border border-[#EBE3E5] bg-[#FAF7F7] text-[#5a6484]" : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"}`}
          >
            We missed it
          </button>
        </div>
      </div>
    );
  }

  /** The three attendance sections for one list of classes. */
  function Sections({ list }: { list: BookingItem[] }) {
    const attended = list.filter((b) => statusOf(b) === "present");
    const notAttended = list.filter((b) => statusOf(b) === "absent");
    const unmarked = list.filter((b) => statusOf(b) === null);
    return (
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
            ? <p className="rounded-[12px] bg-[#FFF5F8] p-4 text-sm font-semibold text-[#68718f]">No attended classes recorded yet.</p>
            : <div className="space-y-3">{attended.map((b) => <Row key={b.id} b={b} />)}</div>}
        </section>
        <section>
          <h2 className="mb-2 text-sm font-black text-[#46527d]">Not attended ({notAttended.length})</h2>
          {notAttended.length === 0
            ? <p className="rounded-[12px] bg-[#FFF5F8] p-4 text-sm font-semibold text-[#68718f]">Nothing missed — nice work.</p>
            : <div className="space-y-3">{notAttended.map((b) => <Row key={b.id} b={b} />)}</div>}
        </section>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-[26px] font-black">Past activities</h1>
      <p className="mb-4 text-sm font-semibold text-[#59658d]">Classes whose time has passed. Tell us whether you made it — your provider can mark this too.</p>
      {filterChips}
      {error && <p className="mt-3 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}

      {items.length === 0 ? (
        <EmptyPanel icon="check" copy="Nothing here yet — classes move across once their time has passed." cta="Browse activities" href="/explore" />
      ) : groups ? (
        <div className="mt-4 space-y-8">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
              <Sections list={g.items} />
            </section>
          ))}
        </div>
      ) : (
        <Sections list={items} />
      )}
    </div>
  );
}

function BookingList({ items, emptyCopy, onChanged, isPlus = true }: { items: BookingItem[]; emptyCopy: string; onChanged?: () => void; isPlus?: boolean }) {
  // 2.2: cancel / reschedule with vendor-configured policies. Unavailable
  // actions grey out and explain themselves in a pop-up.
  const [notice, setNotice] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<BookingItem | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reschedSessions, setReschedSessions] = useState<{ id: string; starts_at: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const hoursLabel = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);
  const upcoming = (b: BookingItem) =>
    b.startsAt != null && new Date(b.startsAt) > new Date() && ["pending", "confirmed", "waitlisted"].includes(b.status);
  const cutoffPassed = (b: BookingItem, hours: number) =>
    b.startsAt != null && new Date(b.startsAt).getTime() - hours * 36e5 < Date.now();

  const cancelBlockReason = (b: BookingItem) =>
    b.isEvent
      ? "This is a ticketed event — it can't be cancelled once booked. Contact the provider if you need help."
      : !b.allowCancel
      ? "The provider does not allow cancellations for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.cancelCutoffH)
        ? `The cancellation window for this class has closed — cancellations close ${hoursLabel(b.cancelCutoffH)} before the session.`
        : null;
  const reschedBlockReason = (b: BookingItem) =>
    b.isEvent
      ? "This is a ticketed event — it can't be rescheduled once booked. Contact the provider if you need help."
      : b.isCourse
      ? "This is a course — your enrolment covers every session in the run, so there's no single class to move. Contact the provider if you need help."
      : !b.allowReschedule
      ? "The provider does not allow rescheduling for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.resCutoffH)
        ? `The rescheduling window for this class has closed — rescheduling closes ${hoursLabel(b.resCutoffH)} before the session.`
        : null;

  async function doCancel(b: BookingItem) {
    // Tell them what comes back — the compensate_cancelled_booking trigger
    // (00080/00081) reinstates the credit, releases the make-up token, or
    // issues a fresh one for a cash booking.
    const back =
      b.paidWith === "credit"
        ? " Your class credit will be returned to your package."
        : b.paidWith === "token"
          ? " Your make-up token will be released so you can use it again."
          : b.paidWith === "cash"
            ? " You'll be issued a make-up token to use on another class."
            : "";
    if (!window.confirm(`Cancel your booking for ${b.title}?${back}`)) return;
    setBusyId(b.id);
    const { error } = await supabase.rpc("cancel_booking", { p_booking_id: b.id });
    setBusyId(null);
    if (error) setNotice(cleanRpcErrorMessage(error));
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
    if (error) setNotice(cleanRpcErrorMessage(error));
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
            <button
              type="button"
              onClick={() => setExporting(true)}
              className="flex items-center gap-1.5 rounded-[9px] border border-[#FED7E4] px-3 py-1.5 text-xs font-bold text-[#FFC1D6] hover:bg-[#FFF5F8]"
              title="Pick a date range, then save as PDF or add to your calendar"
            >
              <Icon name="calendar" className="h-3.5 w-3.5" /> Export schedule
            </button>
          ) : (
            <a
              href="/pricing"
              className="flex items-center gap-1.5 rounded-[9px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-1.5 text-xs font-bold text-[#6D7486] hover:border-baby-pink hover:text-[#FFC1D6]"
              title="Calendar sync and PDF export are Plus features"
            >
              <Icon name="lock" className="h-3.5 w-3.5" /> Calendar &amp; PDF export — Plus
            </a>
          )}
        </div>
      )}
      {exporting && (
        <ExportScheduleDialog items={exportable} onClose={() => setExporting(false)} />
      )}
      {items.map((b) => {
        const cancelWhy = cancelBlockReason(b);
        const reschedWhy = reschedBlockReason(b);
        return (
          <div key={b.id} className="rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card transition hover:border-baby-pink">
            {/* A removed activity's own detail page is gone (unpublished,
                slug renamed by unlinkWixActivities) — send those clicks to
                the activities list instead of a dead link. */}
            <a href={b.slug && !b.removed ? `/activity?slug=${b.slug}` : "/explore"} className="flex items-center gap-4">
              <img src={b.image} alt="" className="h-16 w-16 flex-shrink-0 rounded-[10px] object-cover" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-black">{b.title}</h3>
                {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
                {b.venue && <p className="truncate text-sm font-semibold text-[#59658d]">{b.venue}</p>}
              </div>
              {/* Adding a single class to your own calendar is free; only the
                  bulk date-range export + PDF above is a Plus feature. */}
              {b.startsAt && b.status !== "cancelled" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    downloadBookingIcs({ id: b.id, title: b.title, startsAt: b.startsAt!, endsAt: b.endsAt, venue: b.venue });
                  }}
                  className="hidden items-center gap-1 rounded-[9px] border border-[#FED7E4] px-3 py-1.5 text-xs font-bold text-[#FFC1D6] hover:bg-[#FFF5F8] sm:flex"
                  title="Add to calendar"
                >
                  <Icon name="calendar" className="h-3.5 w-3.5" /> Add to calendar
                </button>
              )}
              <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${bookingStatusStyle(b.status)}`}>{b.status}</span>
            </a>
            {upcoming(b) && (
              <div className="mt-2 flex justify-end gap-2 border-t border-[#FAF7F7] pt-2">
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => (reschedWhy ? setNotice(reschedWhy) : openReschedule(b))}
                  className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${
                    reschedWhy
                      ? "cursor-not-allowed border border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]"
                      : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"
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
                      ? "cursor-not-allowed border border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]"
                      : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"
                  }`}
                  title={cancelWhy ?? "Cancel this booking"}
                >
                  {busyId === b.id ? "Working…" : "Cancel booking"}
                </button>
              </div>
            )}
            {b.status === "cancelled" && b.compensation && (
              <div className="mt-2 flex items-start gap-1.5 border-t border-[#FAF7F7] pt-2 text-xs font-semibold text-[#59658d]">
                <Icon name="gift" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FFC1D6]" />
                <span>
                  {b.compensation === "token"
                    ? "Replaced with a make-up token you can use on another class — it doesn't expire."
                    : "1 class credit has been returned to your package."}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* Explanatory pop-up for unavailable actions / errors */}
      {notice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setNotice(null)}>
          <div className="w-full max-w-sm rounded-[16px] bg-white p-6 text-center shadow-card" onClick={(e) => e.stopPropagation()}>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-palette-yellow"><Icon name="bell" className="h-6 w-6" /></span>
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
                  className="flex w-full items-center justify-between rounded-[10px] border border-[#EBE3E5] px-4 py-2.5 text-left text-sm font-bold text-[#3f4b78] hover:border-baby-pink hover:bg-[#FFF5F8]"
                >
                  {sgDateTime(s.starts_at)}
                  <Icon name="calendar" className="h-4 w-4 text-[#FFC1D6]" />
                </button>
              ))}
              {reschedSessions.length === 0 && <p className="py-4 text-center text-sm font-semibold text-[#6D748D]">No other upcoming sessions for this class.</p>}
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
    <div className="mt-4 rounded-[14px] border border-dashed border-[#DCD2D5] bg-white p-10 text-center">
      <Icon name={icon} className="mx-auto h-8 w-8 text-[#C9BAC2]" />
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
      ["Does BabyBrain cost anything to use?", "BabyBrain is free to browse and book — you just pay the price of the activity. Your family profile, reviews and personalised suggestions are all free too. If you'd like extras like pass tracking, saved providers, calendar export and messaging, our Plus plan is SGD 9/month or SGD 99/year on top of activity prices."],
      ["How do I pay?", "PayNow, Apple Pay, Google Pay or card — whatever's easiest for you."],
      ["Is my payment secure?", "Payments are handled by Stripe, a global provider trusted by millions of businesses. Your card details are never stored by BabyBrain."],
    ],
  },
  {
    group: "Managing your account",
    items: [
      ["Can I manage passes I've already bought?", "Yes — with Plus, your packages and make-up tokens across every provider live in one place on your profile, so you never lose track of what you've paid for. Just click through to use them. On the free plan, these are sent to you by email to use from there."],
      ["How do make-up classes work?", "Make-up tokens follow each provider's own rules. With Plus, they're gathered on your profile and you click through to book one. On the free plan, they come to you by email and you book from the link there."],
      ["What if I have more than one child?", "Add as many children as you like on the free plan — your family profile holds all of them, and you'll see suggestions based on each child's age and your preferences, with every booking in one place."],
      ["Why should I upgrade to Plus?", "Free covers everything you need to browse & book, keep your family profile and get suggestions. Plus (SGD 9/month or SGD 99/year) adds twice-weekly curated activity emails, all your packages and make-up tokens for every vendor in one place, saved favourite providers, exporting and sharing your booked activities in calendar view, messaging integrated providers and other parents booked on the same activity, and priority support."],
      ["Can I cancel my Plus subscription anytime?", "Yes. On the monthly plan you can cancel anytime with 14 days' notice. The annual plan runs for the full year and isn't refundable if you cancel partway through."],
      ["Why can I see messages from parents and the provider but not respond?", "Seeing messages on your booked classes comes with every account. Sending them is a Plus feature — and the provider needs to offer messaging too. Upgrade to Plus, and where the provider has it enabled, you'll be able to message them and other parents in the class."],
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

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold focus:border-baby-pink focus:outline-none";

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
      <div className="rounded-[18px] border border-[#EBE3E5] bg-white p-8 text-center shadow-card">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#F1FBEF] text-[#A8E59A]"><Icon name="check" className="h-8 w-8" /></span>
        <h2 className="mt-4 text-2xl font-black">Message sent</h2>
        <p className="mt-2 font-semibold text-[#59658d]">Thanks {name.split(" ")[0]} — we endeavour to reply within 3 days.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[18px] border border-[#EBE3E5] bg-white p-6 shadow-card sm:p-8">
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
        <label className="mb-1 block text-sm font-black">Subject <span className="font-semibold text-[#6D748D]">(optional)</span></label>
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's this about?" />
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-sm font-black">Message</label>
        <textarea
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help?"
          className="w-full rounded-[10px] border border-[#FED7E4] px-3 py-2.5 text-sm font-semibold focus:border-baby-pink focus:outline-none"
        />
      </div>
      {error && <p role="alert" className="mt-3 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
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
    if (!session) { goTo("/login"); return; }
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
            {/* Blue, not pink. The eyebrow is 18px bold — just under the
                large-text threshold — so it takes the readable blue ink;
                the heart beside it is decorative and can run brighter. */}
            <p className="mb-5 flex items-center gap-2 text-lg font-black text-palette-blue">We're here to help! <Icon name="heart" className="h-5 w-5 fill-current text-palette-blue" /></p>
            <h1 className="text-[40px] font-black leading-tight">How can our team support you today?</h1>
            <p className="mt-5 text-lg font-semibold leading-8 text-[#68718f]">Have a question, feedback, or need assistance? Our team is happy to help.</p>
          </div>
          {/* The reply-time note used to be absolutely positioned over the
              mascot. The logo is far wider than that illustration, so the note
              covered most of it — they sit side by side now instead. */}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-end">
            <div className="rounded-[16px] bg-white p-4 text-sm font-semibold leading-6 shadow-soft sm:max-w-[190px] sm:shrink">We endeavor to respond within 3 days. If more urgent, please call us. <Icon name="heart" className="inline h-4 w-4 fill-current text-palette-blue" /></div>
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="h-[200px] shrink-0 object-contain" />
          </div>
        </section>

        <section className="mt-8">
          <SectionTitle emoji="👇🏻">Get in touch</SectionTitle>
          <div className="grid gap-5 md:grid-cols-4">
            {[
              // "Chat on WhatsApp" needed 138px in the 137px a quarter-width
              // card leaves, so it wrapped and made this CTA taller than the
              // other three. The shorter label also matches the pattern of the
              // rest of the row, where the button repeats the card title.
              { icon: "whatsapp", title: "WhatsApp us", tag: "Recommended", copy: "Message us on WhatsApp for the quickest response.", label: "WhatsApp us", variant: "pink", href: `https://wa.me/${phoneDigits(SUPPORT_PHONE)}` },
              { icon: "pen", title: "Message us", tag: "", copy: "Plus subscribers can chat with our team in real time.", label: "Message us", variant: "outline", onClick: openSupport },
              { icon: "mail", title: "Email us", tag: "", copy: "For more complex enquiries, send us an e-mail and we'll get back to you.", label: "Email us", variant: "outline", href: `mailto:${SUPPORT_EMAIL}` },
              { icon: "phone", title: "Call us", tag: "", copy: "Speak with our friendly support team if urgent.", label: "Call us", variant: "outline", href: `tel:+${phoneDigits(SUPPORT_PHONE)}` },
            ].map((c) => (
              // Column layout with the CTA pushed down by `mt-auto`, so the
              // four buttons line up across the row however many lines each
              // card's copy runs to (and whether or not it has a tag).
              <article key={c.title} className="flex flex-col rounded-[16px] border border-[#FED7E4] bg-white/70 p-5 text-center shadow-card">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#FEEBF2] to-[#FED7E4] text-baby-cta"><Icon name={c.icon} className="h-9 w-9" /></div>
                <h3 className="text-xl font-black">{c.title} {c.tag && <span className="rounded-full bg-[#FED7E4] px-2 py-1 text-[10px] text-baby-cta">{c.tag}</span>}</h3>
                <p className="my-5 text-sm font-semibold leading-6 text-[#28345f]">{c.copy}</p>
                <Button variant={c.variant === "pink" ? "pink" : "outline"} className="mt-auto w-full" href={c.href} onClick={c.onClick}>{c.label}</Button>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="mt-9 scroll-mt-24">
          <SectionTitle emoji="ℹ️">Frequently asked questions</SectionTitle>
          <div className="space-y-5">
            {FAQ_GROUPS.map(({ group, items }) => (
              <div key={group}>
                <h3 className="mb-2 px-1 text-lg font-black text-baby-lilac">{group}</h3>
                <div className="overflow-hidden rounded-[16px] border border-[#EBE3E5] bg-white">
                  {items.map(([question, answer]) => (
                    <details key={question} className="border-b border-[#F4EFF0] px-6 py-4 last:border-b-0">
                      <summary className="cursor-pointer list-none font-bold">Q&nbsp;&nbsp; {question} <span className="float-right">⌄</span></summary>
                      <p className="mt-3 text-sm font-semibold leading-6 text-[#59658b]">{answer}</p>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="contact-form" className="mt-9 scroll-mt-24">
          <ContactForm />
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
      body: "You may review any class listed on BabyBrain, whether or not you booked it through us. Reviews must be honest, first-hand and lawful. We may moderate or remove content that is abusive, misleading, or violates these Terms.",
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
        <p className="mt-2 text-sm font-bold text-[#6D748A]">Last updated: July 2026</p>
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
      goTo("/login");
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

  /* These two lists are the tier spec, so they have to describe what the app
   * actually gates. Previously Free advertised "See messages from parents and
   * class providers on booked classes" while ChatButton is gated on isPlus —
   * i.e. it promised Free users something they could not do. Messaging is
   * stated as Plus here, matching the code.
   *
   * The saved family profile and preference-based suggestions are Free: the
   * children tab and the recommendations that feed Matches are ungated. What
   * is Plus is everything behind a plusOnly tab or an isPlus check —
   * favourites, packages, make-up tokens, calendar export and messaging. */
  const freeItems = [
    "Browse & book activities",
    "Leave reviews",
    "Saved family profile",
    "Suggestions provided based on your preferences",
  ];
  const plusItems = [
    "Everything in Free",
    "Twice weekly e-mails with available activities curated for your little ones",
    "Packages & make-up tokens for all vendors stored in one place",
    "Save favourite providers",
    "Export & share booked activities in calendar view",
    "For integrated activity providers, message them & other parents booked on the same activity",
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
            Discover, book and let your little ones enjoy great activities.
          </p>
          <div className="mx-auto mt-5 grid h-11 max-w-[360px] grid-cols-2 rounded-full border border-[#DCD2D5] bg-white p-1 font-black">
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
              {/* The mock only shows the Monthly-active state. Once Annual is
                  selected the pill fills pastel blue, so the nudge takes the
                  same white label colour as the toggle text. */}
              Annual <span className={billing === "annual" ? "text-white" : "text-baby-pink"}>(1 month free)</span>
            </button>
          </div>
        </section>

        {error && (
          <p className="mx-auto mt-5 max-w-[560px] rounded-[10px] bg-[#FEF4EB] px-4 py-3 text-center text-sm font-bold text-[#FFD77A]">
            {error}
          </p>
        )}

        <section className="mt-7 grid gap-5 md:grid-cols-2">
          {/* Free */}
          <article className="relative rounded-[18px] border border-[#EBE3E5] bg-white p-6 shadow-card">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-palette-blueSoft text-palette-blueInk">
              <Icon name="heart" className="h-8 w-8 text-white" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Free</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">0</span>
            </p>
            <div className="my-5 border-t border-[#F4EFF0]" />
            <div className="space-y-3">
              {freeItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-palette-blue text-palette-blueInk">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
          </article>

          {/* Plus */}
          <article className="relative rounded-[18px] border border-palette-blue bg-white p-6 shadow-card ring-1 ring-palette-blue/40">
            <span className="absolute left-1/2 top-[-15px] -translate-x-1/2 rounded-full bg-palette-blue px-8 py-2 text-sm font-black text-white">
              MOST POPULAR
            </span>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#F4F0FA] text-baby-lilac">
              <Icon name="star" className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Plus</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">{plusPrice}</span>
              <span className="font-bold text-[#68718f]"> {plusPeriod}</span>
            </p>
            <p className="mt-1 text-center text-sm font-black text-baby-pink">Get your first month free!</p>
            <div className="my-5 border-t border-[#F4EFF0]" />
            <div className="space-y-3">
              {plusItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-palette-blue text-palette-blueInk">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
            <Button
              type="button"
              onClick={upgrade}
              disabled={busy}
              variant="blue"
              className="mt-5 w-full"
            >
              {busy
                ? "Please wait…"
                : plan === "plus"
                  ? "Manage subscription"
                  : "Upgrade to Plus"}
            </Button>
            <p className="mt-3 text-center text-xs font-semibold text-[#6D748A]">
              Auto-renews {billing === "monthly" ? "monthly" : "yearly"} after the free month. Cancel any time from your profile.
              {" "}By subscribing you agree to our{" "}
              <a href="/terms" className="text-palette-blue underline">Terms &amp; Conditions</a>.
            </p>
          </article>
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
      goTo("/login");
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
        selected ? "border-[#A7D8F8] bg-[#EDF7FD]" : "border-[#DCD2D5] bg-white hover:border-[#A7D8F8]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-black">{title}</span>
          {badge && <span className="rounded-full bg-[#FEF2D7] px-2 py-0.5 text-[10px] font-bold text-[#FFD77A]">{badge}</span>}
        </div>
        <span className="mt-0.5 block text-sm font-semibold text-[#59658d]">{price}</span>
      </div>
      {action && (
        <Button
          type="button"
          variant="pink"
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
  const { activity, sessions, courseSpan, loading } = useActivityDetail(getParam("slug"));
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
    activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null;
  };
  const [purchases, setPurchases] = useState<CreditPurchase[]>([]);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  // Step 4: "single" | "credit" | "pack:<id>"
  const [payWith, setPayWith] = useState<string>("single");
  // The provider's own consents / waivers / disclosures for this class, and
  // which of them the parent has ticked. QA: the vendor's "require medical
  // disclosure" switch changed nothing on the parent's side, and each vendor
  // wants their own bespoke paperwork accepted before a booking stands.
  const [policies, setPolicies] = useState<ProviderPolicy[]>([]);
  const [acceptedPolicies, setAcceptedPolicies] = useState<string[]>([]);
  const [medicalNote, setMedicalNote] = useState("");
  /* The vendor's bespoke information request (migration 00074) — e.g. an
     address when the class is hosted at the family's own condo. */
  const [infoResponse, setInfoResponse] = useState("");
  /* Sessions this parent already holds a live booking on, as
     `${session_id}:${child_id}`. Booking the same child onto the same class
     twice is allowed — a parent may well want two slots for a friend — so this
     only drives a confirmation step, never a block. */
  const [existingBookings, setExistingBookings] = useState<Set<string>>(new Set());
  const [dupPrompt, setDupPrompt] = useState<null | { childName: string; proceed: () => void }>(null);

  // A Wix Event–backed activity (wix_service_type='EVENT', see
  // 00070_wix_events_as_activities.sql) reuses this whole page — the only
  // difference is what's picked (a ticket type, not a date/time — there's
  // only ever one session, the event's own occurrence) and which endpoint
  // gets called to actually purchase it.
  const isEvent = activity?.wix_service_type === "EVENT";
  // A Wix COURSE is enrolled as one whole programme, not per session — the
  // parent still sees every occurrence in the picker, but booking any of
  // them enrols in the entire run (handled server-side in resolveWixSlot).
  // These give the run's span for the added "Runs …" line and the booking
  // confirmation / My Bookings date range.
  const isCourse = activity?.wix_service_type === "COURSE";
  type EventTicketType = { id: string; name: string; price_cents: number; currency: string; is_free: boolean; limit_per_checkout: number | null; hidden: boolean; fee_type: string | null; fee_rate_percent: number | null };
  const [ticketTypes, setTicketTypes] = useState<EventTicketType[]>([]);
  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);

  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("provider_policies")
      .select("id, title, body, document_url, required, activity_id")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .order("sort_order")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as ProviderPolicy[];
        // A policy is either provider-wide (no activity) or pinned to this class.
        setPolicies(rows.filter((p) => !p.activity_id || p.activity_id === activity.id));
      });
  }, [activity?.provider_id, activity?.id]);

  // Packs this provider sells that apply to this class (or to all of theirs).
  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("packages")
      .select("id, name, credits, price_cents, activity_ids")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null }>;
        setPacks(rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id)));
      });
  }, [activity?.provider_id, activity?.id]);

  // What this parent has already booked on this activity's sessions, so the
  // form can warn before putting the same child on the same class twice.
  useEffect(() => {
    if (!auth || !activity?.id) { setExistingBookings(new Set()); return; }
    supabase
      .from("bookings")
      .select("session_id, child_id, status, activity_sessions!inner(activity_id)")
      .eq("activity_sessions.activity_id", activity.id)
      .in("status", ["confirmed", "pending"])
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ session_id: string; child_id: string | null }>;
        setExistingBookings(new Set(rows.map((r) => `${r.session_id}:${r.child_id ?? ""}`)));
      });
  }, [auth, activity?.id]);

  useEffect(() => {
    if (!auth || !activity?.provider_id) return;
    supabase
      .from("package_purchases")
      .select("id, credits_remaining, expires_at, packages(activity_ids, allowed_weekday, allowed_start_time)")
      .eq("provider_id", activity.provider_id)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string; credits_remaining: number; expires_at: string | null;
          packages: { activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null } | null;
        }>;
        setPurchases(
          rows
            .filter((r) => !r.expires_at || new Date(r.expires_at) > new Date())
            .map((r) => ({
              id: r.id,
              remaining: r.credits_remaining,
              expires_at: r.expires_at,
              activity_ids: r.packages?.activity_ids ?? null,
              allowed_weekday: r.packages?.allowed_weekday ?? null,
              allowed_start_time: r.packages?.allowed_start_time ?? null,
            }))
        );
      });
  }, [auth, activity?.provider_id]);

  // 1.2: a credit is only offered when the package's restrictions match the
  // chosen class and session slot (e.g. "Monday 4:00 pm only").
  function creditMatches(p: CreditPurchase, sess: ActivitySession | null) {
    if (p.activity_ids && p.activity_ids.length > 0 && !p.activity_ids.includes(activity?.id ?? "")) return false;
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

  // Span of a course run. Wix's own schedule bounds (courseSpan) when we
  // have them — `sessions` is future-only, so deriving from it understates
  // the run for a course viewed mid-way — else first/last visible session.
  const courseStart =
    isCourse
      ? courseSpan?.start ??
        (sessions.length ? sessions.reduce((m, s) => (s.starts_at < m ? s.starts_at : m), sessions[0].starts_at) : null)
      : null;
  const courseEnd =
    isCourse
      ? courseSpan?.end ??
        (sessions.length
          ? sessions.reduce((m, s) => {
              const e = s.ends_at ?? s.starts_at;
              return e > m ? e : m;
            }, sessions[0].ends_at ?? sessions[0].starts_at)
          : null)
      : null;
  const courseRange = courseStart && courseEnd ? sgDayRange(courseStart, courseEnd) : null;
  // The course's distinct weekly strands (Wed vs Thu, each its own time) and
  // the course-wide spots-left figure — a course is booked as one unit, not
  // a chosen date/time.
  const strands = isCourse ? courseStrands(sessions) : [];
  const courseSpots = isCourse ? sessions[0]?.capacity ?? null : null;

  useEffect(() => {
    if (dates.length && !dateKey) setDateKey(dates[0]);
  }, [dates, dateKey]);

  // Events skip the date/time picker entirely — there's exactly one session
  // (materialized by lib/wix/events-sync.ts), so it's auto-selected the
  // moment it loads rather than making the parent click through a picker
  // with only one option in it.
  // Events and courses aren't date/time-picked — an event has one occurrence,
  // a course is enrolled as a whole — so auto-select the (any) underlying
  // session so the booking can proceed straight to child/payment.
  useEffect(() => {
    if ((isEvent || isCourse) && sessions.length > 0 && !sessionId) setSessionId(sessions[0].id);
  }, [isEvent, isCourse, sessions, sessionId]);

  useEffect(() => {
    if (!isEvent || !activity?.wix_event_id) { setTicketTypes([]); return; }
    supabase
      .from("event_ticket_types")
      .select("id, name, price_cents, currency, is_free, limit_per_checkout, hidden, fee_type, fee_rate_percent")
      .eq("event_id", activity.wix_event_id)
      .eq("hidden", false)
      .order("price_cents")
      .then(({ data }) => setTicketTypes((data ?? []) as EventTicketType[]));
  }, [isEvent, activity?.wix_event_id]);

  useEffect(() => {
    if (ticketTypes.length > 0 && !ticketTypeId) setTicketTypeId(ticketTypes[0].id);
  }, [ticketTypes, ticketTypeId]);

  // Default to an available credit — it's the cheapest option for the parent.
  // Never for a Wix Event: it's ticketed through Wix, the "Select package"
  // step isn't even shown for one, and routing its checkout through the
  // package-credit path hits an RPC that can't take an event occurrence.
  useEffect(() => {
    // Events and courses are a single whole purchase — a multi-class pack
    // (one credit = one session) doesn't map onto them, so the "Select
    // package" step is hidden and payment stays "single".
    if (isEvent || isCourse) { if (payWith !== "single") setPayWith("single"); return; }
    if (packageCredit && payWith === "single") setPayWith("credit");
    else if (!packageCredit && payWith === "credit") setPayWith("single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageCredit?.id, isEvent, isCourse]);

  const times = dateKey ? byDate[dateKey] ?? [] : [];
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const bookChildId = childId ?? kids[0]?.id ?? null;
  const bookChild = kids.find((k) => k.id === bookChildId) ?? null;
  // Flag (not block outright) when the selected child falls outside the
  // class's stated age range — parents sometimes book ahead for a sibling or
  // a class that's a deliberate stretch, so this is a confirm-to-override
  // warning rather than a hard wall.
  const childAgeMonths = bookChild ? ageInMonths(bookChild.date_of_birth) : null;
  const childAgeMismatch =
    !!activity &&
    childAgeMonths != null &&
    (childAgeMonths < activity.age_min_months || childAgeMonths > activity.age_max_months);
  const selectedTicketType = isEvent ? ticketTypes.find((t) => t.id === ticketTypeId) ?? null : null;
  // Inclusive of Wix's own service fee where it applies (fee_rate_percent is
  // discovered once per ticket type by lib/wix/events-sync.ts and cached —
  // see ticketPriceWithFeeCents there) so this matches the real charge
  // instead of understating it; the actual amount is still always
  // recomputed server-side from a live Wix reservation
  // (computeWixCheckoutTotal in lib/wix/client.ts) at checkout time.
  const ticketPriceCents = (t: EventTicketType) =>
    t.fee_type === "FEE_ADDED_AT_CHECKOUT" && t.fee_rate_percent != null
      // Byte-for-byte the server's addTicketFeeCents (lib/wix/client.ts) — the
      // `price * (1 + rate/100)` form drifts by a floating-point ULP
      // (3500 * 1.025 → 3587.4999999999995, rounds to 3587) and undercut the
      // real Stripe charge by a cent.
      ? Math.round(t.price_cents + (t.price_cents * t.fee_rate_percent) / 100)
      : t.price_cents;
  /* A session can carry its own price, so the same class at two venues can
     cost different amounts (migration 00074). Session first, activity as the
     fallback — the same resolution the booking trigger and the checkout route
     use, so all three agree on what this booking costs. */
  const sessionPrice = selected?.price != null ? Number(selected.price) : null;

  /* The chosen session's own venue, when it differs from the activity's
     (migration 00074). Resolved lazily — most activities run at one venue, so
     there is nothing to look up. */
  const [sessionVenues, setSessionVenues] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = Array.from(new Set(sessions.map((x) => x.location_id).filter((v): v is string => !!v)));
    if (ids.length === 0) return;
    let cancelled = false;
    supabase
      .from("provider_locations")
      .select("id, name, address")
      .in("id", ids)
      .then(({ data }) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const l of (data ?? []) as Array<{ id: string; name: string; address: string | null }>) {
          next[l.id] = [l.name, l.address].filter(Boolean).join(", ");
        }
        setSessionVenues(next);
      });
    return () => { cancelled = true; };
  }, [sessions]);
  const sessionVenueAddress = selected?.location_id ? sessionVenues[selected.location_id] ?? null : null;
  /* Where this booking actually happens: the chosen session's own venue once
     it has one (migration 00074), the activity's address otherwise. Drives
     the on-page displays as well as the /booked redirect below. */
  const displayVenue = sessionVenueAddress ?? activity?.address ?? null;
  const price = isEvent
    ? selectedTicketType != null ? ticketPriceCents(selectedTicketType) / 100 : null
    : sessionPrice != null ? sessionPrice
    : activity?.price != null ? Number(activity.price) : null;
  const total = price != null ? price * count : null;
  /* Sessions can carry their own venue and price (migration 00074), so the
     venue/price on this page can shift as the parent picks a different date
     or time. Flag it up front, but only for classes that actually have that
     variation — no point warning about a class that always runs at one
     venue for one price. */
  const slotDetailsVary =
    !isEvent &&
    sessions.length > 1 &&
    (new Set(sessions.map((s) => s.location_id ?? "_")).size > 1 ||
      new Set(sessions.map((s) => (s.price == null ? "_" : String(s.price)))).size > 1);
  const ticketQuantityCap = selectedTicketType?.limit_per_checkout && selectedTicketType.limit_per_checkout > 0
    ? Math.min(selectedTicketType.limit_per_checkout, 20)
    : 6;

  async function pay() {
    setErr(null);
    if (!auth) {
      goTo("/login");
      return;
    }
    if (!sessionId) {
      setErr(isEvent || isCourse ? "This isn't ready to book yet — try again shortly." : "Please choose a date and time first.");
      return;
    }
    if (isEvent && !ticketTypeId) {
      setErr("Please choose a ticket type first.");
      return;
    }
    // A ticketed Wix event has no free/comp path — the isEvent branch below
    // would ignore the token and send the parent to Stripe at full price
    // (which reads as a charge under a "this class is on the house" banner).
    // Block it with a clear message until event redemption actually exists.
    if (isEvent && redeemToken) {
      setErr("Make-up tokens can't be used for ticketed events yet. Contact the provider to arrange your place.");
      return;
    }
    setBusy(true);
    let status: string | null = null;
    if (isEvent) {
      // Wix Event ticket: a real reservation is made against Wix's own
      // inventory server-side (the authoritative availability check — there's
      // no local capacity to double-check against, see
      // app/api/wix/events/checkout). Free tickets confirm synchronously;
      // paid ones hand off to Stripe same as every other paid path here, and
      // the real Wix order isn't created until that payment is confirmed
      // (lib/wix/finalize-event-checkout.ts).
      const eventBody = {
        eventId: activity?.wix_event_id,
        ticketTypeId,
        quantity: count,
        childId: bookChildId,
        // The event form reuses the class booking form's "Provider terms"
        // section — the disclosure, the ticked waivers and the answer to the
        // vendor's info request all need to survive the trip to the roster.
        ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
        ...(acceptedPolicies.length ? { policiesAccepted: acceptedPolicies } : {}),
        ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
      };
      if (selectedTicketType?.is_free) {
        try {
          const data = await apiPost<{ status: string }>("/api/wix/events/rsvp", eventBody);
          status = data.status;
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not reserve this ticket");
          return;
        }
        setBusy(false);
      } else {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/wix/events/checkout", eventBody);
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
        setBusy(false);
        return;
      }
    } else if (redeemToken) {
      // Redeeming a make-up token: books the session and consumes the token atomically.
      if (sessionId.startsWith("wix:")) {
        // Wix-linked slot: no local activity_sessions row for the RPC to book
        // against, and the slot has to be reserved in Wix first — same split
        // as the package-credit path (/api/wix/bookings/redeem-package).
        try {
          const data = await apiPost<{ status: string }>("/api/wix/bookings/redeem-token", {
            activityId: activity?.id,
            wixSlotId: sessionId,
            tokenId: redeemToken,
            policiesAccepted: acceptedPolicies,
            ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
            ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
          });
          status = data.status;
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not redeem this make-up token");
          return;
        }
        setBusy(false);
      } else {
        const { data, error } = await supabase.rpc("redeem_make_up_token", {
          p_token_id: redeemToken,
          p_session_id: sessionId,
          p_policies: acceptedPolicies,
          ...(medicalNote.trim() ? { p_medical: medicalNote.trim() } : {}),
          ...(infoResponse.trim() ? { p_info: infoResponse.trim() } : {}),
        });
        setBusy(false);
        if (error) {
          setErr(cleanRpcErrorMessage(error));
          return;
        }
        status = (data as string | null) ?? "confirmed";
      }
    } else if (sessionId.startsWith("wix:")) {
      // Wix-linked activity: the slot lives in Wix, not activity_sessions —
      // creating the booking there (and materializing the local session) is
      // handled server-side. Paid → hand off to Stripe Checkout same as a
      // native paid class; the real Wix reservation isn't made until the
      // webhook confirms payment (see /api/wix/bookings/checkout). Free
      // stays the direct, immediate booking it always was.
      const wixBody = {
        activityId: activity?.id,
        wixSlotId: sessionId,
        childId: bookChildId,
        policiesAccepted: acceptedPolicies,
        count,
        ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
        // Required by the activity when info_request_enabled, and now
        // enforced server-side on both Wix endpoints — it used to be
        // collected on this page and then never sent, so the vendor's roster
        // showed the answer blank for every Wix-linked class.
        ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
      };
      if (activity?.price != null && Number(activity.price) > 0) {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/wix/bookings/checkout", wixBody);
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
        setBusy(false);
        return;
      }
      try {
        const data = await apiPost<{ id: string; status: string }>("/api/wix/bookings", wixBody);
        status = data.status;
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "Could not create the booking");
        return;
      }
      setBusy(false);
    } else {
      const { data, error } = await supabase
        .from("bookings")
        .insert({
          user_id: auth.user.id,
          session_id: sessionId,
          child_id: bookChildId,
          // Enforced again by the `booking_policy_gate` trigger, so a booking
          // can never exist without the provider's required consents.
          policies_accepted: acceptedPolicies,
          ...(medicalNote.trim() ? { medical_disclosure: medicalNote.trim() } : {}),
          // Whatever the vendor asked for on this activity. The insert trigger
          // rejects a blank one when the request is switched on, so this is
          // required rather than best-effort.
          ...(infoResponse.trim() ? { info_response: infoResponse.trim() } : {}),
        })
        .select("id, status")
        .single();
      if (error) {
        setBusy(false);
        setErr(error.message);
        return;
      }
      // Paid class → hand off to Stripe Checkout; the webhook confirms on payment.
      // Free class (no price) stays a direct confirmed/pending booking.
      if (price != null && price > 0 && data?.status !== "waitlisted") {
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
      when: isCourse && courseRange ? courseRange : selected ? sgDateTime(selected.starts_at) : "",
      status: status ?? "pending",
      start: (isCourse ? courseStart : selected?.starts_at) ?? "",
      end: (isCourse ? courseEnd : selected?.ends_at) ?? "",
      // A session can sit at a different venue from its activity (00074), so
      // the address the parent is told to go to is the session's when it has one.
      venue: displayVenue ?? "",
    });
    goTo(`/booked?${q.toString()}`);
  }

  async function payWithPackage() {
    if (!auth) { goTo("/login"); return; }
    if (!sessionId) { setErr("Please choose a date and time first."); return; }
    if (!packageCredit) return;
    // 1 child = 1 credit = 1 spot — count is how many are attending.
    if (packageCredit.remaining < count) {
      setErr(`This pack only has ${packageCredit.remaining} credit${packageCredit.remaining === 1 ? "" : "s"} left — not enough for ${count} children.`);
      return;
    }
    setBusy(true);
    let status: string;
    if (sessionId.startsWith("wix:")) {
      // Wix-linked activity: the slot lives in Wix, not activity_sessions —
      // redeem_package_credit expects a real session id, so this goes
      // through a route that creates the booking in Wix first (same as the
      // free-booking path) and only then redeems the credit.
      try {
        const data = await apiPost<{ status: string }>("/api/wix/bookings/redeem-package", {
          activityId: activity?.id,
          wixSlotId: sessionId,
          packagePurchaseId: packageCredit.id,
          childId: bookChildId,
          policiesAccepted: acceptedPolicies,
          count,
          ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
          ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
        });
        status = data.status;
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "Could not redeem this credit");
        return;
      }
    } else {
      const { data, error } = await supabase.rpc("redeem_package_credit", {
        p_purchase_id: packageCredit.id,
        p_session_id: sessionId,
        // Was hard-coded to null server-side, which is why a class booked with
        // a pack credit showed up as "Guest" on the vendor's roster.
        p_child_id: bookChildId,
        p_policies: acceptedPolicies,
        p_quantity: count,
        ...(medicalNote.trim() ? { p_medical: medicalNote.trim() } : {}),
        ...(infoResponse.trim() ? { p_info: infoResponse.trim() } : {}),
      });
      if (error) { setBusy(false); setErr(cleanRpcErrorMessage(error)); return; }
      status = (data as string | null) ?? "confirmed";
    }
    setBusy(false);
    const q = new URLSearchParams({
      title: activity?.title ?? "your class",
      slug: activity?.slug ?? "",
      when: isCourse && courseRange ? courseRange : selected ? sgDateTime(selected.starts_at) : "",
      status,
      start: (isCourse ? courseStart : selected?.starts_at) ?? "",
      end: (isCourse ? courseEnd : selected?.ends_at) ?? "",
      // A session can sit at a different venue from its activity (00074), so
      // the address the parent is told to go to is the session's when it has one.
      venue: displayVenue ?? "",
    });
    goTo(`/booked?${q.toString()}`);
  }

  /** Buy a multi-class pack, then come back here to book with a credit. */
  async function buyPack(packageId: string) {
    if (!auth) { goTo("/login"); return; }
    // Buying a pack books the selected class too, so the same paperwork applies.
    const consent = consentProblem();
    if (consent) { setErr(consent); return; }
    if (childAgeMismatch) {
      setErr(`${bookChild!.name} is ${formatChildAge(bookChild!.date_of_birth)}, outside this class's ${ageText} age range. Pick a different child, or a class suited to their age.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Passing the selected session/child means the webhook books this
      // class with the pack's first credit, not just grants it — QA: "buy a
      // package, that class should also then be booked".
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/package", {
        package_id: packageId,
        ...(sessionId ? { activity_session_id: sessionId } : {}),
        ...(bookChildId ? { child_id: bookChildId } : {}),
      });
      if (url) window.location.href = url;
      else setErr("Could not start checkout — please try again.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
    } finally {
      setBusy(false);
    }
  }

  const requiredPolicies = policies.filter((p) => p.required);
  const missingPolicies = requiredPolicies.filter((p) => !acceptedPolicies.includes(p.id));
  const needsMedical = Boolean(activity?.requires_medical_disclosure);

  /** Everything the provider insists on before this booking can go through. */
  function consentProblem(): string | null {
    if (missingPolicies.length) {
      return `Please read and accept ${missingPolicies.map((p) => `"${p.title}"`).join(", ")} before booking.`;
    }
    if (needsMedical && !medicalNote.trim()) {
      return "This provider asks for a medical and health disclosure before the class — add it above (write \u201cnone\u201d if there is nothing to declare).";
    }
    if (activity?.info_request_enabled && !infoResponse.trim()) {
      return activity.info_request_prompt?.trim()
        ? `This provider needs an answer to: \u201c${activity.info_request_prompt.trim()}\u201d`
        : "This provider asks for some extra information before the class — add it above.";
    }
    return null;
  }

  /** True when this child already holds a live booking on the chosen session. */
  const alreadyBooked =
    !!sessionId && existingBookings.has(`${sessionId}:${bookChildId ?? ""}`);

  /** Route the CTA to whichever option was picked in step 4. */
  function checkout() {
    setErr(null);
    const consent = consentProblem();
    if (consent) {
      setErr(consent);
      return;
    }
    if (childAgeMismatch) {
      setErr(`${bookChild!.name} is ${formatChildAge(bookChild!.date_of_birth)}, outside this class's ${ageText} age range. Pick a different child, or a class suited to their age.`);
      return;
    }

    const go = () => {
      if (redeemToken) return pay();
      // A Wix Event is always bought as a ticket through Wix — package
      // credits and pack purchases don't apply, and redeem_package_credit
      // 400s on an event occurrence. Guard here too in case payWith is stale.
      if (isEvent) return pay();
      if (payWith === "credit") return payWithPackage();
      if (payWith.startsWith("pack:")) return buyPack(payWith.slice(5));
      return pay();
    };

    /* Booking the same child on the same session twice is deliberately still
       allowed — a parent may want a second slot for a friend — so this asks
       rather than blocks. QA 18/08. */
    if (alreadyBooked) {
      setDupPrompt({
        childName: bookChild?.name ?? "This child",
        proceed: () => { setDupPrompt(null); go(); },
      });
      return;
    }
    return go();
  }

  const selectedPack = payWith.startsWith("pack:") ? packs.find((p) => p.id === payWith.slice(5)) : undefined;
  const payLabel = !auth
    ? "Log in to book"
    : isEvent
      ? selectedTicketType?.is_free
        ? "Reserve free ticket"
        : total != null
          ? `Get ${count > 1 ? `${count} tickets` : "ticket"} — ${selectedTicketType?.currency ?? ""} ${total.toFixed(2)}`
          : "Get ticket"
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
        <main data-bb-loading className="mx-auto max-w-[1024px] px-6 py-16"><RainbowLoader className="py-4" label="Loading booking" /></main>
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
        <section className="rounded-[18px] border border-[#EBE3E5] bg-white shadow-card">
          <header className="grid items-center gap-5 border-b border-[#F4EFF0] p-6 md:grid-cols-[90px_1fr_240px]">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="calendar" className="h-10 w-10" /></span>
            <div><h1 className="text-[34px] font-black">{isEvent ? "Get your tickets" : "Book your class"}</h1><p className="text-lg font-semibold">{isEvent ? "Pick how many tickets you need, then check out." : "Choose your preferred date, time & package."}</p></div>
            {/* The brand icon itself, rather than the confetti mascot crop that
                was lifted from the design mockup. */}
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-icon.png`} alt="" className="hidden h-24 object-contain md:block" />
          </header>
          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
            <section>
              <div className="grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={img} alt={activity.title} className="h-52 w-full rounded-[12px] object-cover" />
                <div>
                  <h2 className="text-xl font-black">{activity.title}</h2>
                  <p className="mt-2 font-semibold">{ageText}</p>
                  <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                    {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                    {activity.category_name && <p className="flex gap-2"><Icon name="music" className="h-5 w-5 text-baby-lilac" /> {activity.category_name}</p>}
                    <p className="flex gap-2"><Icon name="star" className="h-5 w-5 text-baby-lilac" /> {activity.rating_count > 0 ? `${Number(activity.rating_avg).toFixed(1)} (${activity.rating_count} reviews)` : "New class"}</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-6 border-t border-[#F4EFF0] pt-5">
                {sessions.length === 0 ? (
                  <p className="rounded-[12px] bg-[#FFF5F8] p-4 font-semibold text-[#5a6690]">No upcoming sessions scheduled yet — try “Enquire Now” on the class page to ask the provider.</p>
                ) : (
                  <>
                    {isCourse && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">1. Course schedule</h3>
                        <div className="rounded-[12px] border border-[#DCD2D5] bg-[#FAF7F7] p-4">
                          <p className="text-sm font-semibold text-[#5a6690]">
                            This is a course — one booking enrols your child for the whole run, every session below.
                          </p>
                          {courseRange && <p className="mt-1 text-sm font-black text-[#34406f]">Runs {courseRange}</p>}
                          <div className="mt-4 space-y-2">
                            {strands.map((st) => (
                              <div key={st.key} className="rounded-[10px] border border-[#EBE3E5] bg-white px-3 py-2.5">
                                <p className="text-sm font-black text-[#34406f]">{st.label}</p>
                                <p className="mt-0.5 text-xs font-semibold text-[#697390]">{st.range} · {st.count} {st.count === 1 ? "session" : "sessions"}</p>
                              </div>
                            ))}
                          </div>
                          {courseSpots != null && (
                            <p className="mt-3 text-xs font-semibold text-[#697390]">{courseSpots} {courseSpots === 1 ? "spot" : "spots"} left</p>
                          )}
                        </div>
                      </section>
                    )}
                    {!isEvent && !isCourse && (
                      <>
                        <section>
                          <h3 className="mb-4 text-xl font-black">1. Choose a date</h3>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                            {/* Split "Tue, 25 Aug" into two fixed lines rather than
                                letting it wrap naturally — a plain text wrap broke
                                differently per weekday's width, so cards ended up
                                one or two lines tall depending on which day it was. */}
                            {dates.map((d) => {
                              const [weekday, dayMonth] = d.split(", ");
                              return (
                                <button key={d} onClick={() => { setDateKey(d); setSessionId(null); }} className={`rounded-[10px] border px-3 py-4 text-sm font-bold ${d === dateKey ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
                                  <span className="block whitespace-nowrap">{weekday},</span>
                                  <span className="block whitespace-nowrap">{dayMonth}</span>
                                  <span className="mt-2 block text-xs font-semibold text-[#697390]">{byDate[d].length} {byDate[d].length === 1 ? "time" : "times"}</span>
                                </button>
                              );
                            })}
                          </div>
                        </section>
                        <section>
                          <h3 className="mb-4 text-xl font-black">2. Choose a time</h3>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                            {times.map((s) => (
                              <button key={s.id} onClick={() => setSessionId(s.id)} className={`rounded-[10px] border px-3 py-4 font-bold ${s.id === sessionId ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
                                <span className="block whitespace-nowrap">{sgTime(s.starts_at)}</span>
                                <span className="mt-2 block text-xs font-semibold text-[#697390]">{s.capacity != null ? `${s.capacity} spots` : "Available"}</span>
                              </button>
                            ))}
                          </div>
                          {slotDetailsVary && (
                            <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                              <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                              This class runs at more than one venue or price — the date and time you pick may change the venue or price shown in your booking summary.
                            </p>
                          )}
                        </section>
                      </>
                    )}
                    {/* Events skip straight to a ticket-type picker — there's
                        only ever one occurrence (auto-selected above), so
                        "date/time" is nothing to choose. Only shown when
                        there's more than one type; a single type is
                        auto-selected silently. */}
                    {isEvent && ticketTypes.length > 1 && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">Choose your ticket</h3>
                        <div className="space-y-3">
                          {ticketTypes.map((t) => (
                            <PackageOption
                              key={t.id}
                              selected={ticketTypeId === t.id}
                              onSelect={() => setTicketTypeId(t.id)}
                              title={t.name}
                              price={t.is_free ? "Free" : `${t.currency} ${(ticketPriceCents(t) / 100).toFixed(2)}`}
                            />
                          ))}
                        </div>
                      </section>
                    )}
                    {kids.length > 1 && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">Who's this class for?</h3>
                        <div className="flex flex-wrap gap-2">
                          {kids.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              onClick={() => setChildId(k.id)}
                              className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 text-sm font-bold ${bookChildId === k.id ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}
                            >
                              <AnimalAvatar seed={k.avatar_seed ?? k.name} kind="child" gender={k.gender} className="h-6 w-6" /> {k.name}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}
                    {childAgeMismatch && bookChild && (
                      <p className="flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                        <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        {bookChild.name} is {formatChildAge(bookChild.date_of_birth)}, outside this class's {ageText} age range — you won't be able to confirm this booking with them selected.
                      </p>
                    )}
                    {alreadyBooked && !childAgeMismatch && (
                      <p className="flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                        <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        {bookChild?.name ?? "This child"} is already booked on this session — you can book again if you need a second place, and we&rsquo;ll check first.
                      </p>
                    )}
                    <section>
                      <h3 className="mb-2 text-xl font-black">{isEvent ? "Number of tickets" : isCourse ? "2. Number of children" : "3. Number of children"}</h3>
                      <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#DCD2D5] text-xl font-black">
                        <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} className="h-12 w-12">-</button>
                        <span className="grid h-12 w-14 place-items-center">{count}</span>
                        <button type="button" onClick={() => setCount((c) => Math.min(isEvent ? ticketQuantityCap : 6, c + 1))} className="h-12 w-12">+</button>
                      </div>
                    </section>
                    {/* Step 4: how to pay for the class — a single drop-in, an
                        unused credit from a pack, or buying a pack now. Not
                        applicable to a Wix Event ticket — payment is always a
                        single purchase (see the isEvent branch in pay()). */}
                    {!redeemToken && !isEvent && !isCourse && (
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
                              title={
                                count > 1
                                  ? `Use ${count} package credits — ${packageCredit.remaining} left`
                                  : `Use a package credit — ${packageCredit.remaining} left`
                              }
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
                          <p className="mt-3 rounded-[10px] bg-[#F4F0FA] p-3 text-xs font-bold text-[#C7B1E6]">
                            You have package credits with this provider, but they can't be used for this{" "}
                            {restrictedCredit.activity_ids && restrictedCredit.activity_ids.length > 0 && !restrictedCredit.activity_ids.includes(activity?.id ?? "") ? "class" : "session slot"} — check your package's designated class or weekly slot.
                          </p>
                        )}
                      </section>
                    )}

                    {/* The provider's own paperwork. Each vendor writes their
                        own consents, waivers and disclosures, so this section
                        only appears when they have some. */}
                    {(policies.length > 0 || needsMedical) && (
                      <section>
                        {/* Step number tracks how many steps came before:
                            class = date, time, children (+ package unless a
                            make-up token skips it); a course is one "Course
                            schedule" step + children, with no package step,
                            so its Provider terms is always step 3. */}
                        <h3 className="mb-2 text-xl font-black">{isEvent ? "" : `${(isCourse ? 3 : redeemToken ? 4 : 5)}. `}Provider terms</h3>
                        <p className="mb-4 text-sm font-semibold text-[#59658d]">
                          {activity?.provider_name?.trim() || "This provider"} asks you to read and accept the following before the class.
                        </p>
                        <div className="space-y-3">
                          {policies.map((p) => {
                            const on = acceptedPolicies.includes(p.id);
                            return (
                              <label
                                key={p.id}
                                className={`flex cursor-pointer gap-3 rounded-[12px] border-2 p-4 transition ${on ? "border-[#A7D8F8] bg-[#EDF7FD]" : "border-[#DCD2D5] bg-white hover:border-[#A7D8F8]"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() =>
                                    setAcceptedPolicies((xs) => (on ? xs.filter((x) => x !== p.id) : [...xs, p.id]))
                                  }
                                  className="mt-1 h-4 w-4 shrink-0 accent-[#FA5D93]"
                                />
                                <span className="min-w-0">
                                  <span className="block font-black">
                                    {p.title}
                                    {p.required ? <span className="ml-1 text-baby-pink">*</span> : (
                                      <span className="ml-2 rounded-full bg-[#F4EFF0] px-2 py-0.5 text-[10px] font-bold text-[#6D748D]">Optional</span>
                                    )}
                                  </span>
                                  {p.body && (
                                    <span className="mt-1 block whitespace-pre-wrap text-sm font-semibold leading-6 text-[#4a5685]">{p.body}</span>
                                  )}
                                  {p.document_url && (
                                    <a
                                      href={p.document_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="mt-1 inline-flex items-center gap-1 text-sm font-black text-palette-blue underline"
                                    >
                                      <Icon name="open" className="h-3.5 w-3.5" /> Read the full document
                                    </a>
                                  )}
                                </span>
                              </label>
                            );
                          })}
                          {/* Whatever this vendor asks for on this activity —
                              an address when they host at your condo, say.
                              The wording is theirs (migration 00074). */}
                          {activity?.info_request_enabled && (
                            <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                              <p className="font-black">
                                {activity.info_request_prompt?.trim() || "The provider needs some extra information"}{" "}
                                <span className="text-baby-pink">*</span>
                              </p>
                              <textarea
                                value={infoResponse}
                                onChange={(e) => setInfoResponse(e.target.value)}
                                rows={3}
                                className="mt-2 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                                placeholder="Your answer"
                              />
                            </div>
                          )}
                          {needsMedical && (
                            <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                              <p className="font-black">Medical &amp; health disclosure <span className="text-baby-pink">*</span></p>
                              <p className="mt-1 text-sm font-semibold text-[#59658d]">
                                Anything the provider should know — allergies, conditions, medication. Write &ldquo;none&rdquo; if there is nothing to declare.
                              </p>
                              <textarea
                                value={medicalNote}
                                onChange={(e) => setMedicalNote(e.target.value)}
                                rows={3}
                                className="mt-2 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                                placeholder="e.g. mild peanut allergy — carries an EpiPen"
                              />
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </>
                )}
              </div>
            </section>

            <aside className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 flex gap-4">
                <img src={img} alt="" className="h-24 w-28 rounded-[10px] object-cover" />
                <div><h3 className="font-black">{activity.title}</h3><p className="mt-1 text-sm font-semibold">{ageText}</p>{activity.category_name && <span className="mt-2 inline-block rounded-full bg-[#FEEBF2] px-3 py-1 text-xs font-bold text-baby-cta">{activity.category_name}</span>}</div>
              </div>
              <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 shrink-0 text-baby-lilac" /> {selected ? sgDateTime(selected.starts_at) : "Select a date & time"}</p>
                {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                <p className="flex gap-2"><Icon name="user" className="h-5 w-5 shrink-0 text-baby-lilac" /> {count} {count === 1 ? "child" : "children"}, {ageText}</p>
              </div>
              <div className="my-5 border-t border-[#F4EFF0]" />
              <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-pink">{redeemToken ? "$0.00" : total != null ? `$${total.toFixed(2)}` : "Price on enquiry"}</span></p>
            </aside>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total amount</span><strong className="text-3xl">{redeemToken ? "$0.00" : total != null ? `$${total.toFixed(2)}` : "—"}</strong></p></div>
            {err && <p className="mt-3 text-sm font-bold text-baby-pink">{err}</p>}
          </div>
          {redeemToken && (
            <p className="mb-3 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-[#FFD77A]"><Icon name="gift" className="mr-1 inline h-4 w-4" /> Using a make-up token — this class is on the house.</p>
          )}
          {activity?.bookings_paused ? (
            /* 1.1: the vendor has paused bookings for this class */
            <div className="rounded-[12px] bg-amber-50 p-4 text-center font-bold text-palette-yellow">
              <Icon name="bell" className="mr-2 inline h-5 w-5" /> Bookings for this class are temporarily paused by the provider. Please check back later or enquire with them directly.
            </div>
          ) : (
            <Button type="button" size="lg" onClick={checkout} className={busy || !sessionId ? "opacity-60" : ""}>
              <Icon name="lock" className="h-5 w-5" /> {busy ? "Confirming…" : payLabel}
            </Button>
          )}
          {/* One grid item so the section's gap-5 sits above this block, not
              between the two lines — they hug each other instead. */}
          {(isEvent || (total != null && total > 0 && !redeemToken)) && (
            <div className="space-y-0.5 text-center md:col-span-2">
              {isEvent && (
                <p className="text-xs font-bold text-[#6D748D]">* This activity is non-cancellable once booked.</p>
              )}
              {total != null && total > 0 && !redeemToken && (
                <p className="text-xs font-semibold text-[#6D748D]">Secure and encrypted payment via Stripe</p>
              )}
            </div>
          )}
        </section>
      </main>
      {dupPrompt && (
        <ConfirmDialog
          title="Already booked on this class"
          copy={`${dupPrompt.childName} already has a place on this session. Book a second place anyway?`}
          confirmLabel="Yes, book again"
          cancelLabel="Cancel"
          onConfirm={dupPrompt.proceed}
          onClose={() => setDupPrompt(null)}
        />
      )}
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

  /* QA 24/08 + 28/08: "you can't change the information on the activity
     confirmation screen" and "vendors currently can't edit the message that is
     displayed under what to bring & know". This page was entirely hardcoded —
     every booking, whatever it was for, showed the same music-class blurb, the
     same photo and the same three generic cards. It now reads the real
     activity, including the two fields vendors can write (migration 00074). */
  const [detail, setDetail] = useState<{
    description: string | null;
    image_urls: string[] | null;
    what_to_bring: string | null;
    confirmation_message: string | null;
  } | null>(null);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    supabase
      .from("activities")
      .select("description, image_urls, what_to_bring, confirmation_message")
      .eq("slug", slug)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) setDetail(data ?? null); });
    return () => { cancelled = true; };
  }, [slug]);

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
        <section className="grid items-center gap-5 rounded-[18px] border border-[#EBE3E5] bg-gradient-to-r from-[#FEEBF2] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="check" className="h-12 w-12" /></span>
          <div><h1 className="text-[36px] font-black">{waitlisted ? "You're on the waitlist!" : "Your class is booked!"}</h1><p className="mt-2 text-lg font-semibold">{waitlisted ? "This session is full — we'll notify you the moment a spot opens up." : "We can't wait to see your little one there."}</p></div>
          {/* The full stacked logo (mascot + wordmark), not the confetti mascot
              crop lifted from the mockup — same call as the Book page header,
              which already dropped the confetti. */}
          <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="hidden h-24 object-contain md:block" />
        </section>
        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
          <div className="space-y-5">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Class details</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                <img
                  src={detail?.image_urls?.[0] || `${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`}
                  alt=""
                  className="h-52 w-full rounded-[12px] object-cover"
                />
                <div>
                  <h3 className="text-xl font-black">{title}</h3>
                  {when && <div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />{when}</p></div>}
                  {venue && <p className="mt-3 font-semibold text-[#4a5685]"><Icon name="pin" className="mr-2 inline h-5 w-5 text-baby-lilac" />{venue}</p>}
                </div>
              </div>
              {detail?.description?.trim() && (
                <div className="mt-5 border-t border-[#F4EFF0] pt-5">
                  <h3 className="font-black">About this class</h3>
                  <p className="mt-3 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.description.trim()}</p>
                </div>
              )}
              {detail?.confirmation_message?.trim() && (
                <div className="mt-5 rounded-[12px] bg-[#F4F0FA] p-4">
                  <h3 className="font-black text-baby-lilac">From {`“${title}”`}</h3>
                  <p className="mt-2 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.confirmation_message.trim()}</p>
                </div>
              )}
            </article>
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">What to bring &amp; know</h2>
              {detail?.what_to_bring?.trim() ? (
                <p className="mt-5 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.what_to_bring.trim()}</p>
              ) : (
                /* Fallback while a vendor hasn't written their own. */
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  {[["bell", "Arrive 10 mins early", "Enable your child to get comfortable"], ["shoe", "Dress comfortably", "Allow for movement and potential mess"], ["bottle", "Bring essentials", "Socks, water and wipes encouraged"]].map(([icon, title, note]) => <div key={title} className="text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta"><Icon name={icon} className="h-8 w-8" /></span><h3 className="mt-3 font-black">{title}</h3><p className="mt-2 text-sm font-semibold text-[#59658d]">{note}</p></div>)}
                </div>
              )}
            </article>
          </div>
          <aside className="space-y-5">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Class</span><span className="text-right">{title}</span></p>{when && <p className="flex justify-between"><span>When</span><span className="text-right">{when}</span></p>}<p className="flex justify-between"><span>Status</span><strong className={waitlisted ? "text-palette-yellow" : "text-palette-green"}>{waitlisted ? "Waitlisted" : "Confirmed"}</strong></p></div>
              <p className={`mt-5 rounded-[12px] p-4 font-semibold ${waitlisted ? "bg-amber-50 text-palette-yellow" : "bg-[#F1FBEF] text-palette-green"}`}><Icon name="check" className="mr-2 inline h-5 w-5" /> {waitlisted ? "Added to the waitlist" : "Booking confirmed"}</p>
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
            <article className="rounded-[16px] bg-[#F4F0FA] p-6">
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

function AboutPage() {
  return (
    <PageShell active="/about" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-8">
        <section className="relative grid items-center gap-8 md:grid-cols-[1fr_520px]">
          <div className="relative z-10">
            <h1 className="text-[54px] font-black leading-tight text-baby-lilac">About</h1>
            <p className="mt-5 text-2xl font-black leading-tight">BabyBrain helps parents to discover &amp; book amazing activities for their little ones.</p>
            <p className="mt-5 max-w-[420px] font-semibold leading-7 text-[#3f4b78]">We curate options based on your children's age, interests and your location, making it quicker and easier to find great activities and less overwhelming to adjust plans when the schedule changes.</p>
            <Button href="/explore" className="mt-6">Explore →</Button>
          </div>
          {/* Portrait source cropped into the square frame — positioned low
              (10% from top) so Katie's head clears the top edge instead of
              the default center-crop cutting into her hair. */}
          <img
            src={`${import.meta.env.BASE_URL}assets/crops/about-family.jpg`}
            alt="Katie, BabyBrain's founder, holding her son"
            width={1000}
            height={1000}
            className="relative z-10 mx-auto aspect-square w-full max-w-[460px] rounded-[24px] object-cover object-[50%_10%] shadow-soft"
          />
        </section>

        <section className="relative mt-8 grid items-center gap-8 overflow-hidden rounded-[24px] bg-gradient-to-r from-[#FEEBF2] to-[#FFF5F8] p-8 md:grid-cols-[300px_1fr]">
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
        {/* No tinted panel here — the mission sits straight on the page. */}
        <section className="mt-5 grid items-center gap-6 px-2 py-8 md:grid-cols-[1fr_320px]">
          <div>
            <h2 className="text-[46px] font-black leading-none text-baby-lilac">Our mission</h2>
            <p className="mt-5 text-2xl font-black leading-tight">To reduce the mental load for parents in Singapore.</p>
            <p className="mt-4 max-w-[440px] font-semibold leading-7 text-[#3f4b78]">We want to help you spend less time on administration and more time having meaningful experiences.</p>
            <Button href="/onboarding" size="lg" className="mt-6">Join today →</Button>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/mission-target.png`} alt="" className="mx-auto h-48 object-contain" />
        </section>
      </main>
      <Footer />
    </PageShell>
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
    goTo(next && next.startsWith("/") && !next.startsWith("//") ? next : "/profile");
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-6 py-12">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-8 shadow-card">
          <h1 className="text-2xl font-black">Welcome back <span>👋</span></h1>
          <p className="mt-1 font-semibold text-[#5a6690]">Log in to see activity suggestions for your children.</p>
          {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-black">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-black">Password</label>
                <a href="/forgot-password" className="text-xs font-bold text-baby-pink hover:underline">Forgot password?</a>
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Reset your password</h1>
          {sent ? (
            <div className="mt-3">
              <p className="rounded-[10px] bg-[#F1FBEF] px-3 py-3 text-sm font-semibold text-palette-green">
                If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
              </p>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                <a href="/login" className="font-black text-baby-pink">← Back to log in</a>
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Enter your email and we'll send you a link to set a new password.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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
    // QA: a reset let through any six characters, so a password that would
    // have been rejected at sign-up could be set here and then used to log in.
    // Same rules, same wording, both ends.
    const pwProblem = passwordError(password);
    if (pwProblem) return setError(pwProblem);
    setBusy(true);
    setError(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) return setError(error);
    setDone(true);
    setTimeout(() => goTo("/profile"), 1500);
  }

  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-4 py-12 sm:px-6">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Set a new password</h1>
          {done ? (
            <p className="mt-3 rounded-[10px] bg-[#F1FBEF] px-3 py-3 text-sm font-semibold text-palette-green">
              Password updated. Taking you to your profile…
            </p>
          ) : !ready ? (
            <p className="mt-3 rounded-[10px] bg-[#FEF9EB] px-3 py-3 text-sm font-semibold text-[#FFD77A]">
              This page only works from the reset link in your email. Open that link, or <a href="/forgot-password" className="font-black text-baby-pink">request a new one</a>.
            </p>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Choose a new password for your account.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">New password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
                  {/* The same live checklist the sign-up form shows, so the
                      rules are visible before the form is submitted. */}
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
                  <label className="mb-1 block text-sm font-black">Confirm password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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

/** Best-effort synchronous check for a stored Supabase session, so the root
 *  route can tell a returning parent (wait on a loader) from a genuine visitor
 *  (show the marketing page straight away) before auth has resolved. */
function hasStoredSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && /^sb-.*-auth-token$/.test(key)) return true;
    }
  } catch {
    /* storage blocked — assume no session */
  }
  return false;
}

function App() {
  const { session, loading } = useAuth();
  // In production a Next rewrite serves these routes from `/`, but the Vite dev
  // server hosts the bundle under its `/app/` base — strip it so local routing
  // matches what parents actually browse.
  const pathname = window.location.pathname.replace(/^\/app(?=\/|$)/, "").replace(/\/$/, "") || "/";
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
  // classes for their child), not the marketing page. While auth is still
  // resolving, a browser that has a stored session waits on a loader rather
  // than flashing the marketing landing page before the redirect.
  if (!loading && session) return <MatchesPage active="/" />;
  if (loading && hasStoredSession()) {
    return (
      <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
        <RainbowLoader className="py-4" label="Loading" />
      </main>
    );
  }
  return <HomePage />;
}

export default App;
