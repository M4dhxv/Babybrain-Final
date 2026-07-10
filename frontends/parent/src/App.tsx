import {
  ActivityCard,
  ActivityRow,
  Button,
  CategoryTile,
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
  useFavoriteProvider,
  useRecommendations,
  useJourney,
  toCard,
} from "./lib/data";
import { supabase } from "./lib/supabase";
import { apiGet, apiPost } from "./lib/api";
import { downloadBookingIcs } from "./lib/ics";
import { formatChildAge, formatAgeRange } from "./lib/database.types";
import type { ActivitySession } from "./lib/database.types";
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
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[#eef5ff] px-4 py-2.5 text-[13px] font-bold text-[#2b7cff]">
              <Icon name="heart" className="h-4 w-4" /> Made for you. Designed to save time.
            </div>
            <h1 className="max-w-[520px] text-[40px] font-black leading-[1.04] md:text-[52px]">
              Curated activities that fit{" "}
              <span className="text-baby-blue">your child</span>
            </h1>
            <p className="mt-5 max-w-[460px] text-[17px] font-semibold leading-7 text-[#27325f]">
              Discover activities and play spaces that match your child's age,
              interests and stage of growth.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Button href="/explore" size="lg">
                Explore Activities <span>›</span>
              </Button>
              <Button href="/onboarding" variant="outline" size="lg">
                Create Profile <Icon name="user" className="h-[18px] w-[18px]" />
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
            ["search", "Curated activities", "Picked to match your child's needs."],
            ["shield", "Trusted providers", "We partner with verified providers"],
            ["calendar", "Planned with ease", "Find activities that fit your day"],
          ].map(([icon, title, copy]) => (
            <div key={title} className="flex items-center gap-4">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#f2e8ff] to-[#eef8ff] text-baby-lilac">
                <Icon name={icon} className="h-8 w-8" />
              </span>
              <p>
                <strong className="block text-base font-black">{title}</strong>
                <span className="text-sm font-semibold leading-6 text-[#3f4b78]">{copy}</span>
              </p>
            </div>
          ))}
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-3">
          <div className="rounded-[22px] border border-[#e8ecf6] bg-white/80 p-5 shadow-card">
            <h2 className="text-center text-[26px] font-black text-baby-lilac">
              How it works <Icon name="spark" className="inline h-5 w-5 text-baby-pink" />
            </h2>
            <p className="text-center text-sm font-semibold text-[#46527d]">
              Three simple steps to help you discover activities that suit your child.
            </p>
            <div className="mt-5 grid gap-5 md:grid-cols-3">
              {[
                ["1", "how-step-1", "Tell us about your child", "Share a few details about your child's age, interests and what you're looking for."],
                ["2", "how-step-2", "Explore activities", "Browse curated activities and play spaces that match your preferences."],
                ["3", "how-step-3", "Plan and book", "Choose what works for you and book directly with the provider."],
              ].map(([step, art, title, copy]) => (
                <article key={title} className="text-center">
                  <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-baby-pink text-base font-black text-white">
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
                ["people", "500+", "Curated activities"],
                ["store", "100+", "Verified providers"],
                ["chart", "Thousands", "Happy families"],
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
          <SectionTitle>Explore activities by category</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label]) => (
              <CategoryTile key={label} icon={icon} label={label} />
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-6 py-4">
          <SectionTitle
            action={<a href="/explore" className="font-bold text-[#2182ff]">View all activities ›</a>}
          >
            Activities near you
          </SectionTitle>
          <MiniActivityGrid />
        </section>

        <section className="mx-auto grid max-w-[1120px] gap-4 px-6 py-3 md:grid-cols-3">
          {["Joanne Tan", "Marcus Lim", "Sarah Wong"].map((name, index) => (
            <article key={name} className="flex gap-4 rounded-[16px] border border-[#e8ecf6] bg-white p-5 shadow-card">
              <img
                src={index === 1 ? `${import.meta.env.BASE_URL}assets/crops/parent-avatar.png` : `${import.meta.env.BASE_URL}assets/crops/mom-avatar.png`}
                alt={name}
                className="h-11 w-11 shrink-0 rounded-full object-cover"
              />
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
              <h2 className="text-2xl font-black">Curated activities. Reduced mental load.</h2>
              <p className="mt-1 font-semibold text-[#4e5982]">Let us help you find what's right for your child.</p>
            </div>
            <Button href="/onboarding" size="lg">Create your profile ›</Button>
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
        className="mt-2 h-10 w-full rounded-[8px] border border-[#dfe5f2] bg-white px-3 text-sm font-semibold outline-none focus:border-baby-blue"
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
    <button type="button" onClick={onClick} className={`rounded-[8px] border px-3 py-2 text-xs font-bold ${on ? "border-baby-blue bg-[#eef5ff] text-[#1275ff]" : "border-[#e2e7f4] bg-white"}`}>
      {children}
    </button>
  );
}

function OnboardingPage() {
  const { signUp } = useAuth();
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [weekdays, setWeekdays] = useState(false);
  const [weekend, setWeekend] = useState(false);
  const [times, setTimes] = useState<string[]>([]);
  const [budget, setBudget] = useState<string | null>(null);
  const [interests, setInterests] = useState<string[]>([]);
  const [childName, setChildName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [childGender, setChildGender] = useState("unspecified");
  const [childInterests, setChildInterests] = useState<string[]>([]);
  const [childNotes, setChildNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 text-sm font-semibold";

  async function submit() {
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
    const b = BUDGET_CHIPS.find(([k]) => k === budget);
    await supabase.from("parent_profiles").update({ full_name: fullName, phone: phone || null, postal_code: postcode || null }).eq("id", uid);
    await supabase.from("user_preferences").update({
      preferred_days: days as never,
      preferred_times: times as never,
      budget_min: b ? b[2] : null,
      budget_max: b ? b[3] : null,
      interests,
    }).eq("user_id", uid);
    if (childName && childDob) {
      await supabase.from("children").insert({
        parent_id: uid,
        name: childName,
        date_of_birth: childDob,
        gender: childGender as never,
        interests: childInterests,
        notes: childNotes || null,
      });
    }
    window.location.href = "/matches";
  }

  if (confirmSent) {
    return (
      <PageShell active="/onboarding">
        <main className="mx-auto max-w-[460px] px-6 py-16 text-center">
          <h1 className="text-2xl font-black">Check your email</h1>
          <p className="mt-3 font-semibold text-[#44507b]">We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account, then log in to finish setup.</p>
          <Button href="/login" className="mt-5">Go to login</Button>
        </main>
      </PageShell>
    );
  }

  return (
    <PageShell active="/onboarding">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        {error && <p className="mb-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}

        <section className="rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h1 className="text-[26px] font-black">Let's get to know you</h1>
          <p className="mt-1 text-sm font-semibold text-[#44507b]">This helps us show options for your family.</p>
          <div className="mt-5 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Sarah Tan" /></div>
            <div><label className="mb-1 block text-sm font-black">Email address</label><input type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. sarah@gmail.com" /></div>
            <div><label className="mb-1 block text-sm font-black">Password</label><input type="password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div><label className="mb-1 block text-sm font-black">Postcode</label><input className={input} value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="307591" /></div>
            </div>
          </div>
          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="heart" className="h-4 w-4 text-baby-pink" /> Your preferences</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip on={weekdays} onClick={() => setWeekdays(!weekdays)}>Weekdays</Chip>
            <Chip on={weekend} onClick={() => setWeekend(!weekend)}>Weekend</Chip>
            {TIME_CHIPS.map(([v, l]) => <Chip key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Chip>)}
            {BUDGET_CHIPS.map(([k, l]) => <Chip key={k} on={budget === k} onClick={() => setBudget(budget === k ? null : k)}>{l}</Chip>)}
          </div>
          <p className="mt-3 mb-1 text-sm font-black">Interests</p>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => <Chip key={c.slug} on={interests.includes(c.slug)} onClick={() => toggle(interests, c.slug, setInterests)}>{c.name}</Chip>)}
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#eadfd2] bg-white p-5">
          <h1 className="text-[26px] font-black">Tell us about your <span className="text-baby-blue">child</span></h1>
          <div className="mt-4 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Child's name</label><input className={input} value={childName} onChange={(e) => setChildName(e.target.value)} placeholder="e.g. Emma" /></div>
            <div><label className="mb-1 block text-sm font-black">Date of birth</label><input type="date" max={new Date().toISOString().slice(0, 10)} className={input} value={childDob} onChange={(e) => setChildDob(e.target.value)} /></div>
            <div className="grid grid-cols-3 gap-3">
              {[["male", "Boy"], ["female", "Girl"], ["unspecified", "Prefer not to say"]].map(([v, l]) => (
                <Chip key={v} on={childGender === v} onClick={() => setChildGender(v)}>{l}</Chip>
              ))}
            </div>
            <div>
              <p className="mb-1 text-sm font-black">Interests</p>
              <div className="flex flex-wrap gap-2">
                {cats.map((c) => <Chip key={c.slug} on={childInterests.includes(c.slug)} onClick={() => toggle(childInterests, c.slug, setChildInterests)}>{c.name}</Chip>)}
              </div>
            </div>
            <div><label className="mb-1 block text-sm font-black">Any other notes?</label><input className={input} value={childNotes} onChange={(e) => setChildNotes(e.target.value)} placeholder="e.g. loves dancing…" /></div>
          </div>
        </section>

        <Button type="button" onClick={submit} className="mt-5 w-full justify-center">{busy ? "Setting up…" : "Show me options →"}</Button>
        <p className="mt-3 text-center text-sm font-semibold text-[#5a6690]">Already have an account? <a href="/login" className="font-black text-baby-blue">Log in</a></p>
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
          <Button href="/login" className="mt-4">Log In</Button>
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
                Here are classes matched for <span className="text-baby-lilac">{child?.name ?? "your child"}</span>
              </h1>
              <p className="mt-4 text-[17px] font-semibold text-[#47527d]">Activities matching your profile.</p>
              <Button href="/explore" className="mt-5">Explore activities →</Button>
            </div>
            {child && (
              <article className="flex gap-4 rounded-[18px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                <img src={`${import.meta.env.BASE_URL}assets/crops/baby-profile.png`} alt="" className="h-32 w-32 rounded-full object-cover ring-8 ring-[#fff1f5]" />
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
          <SectionTitle action={<a href="/explore" className="font-bold text-[#2182ff]">See activity options →</a>}>Matching Activities</SectionTitle>
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
        </section>

        <section className="mt-6">
          <SectionTitle>Options Based on Preferences</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label, copy]) => (
              <CategoryTile key={label} icon={icon} label={label} copy={copy} />
            ))}
          </div>
        </section>
      </main>
    </PageShell>
  );
}

const AGE_FILTERS: [string, string][] = [
  ["", "All ages"],
  ["6", "0 – 1 year"],
  ["18", "1 – 2 years"],
  ["36", "3 – 4 years"],
  ["60", "5 years +"],
];

function ExplorePage() {
  const [sort, setSort] = useState<"popular" | "rating" | "distance">("popular");
  const [category, setCategory] = useState("");
  const [age, setAge] = useState("");
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const { activities, loading } = useActivities({
    limit: 24,
    sort,
    category: category || null,
    ageMonths: age ? Number(age) : null,
  });

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const selectClass = "h-10 rounded-[10px] border border-[#e6e6ef] bg-white px-3 text-[13px] font-bold shadow-card focus:border-baby-blue focus:outline-none";

  return (
    <PageShell active="/explore">
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[28px] font-black text-baby-lilac sm:text-[34px]">Explore Activities <Icon name="spark" className="inline h-6 w-6 text-baby-blue" /></h1>
            <p className="mt-1 text-base font-semibold text-[#4a5680] sm:text-lg">Browse activities across Singapore.</p>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/explore-skyline.png`} alt="" className="hidden h-24 object-contain md:block lg:h-28" />
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-[#68718f]">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectClass}>
              <option value="">All categories</option>
              {cats.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-[#68718f]">Age</span>
            <select value={age} onChange={(e) => setAge(e.target.value)} className={selectClass}>
              {AGE_FILTERS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-[#68718f]">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as "popular" | "rating" | "distance")} className={selectClass}>
              <option value="popular">Most popular</option>
              <option value="rating">Top rated</option>
              <option value="distance">Nearest</option>
            </select>
          </label>
        </div>
        <div className="grid gap-5 lg:grid-cols-[568px_1fr]">
          <section>
            <p className="mb-3 text-sm font-black">{loading ? "Loading…" : `${activities.length} activities found`}</p>
            <div className="space-y-2.5">
              {activities.map((activity) => (
                <ActivityRow key={activity.title} activity={activity} />
              ))}
            </div>
            {!loading && activities.length === 0 && (
              <p className="mt-6 rounded-[12px] bg-[#f8fbff] p-5 text-center font-semibold text-[#68718f]">No activities match these filters — try widening your search.</p>
            )}
          </section>
          <section className="rounded-[16px] border border-[#e7ebf6] bg-white p-3 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-baby-lilac">Explore on map</h2>
              <span className="text-xs font-bold text-[#68718f]">{activities.filter((a) => a.lat != null).length} pinned</span>
            </div>
            <div className="relative overflow-hidden rounded-[12px]">
              <ExploreMap activities={activities} />
            </div>
          </section>
        </div>
      </main>
    </PageShell>
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

function ActivityDetailPage() {
  const { activity, sessions, reviews, loading } = useActivityDetail(getParam("slug"));
  const fav = useFavorite(activity?.id);
  const favProvider = useFavoriteProvider(activity?.provider_id);
  const { session } = useAuth();
  const [enquiring, setEnquiring] = useState(false);
  const [groupChat, setGroupChat] = useState(false);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);

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
          <a href="/explore" className="font-bold text-baby-blue">← Back to results</a>
        </main>
      </PageShell>
    );
  }

  const next = sessions[0];
  const durationMins = next
    ? Math.round((new Date(next.ends_at).getTime() - new Date(next.starts_at).getTime()) / 60000)
    : null;
  const images = activity.image_urls.length ? activity.image_urls : [`${import.meta.env.BASE_URL}assets/crops/detail-hero.png`];

  return (
    <PageShell active="/explore">
      <main className="mx-auto max-w-[1180px] px-6 py-5">
        <section className="grid gap-5 lg:grid-cols-[285px_1fr_295px]">
          <div>
            <a href="/explore" className="font-bold text-baby-lilac">← Back to results</a>
            <h1 className="mt-5 text-[29px] font-black">{activity.title}</h1>
            {activity.provider_name && (
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
            </div>
            {images.length > 1 && (
              <div className="mt-3 flex gap-2">
                {images.slice(1, 6).map((url) => (
                  <span key={url} className="overflow-hidden rounded-[8px] border-2 border-white shadow-soft">
                    <img src={url} alt="" className="h-11 w-[76px] object-cover" />
                  </span>
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
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#4aa1ff] to-[#5ea6f6] px-6 py-3 text-[15px] font-extrabold text-white shadow-blue transition hover:brightness-105"
              >
                <Icon name="calendar" className="h-4 w-4" /> Book on provider's site
              </a>
            ) : (
              <Button href={`/book?slug=${activity.slug}`} className="mt-4 w-full"><Icon name="calendar" className="h-4 w-4" /> Book a Class</Button>
            )}
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                if (!session) {
                  window.location.href = "/login";
                } else if (activity.provider_id) {
                  setEnquiring(true);
                }
              }}
            >
              <Icon name="mail" className="h-4 w-4" /> Enquire Now
            </Button>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                if (!session) window.location.href = "/login";
                else setGroupChat(true);
              }}
            >
              <Icon name="people" className="h-4 w-4" /> Class Group Chat
            </Button>
            <Button variant="soft" type="button" onClick={fav.toggle} className="mt-3 w-full text-baby-pink">
              <Icon name="heart" className="h-4 w-4" /> {fav.saved ? "Saved to Favorites" : "Save to Favorites"}
            </Button>
            {activity.provider_id && (
              <Button variant="ghost" type="button" onClick={favProvider.toggle} className="mt-3 w-full">
                <Icon name="store" className="h-4 w-4" /> {favProvider.saved ? "Following provider" : "Follow this provider"}
              </Button>
            )}
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
              {next && <p><strong>Next available session</strong><span className="float-right">{sgDateTime(next.starts_at)}</span></p>}
              {next?.capacity != null && <p><strong>Spaces left</strong><span className="float-right text-[#197bff]">{next.capacity} spots</span></p>}
              <p className="rounded-[12px] bg-[#f8fbff] p-3"><Icon name="shield" className="mr-1 inline h-4 w-4 text-baby-lilac" /> Hosted by a trusted provider<br /><span className="text-[#58648d]">All venues and instructors are verified.</span></p>
            </div>
          </aside>
        </section>

        <section className="mt-5 grid gap-5 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card lg:grid-cols-[1.4fr_1fr]">
          <InfoBlock title="About this class" items={[activity.description]} />
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
            <h2 className="mb-1 text-xl font-black">Class packs</h2>
            <p className="mb-4 text-sm font-semibold text-[#68718f]">Buy a multi-class pack and save — credits work across this provider's classes.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {packs.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#e7ebf6] p-4">
                  <div>
                    <h3 className="font-black">{p.name}</h3>
                    <p className="text-sm font-semibold text-[#59658d]">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</p>
                  </div>
                  <Button type="button" size="sm" onClick={() => buyPack(p.id)} className={buyingPack === p.id ? "opacity-60" : ""}>
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
        <a href="/login" className="font-black text-baby-blue">Log in</a> to review a class you've attended.
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
        className="mt-3 w-full rounded-[10px] border border-[#dbe4f6] px-3 py-2 text-sm font-semibold"
      />
      {error && <p className="mt-2 text-sm font-bold text-[#b00040]">{error}</p>}
      <Button type="submit" className="mt-3">{busy ? "Posting…" : "Post review"}</Button>
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

type BookingItem = { id: string; status: string; when: string; title: string; slug: string; image: string; startsAt: string | null; endsAt: string | null; venue: string };
type ReviewItem = { id: string; rating: number; comment: string | null; title: string; slug: string };
type NotifItem = { id: string; title: string; body: string; read_at: string | null; created_at: string };
type TokenItem = { id: string; status: string; provider: string; created_at: string; expires_at: string | null; originSlug: string | null };
type PackageItem = { id: string; name: string; provider: string; total: number; remaining: number; status: string };

const PROFILE_TABS: [string, string, string][] = [
  ["overview", "Overview", "home"],
  ["children", "My Children", "people"],
  ["bookings", "Bookings", "calendar"],
  ["attended", "Attended Classes", "check"],
  ["packages", "Packages", "store"],
  ["makeup", "Make-up Tokens", "gift"],
  ["favorites", "Favorites", "heart"],
  ["reviews", "Reviews", "star"],
  ["notifications", "Notifications", "bell"],
  ["settings", "Settings", "gear"],
];

function tokenStatusStyle(status: string) {
  if (status === "issued") return "bg-[#eefbf1] text-green-700";
  if (status === "redeemed") return "bg-[#f3f7ff] text-[#2b7cff]";
  return "bg-[#f1efe8] text-[#7a725c]"; // expired
}

function bookingStatusStyle(status: string) {
  if (status === "confirmed" || status === "completed") return "bg-[#eefbf1] text-green-700";
  if (status === "cancelled") return "bg-[#ffe9ef] text-[#b00040]";
  if (status === "waitlisted") return "bg-amber-50 text-amber-700";
  return "bg-[#f3f7ff] text-[#2b7cff]";
}

function ProfilePage() {
  const { session, profile, children, loading, signOut } = useAuth();
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

    supabase
      .from("bookings")
      .select("id, status, created_at, activity_sessions(starts_at, ends_at, activities(title, slug, image_urls, address))")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          status: string;
          activity_sessions: {
            starts_at: string;
            ends_at: string | null;
            activities: { title: string; slug: string; image_urls: string[]; address: string | null } | null;
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
            };
          })
        );
      });

    supabase
      .from("reviews")
      .select("id, rating, comment, activities(title, slug)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          rating: number;
          comment: string | null;
          activities: { title: string; slug: string } | null;
        }>;
        setReviews(
          rows.map((r) => ({
            id: r.id,
            rating: r.rating,
            comment: r.comment,
            title: r.activities?.title ?? "Activity",
            slug: r.activities?.slug ?? "",
          }))
        );
      });

    supabase
      .from("notifications")
      .select("id, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .then(({ data }) => setNotifications((data ?? []) as unknown as NotifItem[]));

    supabase
      .from("package_purchases")
      .select("id, credits_total, credits_remaining, status, packages(name), providers(business_name)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          credits_total: number;
          credits_remaining: number;
          status: string;
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
            status: r.status,
          }))
        );
      });

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

    // Just came back from a successful checkout? The webhook is async, so poll
    // a few times until the plan flips to Plus instead of showing stale "Free".
    const justUpgraded = getParam("billing") === "success";
    let tries = 0;
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
          if (justUpgraded && p.plan !== "plus" && tries < 5) {
            tries += 1;
            setTimeout(fetchPlan, 1500);
          }
        })
        .catch(() => {});
    };
    fetchPlan();
  }, [session]);

  if (!loading && !session) {
    return (
      <PageShell active="/profile">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Log in to view your dashboard.</p>
          <Button href="/login" className="mt-4">Log In</Button>
        </main>
      </PageShell>
    );
  }

  const recs = recsByChild[0]?.recs ?? [];
  const parentName = profile?.full_name || "Your family";
  const attended = bookings.filter((b) => b.status === "completed");

  return (
    <PageShell active="/profile">
      <main className="mx-auto grid max-w-[1122px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[235px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-[12px] border border-[#e7ebf6] bg-white p-5 shadow-card">
            <div className="flex items-center gap-3">
              <img src={`${import.meta.env.BASE_URL}assets/crops/parent-avatar.png`} alt="" className="h-14 w-14 rounded-full object-cover" />
              <div className="min-w-0"><h2 className="truncate font-black">{parentName}</h2>{child && <p className="truncate text-sm font-semibold text-[#59658d]">{child.name} · {formatChildAge(child.date_of_birth)}</p>}</div>
            </div>
            <a
              href={billingPlan?.plan === "plus" ? "/profile?tab=settings" : "/pricing"}
              className={`mt-4 flex items-center justify-between rounded-[10px] px-3 py-2 text-sm font-bold ${billingPlan?.plan === "plus" ? "bg-[#eef5ff] text-[#096cff]" : "bg-[#fff4ec] text-[#c2571f]"}`}
            >
              <span className="flex items-center gap-1.5">
                <Icon name={billingPlan?.plan === "plus" ? "star" : "spark"} className="h-4 w-4" />
                {billingPlan?.plan === "plus" ? "Plus plan" : "Free plan"}
              </span>
              <span className="text-xs">{billingPlan?.plan === "plus" ? "Manage" : "Upgrade →"}</span>
            </a>
            <nav className="mt-4 space-y-1.5">
              {PROFILE_TABS.map(([key, item, icon]) => (
                <a key={key} href={`/profile?tab=${key}`} className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-bold ${tab === key ? "bg-[#eef5ff] text-[#096cff]" : "text-[#5a6484] hover:bg-[#f5f8ff]"}`}><Icon name={icon} className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} /> {item}</a>
              ))}
            </nav>
          </div>
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
              className="w-full"
            >
              Invite Friends
            </Button>
          </div>
          <div className="rounded-[12px] bg-[#f4f8ff] p-5">
            <h3 className="font-black">Need help?</h3>
            <p className="mt-2 text-sm font-semibold">Our support team is here for you.</p>
            <a href="/contact" className="mt-4 block font-black text-[#1678ff]">Contact Support →</a>
          </div>
        </aside>
        <section>
          {tab === "overview" && (
          <>
          <div className="grid items-center gap-5 rounded-[14px] border border-[#e7ebf6] bg-white p-6 shadow-card lg:grid-cols-[120px_1fr_235px]">
            <img src={`${import.meta.env.BASE_URL}assets/crops/baby-profile.png`} alt="" className="h-24 w-24 rounded-full object-cover ring-4 ring-white shadow-soft" />
            <div>
              <h1 className="text-[30px] font-black">{child?.name ?? "Your child"}</h1>
              {child && <p className="mt-1.5 text-base font-semibold">{formatChildAge(child.date_of_birth)}</p>}
              {child && child.interests.length > 0 && (
                <>
                  <p className="mt-4 flex items-center gap-2 font-bold"><Icon name="heart" className="h-4 w-4 text-[#1678ff]" /> Interests</p>
                  <p className="mt-2 max-w-[200px] text-sm font-semibold capitalize leading-6">{child.interests.map((i) => i.replace(/-/g, " ")).join(", ")}</p>
                </>
              )}
              <Button href="/onboarding" variant="outline" className="mt-6"><Icon name="pen" className="h-4 w-4" /> Edit Profile</Button>
            </div>
            <div className="rounded-[10px] bg-[#f3f7ff] p-5">
              <h2 className="mb-4 text-lg font-black">{child ? `${child.name}'s Journey` : "Journey"}</h2>
              {[
                [`${journey?.classes_attended ?? 0} Classes Attended`, "calendar"],
                [`${journey?.venues_explored ?? 0} Venues Explored`, "pin"],
                [`${journey?.hours_of_learning ?? 0} Hours of Learning`, "clock"],
              ].map(([item, icon]) => (
                <p key={item} className="mb-4 flex items-center gap-2 text-base font-black text-[#0d62e8]"><Icon name={icon} className="h-4 w-4" /> <span className="text-baby-ink">{item}</span></p>
              ))}
            </div>
          </div>

          <section className="mt-6">
            <SectionTitle action={<a href="/explore" className="font-bold text-[#1678ff]">View all →</a>}>Saved Activities</SectionTitle>
            <div className="grid gap-4 md:grid-cols-3">
              {favs.slice(0, 3).map((activity) => <ActivityCard key={activity.id} activity={activity} compact />)}
              {favs.length === 0 && <p className="font-semibold text-[#68718f]">Nothing saved yet — tap the heart on any activity.</p>}
            </div>
          </section>

          <section className="mt-6">
            <SectionTitle action={<a href="/matches" className="font-bold text-[#1678ff]">See all matches →</a>}>Recommended for you</SectionTitle>
            <div className="grid gap-4 md:grid-cols-3">
              {recs.slice(0, 3).map((r) => r.activity && <ActivityCard key={r.id} activity={toCard(r.activity)} compact />)}
              {recs.length === 0 && <p className="font-semibold text-[#68718f]">Recommendations appear once your child profile is complete.</p>}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="mb-3 text-[22px] font-black">Quick Access</h2>
            <div className="grid gap-3 md:grid-cols-4">
              {[
                { label: "My Bookings", icon: "calendar", href: "/profile?tab=bookings", copy: "Manage your classes" },
                { label: "Favorites", icon: "heart", href: "/profile?tab=favorites", copy: "Activities you've saved" },
                { label: "Reviews", icon: "star", href: "/profile?tab=reviews", copy: "Share your experience" },
                { label: "Explore Nearby", icon: "pin", href: "/explore", copy: "Discover activities near you" },
              ].map((t) => <CategoryTile key={t.label} icon={t.icon} label={t.label} copy={t.copy} href={t.href} />)}
            </div>
          </section>
          </>
          )}

          {tab === "children" && (
            <div>
              <h1 className="text-[26px] font-black">My Children</h1>
              {children.length === 0 ? (
                <EmptyPanel icon="people" copy="No child profile yet — add one to get personalised matches." cta="Add a child" href="/onboarding" />
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {children.map((c) => (
                    <div key={c.id} className="rounded-[14px] border border-[#e7ebf6] bg-white p-5 shadow-card">
                      <div className="flex items-center gap-4">
                        <img src={`${import.meta.env.BASE_URL}assets/crops/baby-profile.png`} alt="" className="h-16 w-16 rounded-full object-cover ring-4 ring-white shadow-soft" />
                        <div><h3 className="font-black">{c.name}</h3><p className="text-sm font-semibold text-[#59658d]">{formatChildAge(c.date_of_birth)}</p></div>
                      </div>
                      {c.interests.length > 0 && (
                        <p className="mt-3 text-sm font-semibold capitalize leading-6 text-[#4a5685]"><span className="font-black text-baby-ink">Interests:</span> {c.interests.map((i) => i.replace(/-/g, " ")).join(", ")}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <Button href="/onboarding" variant="outline" className="mt-5"><Icon name="pen" className="h-4 w-4" /> Add or edit a child</Button>
            </div>
          )}

          {tab === "bookings" && (
            <div>
              <h1 className="mb-1 text-[26px] font-black">Bookings</h1>
              <BookingList items={bookings} emptyCopy="You haven't booked any classes yet." />
            </div>
          )}

          {tab === "attended" && (
            <div>
              <h1 className="mb-1 text-[26px] font-black">Attended Classes</h1>
              <BookingList items={attended} emptyCopy="No attended classes yet — they'll appear here after you go." />
            </div>
          )}

          {tab === "packages" && (
            <div>
              <h1 className="text-[26px] font-black">Packages</h1>
              <p className="mt-1 text-sm font-semibold text-[#59658d]">Class packs you've purchased — each booking with that provider can use a credit.</p>
              {packages.length === 0 ? (
                <EmptyPanel icon="store" copy="No packages yet. Providers offering class packs show a 'Buy pack' option on their class pages." cta="Browse activities" href="/explore" />
              ) : (
                <div className="mt-4 space-y-3">
                  {packages.map((p) => (
                    <div key={p.id} className="flex items-center gap-4 rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                      <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#eef5ff] text-baby-blue"><Icon name="store" className="h-6 w-6" /></span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-black">{p.name}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">{p.provider}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-black text-baby-blue">{p.remaining}<span className="text-sm text-[#9aa4c2]">/{p.total}</span></p>
                        <p className="text-xs font-bold text-[#9aa4c2]">credits left</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "makeup" && (
            <div>
              <h1 className="text-[26px] font-black">Make-up Tokens</h1>
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

          {tab === "favorites" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Favorites</h1>
              {favs.length === 0 ? (
                <EmptyPanel icon="heart" copy="Nothing saved yet — tap the heart on any activity." cta="Browse activities" href="/explore" />
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {favs.map((activity) => <ActivityCard key={activity.id} activity={activity} compact />)}
                </div>
              )}

              {savedProviders.length > 0 && (
                <div className="mt-8">
                  <h2 className="mb-3 text-xl font-black">Saved providers</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {savedProviders.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 rounded-[12px] border border-[#e7ebf6] bg-white p-4 shadow-card">
                        <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-[#eef5ff] text-baby-blue"><Icon name="store" className="h-5 w-5" /></span>
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
                        <a href={r.slug ? `/activity?slug=${r.slug}` : "/explore"} className="font-black hover:text-baby-blue">{r.title}</a>
                        <span className="flex gap-0.5 text-[#ffb71b]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-4 w-4 fill-current" />)}</span>
                      </div>
                      {r.comment && <p className="mt-1.5 font-semibold text-[#34406f]">{r.comment}</p>}
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
                    <div key={n.id} className={`rounded-[12px] border p-4 shadow-card ${n.read_at ? "border-[#e7ebf6] bg-white" : "border-[#cfe2ff] bg-[#f4f9ff]"}`}>
                      <div className="flex items-start gap-2">
                        {!n.read_at && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-baby-blue" />}
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
                      <Icon name={billingPlan?.plan === "plus" ? "star" : "heart"} className="h-5 w-5 text-baby-blue" />
                      {billingPlan?.plan === "plus" ? "BabyBrain Plus" : "Free"}
                      {billingPlan?.status === "trialing" && (
                        <span className="rounded-full bg-[#eef5ff] px-2 py-0.5 text-xs font-bold text-baby-blue">Free trial</span>
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
                    <a href="/terms" className="text-baby-blue underline">View terms</a>
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
                  <Button href="/onboarding" variant="outline"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
                  <Button href="/forgot-password" variant="outline"><Icon name="lock" className="h-4 w-4" /> Change password</Button>
                  <Button type="button" variant="soft" onClick={() => signOut()}>Sign out</Button>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </PageShell>
  );
}

function BookingList({ items, emptyCopy }: { items: BookingItem[]; emptyCopy: string }) {
  if (items.length === 0) return <EmptyPanel icon="calendar" copy={emptyCopy} cta="Browse activities" href="/explore" />;
  return (
    <div className="mt-4 space-y-3">
      {items.map((b) => (
        <a
          key={b.id}
          href={b.slug ? `/activity?slug=${b.slug}` : "/explore"}
          className="flex items-center gap-4 rounded-[12px] border border-[#e7ebf6] bg-white p-3 shadow-card transition hover:border-baby-blue"
        >
          <img src={b.image} alt="" className="h-16 w-16 flex-shrink-0 rounded-[10px] object-cover" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-black">{b.title}</h3>
            {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
          </div>
          {b.startsAt && b.status !== "cancelled" && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                downloadBookingIcs({ id: b.id, title: b.title, startsAt: b.startsAt!, endsAt: b.endsAt, venue: b.venue });
              }}
              className="hidden items-center gap-1 rounded-[9px] border border-[#dbe4f6] px-3 py-1.5 text-xs font-bold text-[#2b7cff] hover:bg-[#f4f9ff] sm:flex"
              title="Add to calendar"
            >
              <Icon name="calendar" className="h-3.5 w-3.5" /> Add to calendar
            </button>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${bookingStatusStyle(b.status)}`}>{b.status}</span>
        </a>
      ))}
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
const SUPPORT_PHONE = "+65 9123 4567"; // TODO: replace with the real BabyBrain support number
const phoneDigits = (p: string) => p.replace(/[^\d]/g, "");

function ContactPage() {
  const { session } = useAuth();
  const [support, setSupport] = useState(false);
  const openSupport = () => {
    if (!session) { window.location.href = "/login"; return; }
    setSupport(true);
  };
  return (
    <>
    {support && <SupportChat onClose={() => setSupport(false)} />}
    <PageShell active="/contact">
      <main className="mx-auto max-w-[1024px] px-6 py-8">
        <section className="grid items-center gap-7 md:grid-cols-[1fr_420px]">
          <div>
            <p className="mb-5 flex items-center gap-2 text-lg font-black text-baby-blue">We're here to help! <Icon name="heart" className="h-5 w-5 fill-current" /></p>
            <h1 className="text-[40px] font-black leading-tight">How can our team support you today?</h1>
            <p className="mt-5 text-lg font-semibold leading-8 text-[#68718f]">Have a question, feedback, or need assistance? Our team is happy to help.</p>
          </div>
          <div className="relative">
            <div className="absolute left-4 top-16 rounded-[16px] bg-white p-5 font-semibold leading-7 shadow-soft">We typically<br />respond within<br />our working hours. <Icon name="heart" className="inline h-4 w-4 fill-current text-baby-blue" /></div>
            <img src={`${import.meta.env.BASE_URL}assets/crops/baby-character.png`} alt="" className="ml-auto h-[280px] object-contain" />
          </div>
        </section>

        <section className="mt-8">
          <SectionTitle>Get in touch</SectionTitle>
          <div className="grid gap-5 md:grid-cols-4">
            {[
              { icon: "pen", title: "Message us", tag: "Recommended", copy: "Chat with our team in real time — we'd love your questions, thoughts or feedback.", label: "Start a chat", variant: "pink", onClick: openSupport },
              { icon: "mail", title: "Email us", tag: "", copy: "Send us an email and we'll get back to you.", label: "Email us", variant: "outline", href: `mailto:${SUPPORT_EMAIL}` },
              { icon: "phone", title: "Call us", tag: "", copy: "Speak with our friendly support team.", label: SUPPORT_PHONE, variant: "outline", href: `tel:+${phoneDigits(SUPPORT_PHONE)}` },
              { icon: "whatsapp", title: "WhatsApp us", tag: "", copy: "Message us on WhatsApp for quick help.", label: "Chat on WhatsApp", variant: "outline", href: `https://wa.me/${phoneDigits(SUPPORT_PHONE)}` },
            ].map((c) => (
              <article key={c.title} className="rounded-[16px] border border-[#ecdfe6] bg-white/70 p-5 text-center shadow-card">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#fff0f5] to-[#eef8ff] text-baby-pink"><Icon name={c.icon} className="h-9 w-9" /></div>
                <h3 className="text-xl font-black">{c.title} {c.tag && <span className="rounded-full bg-[#ffe4ef] px-2 py-1 text-[10px] text-baby-pink">{c.tag}</span>}</h3>
                <p className="my-5 text-sm font-semibold leading-6 text-[#28345f]">{c.copy}</p>
                <Button variant={c.variant === "pink" ? "pink" : "outline"} className="w-full" href={c.href} onClick={c.onClick}>{c.label}</Button>
                <p className="mt-4 text-sm font-semibold leading-6">We'll read every message and get back to you.</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-9">
          <SectionTitle action={<a href="/contact" className="font-bold text-[#1678ff]">View all FAQs →</a>}>Frequently asked questions</SectionTitle>
          <div className="overflow-hidden rounded-[16px] border border-[#e8ecf6] bg-white">
            {["How does BabyBrain recommend classes for my child?", "How do I book a class?", "Can I cancel or reschedule a booking?", "Are the classes on BabyBrain safe and suitable for my child?", "How do I know if a class is right for my child's age?", "Is payment made on BabyBrain?"].map((question) => (
              <details key={question} className="border-b border-[#eef1f7] px-6 py-4">
                <summary className="cursor-pointer list-none font-bold">Q&nbsp;&nbsp; {question} <span className="float-right">⌄</span></summary>
                <p className="mt-3 text-sm font-semibold text-[#59658b]">BabyBrain keeps recommendations simple, clear and parent-friendly.</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-7 grid items-center gap-6 rounded-[18px] bg-gradient-to-r from-[#fff3fb] to-[#f2edff] p-6 md:grid-cols-[230px_1fr_260px]">
          <img src={`${import.meta.env.BASE_URL}assets/crops/envelope-cta.png`} alt="" className="h-32 object-contain" />
          <div>
            <h2 className="text-2xl font-black">Still need help?</h2>
            <p className="mt-2 text-lg font-semibold leading-8">Can't find what you're looking for? Send us a message and we'll get back to you soon.</p>
          </div>
          <Button size="lg" onClick={openSupport}><Icon name="mail" className="h-5 w-5" /> Send us a message</Button>
        </section>
      </main>
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
              className={billing === "monthly" ? "rounded-full bg-baby-blue text-white" : "text-[#59658d]"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={billing === "annual" ? "rounded-full bg-baby-blue text-white" : "text-[#59658d]"}
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
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#eef5ff] text-baby-blue">
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
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-baby-blue text-baby-blue">
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
          <article className="relative rounded-[18px] border border-baby-blue bg-white p-6 shadow-card ring-1 ring-baby-blue/20">
            <span className="absolute left-1/2 top-[-15px] -translate-x-1/2 rounded-full bg-baby-blue px-8 py-2 text-sm font-black text-white">
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
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-baby-blue text-baby-blue">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
            <p className="mt-5 rounded-[10px] bg-[#f3f7ff] px-4 py-3 text-center text-sm font-black text-baby-blue">
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
              <a href="/terms" className="text-baby-blue underline">Terms &amp; Conditions</a>.
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
              <Icon name={icon} className="h-8 w-8 text-baby-blue" />
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
        <img src={`${import.meta.env.BASE_URL}assets/crops/logo-mascot.png`} alt="" className="mx-auto h-24 w-24" />
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

function BookingPage() {
  const { activity, sessions, loading } = useActivityDetail(getParam("slug"));
  const { session: auth, children: kids } = useAuth();
  const redeemToken = getParam("token");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [packageCredit, setPackageCredit] = useState<{ id: string; remaining: number } | null>(null);

  useEffect(() => {
    if (!auth || !activity?.provider_id) return;
    supabase
      .from("package_purchases")
      .select("id, credits_remaining")
      .eq("provider_id", activity.provider_id)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at")
      .limit(1)
      .then(({ data }) => {
        const r = data?.[0];
        setPackageCredit(r ? { id: r.id, remaining: r.credits_remaining } : null);
      });
  }, [auth, activity?.provider_id]);

  // Group upcoming sessions by date so the user picks a date, then a time.
  const byDate: Record<string, ActivitySession[]> = {};
  sessions.forEach((s) => {
    (byDate[sgDay(s.starts_at)] ||= []).push(s);
  });
  const dates = Object.keys(byDate);

  useEffect(() => {
    if (dates.length && !dateKey) setDateKey(dates[0]);
  }, [dates, dateKey]);

  const times = dateKey ? byDate[dateKey] ?? [] : [];
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
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
        .insert({ user_id: auth.user.id, session_id: sessionId, child_id: kids[0]?.id ?? null })
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
      when: selected ? sgDateTime(selected.starts_at) : "",
      status: (data as string | null) ?? "confirmed",
      start: selected?.starts_at ?? "",
      end: selected?.ends_at ?? "",
      venue: activity?.address ?? "",
    });
    window.location.href = `/booked?${q.toString()}`;
  }

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
          Class not found. <a href="/explore" className="text-baby-blue">Browse activities →</a>
        </main>
      </PageShell>
    );
  }

  const img = activity.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/detail-hero.png`;
  const ageText = formatAgeRange(activity.age_min_months, activity.age_max_months);

  return (
    <PageShell active="/book">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><a href={`/activity?slug=${activity.slug}`}>{activity.title}</a><span>›</span><span className="text-baby-blue">Book</span></div>
        <section className="rounded-[18px] border border-[#e7ebf6] bg-white shadow-card">
          <header className="grid items-center gap-5 border-b border-[#eef1f7] p-6 md:grid-cols-[90px_1fr_240px]">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-blue text-white"><Icon name="calendar" className="h-10 w-10" /></span>
            <div><h1 className="text-[34px] font-black">Book your class</h1><p className="text-lg font-semibold">Choose your preferred date and time.</p></div>
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
                  <p className="rounded-[12px] bg-[#f8fbff] p-4 font-semibold text-[#5a6690]">No upcoming sessions scheduled yet — try “Enquire Now” on the class page to ask the provider.</p>
                ) : (
                  <>
                    <section>
                      <h3 className="mb-4 text-xl font-black">1. Choose a date</h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                        {dates.map((d) => (
                          <button key={d} onClick={() => { setDateKey(d); setSessionId(null); }} className={`rounded-[10px] border px-3 py-4 text-sm font-bold ${d === dateKey ? "border-baby-blue bg-[#f3f7ff] text-baby-blue" : "border-[#dfe5f2] bg-white"}`}>{d}<span className="mt-2 block text-xs font-semibold text-[#7a86a8]">{byDate[d].length} {byDate[d].length === 1 ? "time" : "times"}</span></button>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h3 className="mb-4 text-xl font-black">2. Choose a time</h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                        {times.map((s) => (
                          <button key={s.id} onClick={() => setSessionId(s.id)} className={`rounded-[10px] border px-3 py-4 font-bold ${s.id === sessionId ? "border-baby-blue bg-[#f3f7ff] text-baby-blue" : "border-[#dfe5f2] bg-white"}`}>{sgTime(s.starts_at)}<span className="mt-2 block text-xs font-semibold text-[#7a86a8]">{s.capacity != null ? `${s.capacity} spots` : "Available"}</span></button>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h3 className="mb-2 text-xl font-black">3. Number of children</h3>
                      <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#dfe5f2] text-xl font-black">
                        <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} className="h-12 w-12">-</button>
                        <span className="grid h-12 w-14 place-items-center">{count}</span>
                        <button type="button" onClick={() => setCount((c) => Math.min(6, c + 1))} className="h-12 w-12">+</button>
                      </div>
                    </section>
                  </>
                )}
              </div>
            </section>

            <aside className="rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
              <h2 className="text-xl font-black">Booking Summary</h2>
              <div className="mt-5 flex gap-4">
                <img src={img} alt="" className="h-24 w-28 rounded-[10px] object-cover" />
                <div><h3 className="font-black">{activity.title}</h3><p className="mt-1 text-sm font-semibold">{ageText}</p>{activity.category_name && <span className="mt-2 inline-block rounded-full bg-[#f3f7ff] px-3 py-1 text-xs font-bold text-baby-blue">{activity.category_name}</span>}</div>
              </div>
              <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 text-baby-lilac" /> {selected ? sgDateTime(selected.starts_at) : "Select a date & time"}</p>
                {activity.address && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 text-baby-lilac" /> {activity.address}</p>}
                <p className="flex gap-2"><Icon name="user" className="h-5 w-5 text-baby-lilac" /> {count} {count === 1 ? "child" : "children"}, {ageText}</p>
              </div>
              <div className="my-5 border-t border-[#eef1f7]" />
              <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-blue">{total != null ? `$${total.toFixed(2)}` : "Price on enquiry"}</span></p>
              <div className="mt-5 rounded-[12px] bg-[#f8fbff] p-4"><h3 className="font-black">Why parents love us</h3>{["Trusted by thousands of parents", "Safe & engaging environments", "Expert-led activities", "Hassle-free booking"].map((item) => <p key={item} className="mt-3 flex gap-2 text-sm font-semibold"><Icon name="check" className="h-4 w-4 text-baby-blue" /> {item}</p>)}</div>
            </aside>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#fff0f7] text-baby-pink"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total Amount</span><strong className="text-3xl">{total != null ? `$${total.toFixed(2)}` : "—"}</strong></p></div>
            {err && <p className="mt-3 text-sm font-bold text-baby-pink">{err}</p>}
          </div>
          {redeemToken && (
            <p className="mb-3 rounded-[10px] bg-[#fff4d6] px-4 py-2.5 text-sm font-bold text-[#8a6d1a]"><Icon name="gift" className="mr-1 inline h-4 w-4" /> Using a make-up token — this class is on the house.</p>
          )}
          {packageCredit && !redeemToken && (
            <Button type="button" variant="outline" size="lg" onClick={payWithPackage} className={`mb-3 w-full justify-center ${busy || !sessionId ? "opacity-60" : ""}`}>
              <Icon name="store" className="h-5 w-5" /> Use a package credit ({packageCredit.remaining} left)
            </Button>
          )}
          <Button type="button" size="lg" onClick={pay} className={busy || !sessionId ? "opacity-60" : ""}>
            <Icon name="lock" className="h-5 w-5" /> {busy ? "Confirming…" : !auth ? "Log in to book" : redeemToken ? "Confirm with make-up token" : total != null && total > 0 ? `Pay $${total.toFixed(2)}` : "Confirm Booking"}
          </Button>
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
  const title = getParam("title") || "Tiny Tunes: Music & Movement";
  const when = getParam("when") || "";
  const status = getParam("status") || "confirmed";
  const start = getParam("start");
  const end = getParam("end");
  const venue = getParam("venue") || "";
  const waitlisted = status === "waitlisted";
  return (
    <PageShell active="/booked" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Class Details</span><span>›</span><span className="text-baby-blue">Book</span></div>
        <section className="grid items-center gap-5 rounded-[18px] border border-[#e7ebf6] bg-gradient-to-r from-[#fff0f7] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-blue text-white"><Icon name="check" className="h-12 w-12" /></span>
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
                {[["bell", "Arrive 10 mins early"], ["shoe", "Dress comfortably"], ["bottle", "Bring essentials"]].map(([icon, title]) => <div key={title} className="text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#fff0f7] text-baby-blue"><Icon name={icon} className="h-8 w-8" /></span><h3 className="mt-3 font-black">{title}</h3><p className="mt-2 text-sm font-semibold text-[#59658d]">Helpful notes for a smooth class experience.</p></div>)}
              </div>
            </article>
          </div>
          <aside className="space-y-5">
            <article className="rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Class</span><span className="text-right">{title}</span></p>{when && <p className="flex justify-between"><span>When</span><span className="text-right">{when}</span></p>}<p className="flex justify-between"><span>Status</span><strong className={waitlisted ? "text-amber-600" : "text-green-600"}>{waitlisted ? "Waitlisted" : "Confirmed"}</strong></p></div>
              <p className={`mt-5 rounded-[12px] p-4 font-semibold ${waitlisted ? "bg-amber-50 text-amber-700" : "bg-[#eefbf1] text-green-700"}`}><Icon name="check" className="mr-2 inline h-5 w-5" /> {waitlisted ? "Added to the waitlist" : "Booking confirmed"}</p>
              <Button href="/profile?tab=bookings" className="mt-5 w-full">View My Bookings</Button>
              {start && (
                <Button
                  variant="outline"
                  type="button"
                  className="mt-3 w-full"
                  onClick={() => downloadBookingIcs({ id: `${start}-${title}`, title, startsAt: start, endsAt: end || null, venue })}
                >
                  <Icon name="calendar" className="h-4 w-4" /> Add to Calendar
                </Button>
              )}
            </article>
            <article className="rounded-[16px] bg-[#f4ecff] p-6"><h2 className="text-xl font-black text-baby-lilac">Need help?</h2><p className="mt-4 font-semibold">Contact Support if you have any questions.</p></article>
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
        <section className="grid items-center gap-8 md:grid-cols-[1fr_520px]">
          <div>
            <h1 className="text-[54px] font-black leading-tight">About <span className="text-baby-blue">BabyBrain</span></h1>
            <p className="mt-5 text-2xl font-black leading-tight">Making it easier for parents to find activities that help children learn, play and grow.</p>
            <p className="mt-5 max-w-[420px] font-semibold leading-7 text-[#3f4b78]">BabyBrain was created to take the guesswork out of finding the right classes and experiences for your child. We bring everything together in one place, so you can spend less time searching and more time making memories.</p>
            <Button href="/explore" className="mt-6">Explore Activities →</Button>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/about-family.png`} alt="Founder with children" className="h-[380px] w-full object-contain" />
        </section>
        <section className="mt-6 grid items-center gap-6 rounded-[18px] bg-gradient-to-r from-[#fff0f7] to-white p-7 md:grid-cols-[360px_1fr]">
          <img src={`${import.meta.env.BASE_URL}assets/crops/founder-katie.png`} alt="Katie Crowson" className="h-72 object-contain" />
          <div><p className="font-black text-baby-blue">Meet Our Founder</p><h2 className="text-[34px] font-black">Katie Crowson</h2><p className="mt-3 font-semibold leading-7 text-[#3f4b78]">Hi! I'm Katie, a mom, entrepreneur and the founder of BabyBrain. After becoming a mom, I quickly realized how overwhelming it can be to find the right activities for my child. BabyBrain makes that journey easier for families like mine.</p><p className="mt-4 flex gap-2 font-black"><Icon name="heart" className="h-5 w-5 text-baby-blue" /> Made by a mom, for parents like you.</p></div>
        </section>
        <section className="mt-5 grid items-center gap-6 rounded-[18px] bg-[#fffaf0] p-7 md:grid-cols-[220px_1fr_160px]">
          <img src={`${import.meta.env.BASE_URL}assets/crops/mission-target.png`} alt="" className="h-32 object-contain" />
          <div><p className="font-black text-baby-blue">Our Mission</p><h2 className="mt-2 text-xl font-black">To make it easier for parents to find meaningful experiences that help children learn, play and grow.</h2><p className="mt-3 font-semibold text-[#3f4b78]">We believe every child deserves the opportunity to explore their interests and develop new skills in a safe and supportive environment.</p></div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/mission-brain.png`} alt="" className="h-28 object-contain" />
        </section>
        <section className="mt-7 text-center">
          <h2 className="text-2xl font-black">Why We Built BabyBrain</h2>
          <p className="font-semibold text-[#59658d]">Parents told us they faced the same challenges:</p>
          <div className="mt-5 grid gap-4 md:grid-cols-5">
            {[["search", "Too many options"], ["mail", "Information scattered"], ["people", "Age uncertainty"], ["target", "No easy comparison"], ["calendar", "Time-consuming planning"]].map(([icon, text]) => <div key={text} className="text-center"><Icon name={icon} className="mx-auto h-10 w-10 text-baby-blue" /><p className="mt-3 text-sm font-black">{text}</p></div>)}
          </div>
        </section>
        <section className="mt-7 rounded-[18px] bg-[#eef8ff] p-7">
          <div className="grid items-center gap-6 md:grid-cols-[180px_1fr_320px]">
            <BrandBlock />
            <div><h2 className="text-[28px] font-black">Ready to discover activities your child will love?</h2><p className="mt-2 font-semibold text-[#3f4b78]">Join parents using BabyBrain to find classes, events and play experiences across Singapore.</p></div>
            <div className="flex gap-3"><Button href="/explore">Explore Activities</Button><Button href="/onboarding" variant="outline">Sign Up</Button></div>
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function BrandBlock() {
  return (
    <div className="flex items-center gap-2">
      <img src={`${import.meta.env.BASE_URL}assets/crops/logo-mascot.png`} alt="" className="h-14 w-14" />
      <div className="text-2xl font-black"><span className="text-baby-pink">Baby</span><span className="text-baby-blue">Brain</span></div>
    </div>
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
    window.location.href = "/profile";
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-6 py-12">
        <div className="rounded-[18px] border border-[#e8ecf8] bg-white p-8 shadow-card">
          <h1 className="text-2xl font-black">Welcome back <span>👋</span></h1>
          <p className="mt-1 font-semibold text-[#5a6690]">Log in to see activities matched for your child.</p>
          {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-black">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 font-semibold" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-black">Password</label>
                <a href="/forgot-password" className="text-xs font-bold text-baby-blue hover:underline">Forgot password?</a>
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 font-semibold" />
            </div>
            <Button type="submit" className="w-full justify-center">{busy ? "Signing in…" : "Log In"}</Button>
          </form>
          <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
            New here? <a href="/onboarding" className="font-black text-baby-blue">Create a profile</a>
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
        <div className="rounded-[18px] border border-[#e8ecf8] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Reset your password</h1>
          {sent ? (
            <div className="mt-3">
              <p className="rounded-[10px] bg-[#eefbf1] px-3 py-3 text-sm font-semibold text-green-700">
                If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
              </p>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                <a href="/login" className="font-black text-baby-blue">← Back to log in</a>
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Enter your email and we'll send you a link to set a new password.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 font-semibold" />
                </div>
                <Button type="submit" className="w-full justify-center">{busy ? "Sending…" : "Send reset link"}</Button>
              </form>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                Remembered it? <a href="/login" className="font-black text-baby-blue">Log in</a>
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
        <div className="rounded-[18px] border border-[#e8ecf8] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Set a new password</h1>
          {done ? (
            <p className="mt-3 rounded-[10px] bg-[#eefbf1] px-3 py-3 text-sm font-semibold text-green-700">
              Password updated. Taking you to your profile…
            </p>
          ) : !ready ? (
            <p className="mt-3 rounded-[10px] bg-[#fff7e6] px-3 py-3 text-sm font-semibold text-[#8a6d1a]">
              This page only works from the reset link in your email. Open that link, or <a href="/forgot-password" className="font-black text-baby-blue">request a new one</a>.
            </p>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Choose a new password for your account.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#ffe9ef] px-3 py-2 text-sm font-bold text-[#b00040]">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">New password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 font-semibold" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-black">Confirm password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#dbe4f6] px-3 font-semibold" />
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
  if (pathname === "/contact") return <ContactPage />;
  if (pathname === "/terms") return <TermsPage />;
  // Home: signed-in parents land on their personalised dashboard (matched
  // classes for their child), not the marketing page.
  if (!loading && session) return <MatchesPage active="/" />;
  return <HomePage />;
}

export default App;
