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
  useRecommendations,
  useJourney,
  toCard,
} from "./lib/data";
import { supabase } from "./lib/supabase";
import { formatChildAge } from "./lib/database.types";
import { EnquiryChat } from "./components/EnquiryChat";

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
                ["1", "pen", "Tell us about your child", "Share a few details about your child's age, interests and what you're looking for."],
                ["2", "search", "Explore activities", "Browse curated activities and play spaces that match your preferences."],
                ["3", "calendar", "Plan and book", "Choose what works for you and book directly with the provider."],
              ].map(([step, icon, title, copy]) => (
                <article key={title} className="text-center">
                  <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-baby-pink text-base font-black text-white">
                    {step}
                  </span>
                  <div className="mx-auto my-2 grid h-16 w-16 place-items-center rounded-[18px] bg-[#f4ecff] text-baby-lilac">
                    <Icon name={icon} className="h-10 w-10" />
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

function MatchesPage() {
  const { session, profile, children, loading } = useAuth();
  const { data: recsByChild, loading: recsLoading } = useRecommendations(children);

  if (!loading && !session) {
    return (
      <PageShell active="/matches">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Log in to see your matches.</p>
          <Button href="/login" className="mt-4">Log In</Button>
        </main>
      </PageShell>
    );
  }
  if (!loading && children.length === 0) {
    return (
      <PageShell active="/matches">
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
    <PageShell active="/matches">
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

function ExplorePage() {
  const { activities, loading } = useActivities({ limit: 24 });
  return (
    <PageShell active="/explore">
      <main className="mx-auto max-w-[1180px] px-6 py-5">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[34px] font-black text-baby-lilac">Explore Activities <Icon name="spark" className="inline h-6 w-6 text-baby-blue" /></h1>
            <p className="mt-1 text-lg font-semibold text-[#4a5680]">Browse activities across Singapore.</p>
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/detail-thumb-5.png`} alt="" className="hidden h-20 w-[320px] rounded-t-[30px] object-cover opacity-70 md:block" />
        </div>
        <div className="mb-4 grid gap-3 md:grid-cols-5">
          {["Category  All", "Age  All Ages", "Date  Any Date", "Distance  Within 10 km", "Sort by: Most Popular"].map((filter) => (
            <button key={filter} className="flex h-10 items-center justify-between rounded-[10px] border border-[#e6e6ef] bg-white px-3.5 text-[13px] font-bold shadow-card">
              {filter} <span>⌄</span>
            </button>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-[568px_1fr]">
          <section>
            <p className="mb-3 text-sm font-black">{loading ? "Loading…" : `${activities.length} activities found`}</p>
            <div className="space-y-2.5">
              {activities.map((activity) => (
                <ActivityRow key={activity.title} activity={activity} />
              ))}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              {["‹", "1", "2", "3", "4", "5", "...", "11", "›"].map((item) => (
                <button key={item} className={`h-9 min-w-9 rounded-[8px] border px-3 text-sm font-bold ${item === "1" ? "bg-[#e9f3ff] text-[#197bff]" : "bg-white"}`}>{item}</button>
              ))}
            </div>
          </section>
          <section className="rounded-[16px] border border-[#e7ebf6] bg-white p-3 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-baby-lilac">Explore on map</h2>
              <input className="h-9 rounded-[9px] border border-[#e0e6f3] px-3 text-sm font-semibold" placeholder="Search this area" />
            </div>
            <div className="relative overflow-hidden rounded-[12px]">
              <img src={`${import.meta.env.BASE_URL}assets/crops/singapore-map.png`} alt="Singapore activity map" className="h-[395px] w-full object-cover" />
              {activities[0] && (
                <article className="absolute inset-x-4 bottom-4 grid grid-cols-[180px_1fr_40px] items-center gap-4 rounded-[12px] bg-white p-3 shadow-soft">
                  <img src={activities[0].image} alt="" className="h-20 rounded-[9px] object-cover" />
                  <div>
                    <h3 className="font-black">{activities[0].title}</h3>
                    <p className="mt-1 flex items-center gap-1 text-sm font-semibold text-[#556089]"><Icon name="pin" className="h-3.5 w-3.5 text-baby-pink" /> {activities[0].venue}</p>
                    <p className="mt-1 text-sm font-semibold text-[#556089]">{activities[0].age} · {activities[0].date} · {activities[0].time}</p>
                  </div>
                  <a href="/activity" className="text-4xl">›</a>
                </article>
              )}
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

function ActivityDetailPage() {
  const { activity, sessions, reviews, loading } = useActivityDetail(getParam("slug"));
  const fav = useFavorite(activity?.id);
  const { session } = useAuth();
  const [enquiring, setEnquiring] = useState(false);

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
              <p className="text-xl font-black text-baby-lilac">Price on enquiry</p>
            )}
            <Button href="/book" className="mt-4 w-full"><Icon name="calendar" className="h-4 w-4" /> Book a Class</Button>
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
            <Button variant="soft" type="button" onClick={fav.toggle} className="mt-3 w-full text-baby-pink">
              <Icon name="heart" className="h-4 w-4" /> {fav.saved ? "Saved to Favorites" : "Save to Favorites"}
            </Button>
            {enquiring && activity.provider_id && (
              <EnquiryChat
                providerId={activity.provider_id}
                providerName={activity.title}
                onClose={() => setEnquiring(false)}
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

        <section className="mt-5 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
          <h2 className="mb-3 text-xl font-black">Reviews ({activity.rating_count})</h2>
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

function ProfilePage() {
  const { session, profile, children, loading } = useAuth();
  const child = children[0];
  const journey = useJourney(child?.id);
  const { data: recsByChild } = useRecommendations(children);
  const [favs, setFavs] = useState<ReturnType<typeof toCard>[]>([]);

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

  return (
    <PageShell active="/profile">
      <main className="mx-auto grid max-w-[1122px] gap-5 px-6 py-5 lg:grid-cols-[235px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-[12px] border border-[#e7ebf6] bg-white p-5 shadow-card">
            <div className="flex items-center gap-4">
              <img src={`${import.meta.env.BASE_URL}assets/crops/parent-avatar.png`} alt="" className="h-20 w-20 rounded-full object-cover" />
              <div><h2 className="font-black">{parentName}</h2>{child && <p className="font-semibold">{child.name} · {formatChildAge(child.date_of_birth)}</p>}</div>
            </div>
            <nav className="mt-5 space-y-1.5">
              {[
                ["Overview", "home"],
                ["My Children", "people"],
                ["Bookings", "calendar"],
                ["Attended Classes", "check"],
                ["Favorites", "heart"],
                ["Reviews", "star"],
                ["Notifications", "bell"],
                ["Settings", "gear"],
              ].map(([item, icon], index) => (
                <a key={item} href="/profile" className={`flex items-center gap-2 rounded-[9px] px-4 py-2.5 font-bold ${index === 0 ? "bg-[#eef5ff] text-[#096cff]" : ""}`}><Icon name={icon} className="h-4 w-4" /> {item}</a>
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
          <div className="grid items-center gap-5 rounded-[14px] border border-[#e7ebf6] bg-white p-6 shadow-card lg:grid-cols-[155px_1fr_235px]">
            <img src={`${import.meta.env.BASE_URL}assets/crops/baby-profile.png`} alt="" className="h-32 w-32 rounded-full object-cover ring-8 ring-white shadow-soft" />
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
                { label: "My Bookings", icon: "calendar", href: "/explore", copy: "Manage your classes" },
                { label: "Favorites", icon: "heart", href: "/explore", copy: "Activities you've saved" },
                { label: "Reviews", icon: "calendar", href: "/explore", copy: "Share your experience" },
                { label: "Explore Nearby", icon: "pin", href: "/explore", copy: "Discover activities near you" },
              ].map((t) => <CategoryTile key={t.label} icon={t.icon} label={t.label} copy={t.copy} href={t.href} />)}
            </div>
          </section>
        </section>
      </main>
    </PageShell>
  );
}

function ContactPage() {
  return (
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
              ["pen", "Send Feedback", "Recommended", "We'd love to hear your thoughts, suggestions or feedback to improve BabyBrain.", "Submit Feedback", "pink"],
              ["mail", "Email us", "", "Send us an email and we'll get back to you.", "Send Email", "outline"],
              ["phone", "Call us", "", "Speak with our friendly support team.", "+65 9123 4567", "outline"],
              ["whatsapp", "WhatsApp us", "", "Message us on WhatsApp for quick help.", "Chat on WhatsApp", "outline"],
            ].map(([icon, title, tag, copy, action, variant]) => (
              <article key={title} className="rounded-[16px] border border-[#ecdfe6] bg-white/70 p-5 text-center shadow-card">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#fff0f5] to-[#eef8ff] text-baby-pink"><Icon name={icon} className="h-9 w-9" /></div>
                <h3 className="text-xl font-black">{title} {tag && <span className="rounded-full bg-[#ffe4ef] px-2 py-1 text-[10px] text-baby-pink">{tag}</span>}</h3>
                <p className="my-5 text-sm font-semibold leading-6 text-[#28345f]">{copy}</p>
                <Button variant={variant === "pink" ? "pink" : "outline"} className="w-full">{action}</Button>
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
          <Button size="lg"><Icon name="mail" className="h-5 w-5" /> Send us a message</Button>
        </section>
      </main>
    </PageShell>
  );
}

function PricingPage() {
  const plans = [
    {
      name: "Free",
      price: "0",
      icon: "heart",
      cta: "Continue Free",
      items: [
        "Browse activities",
        "Book classes",
        "Receive confirmations",
        "Leave reviews",
        "See messages from other parents and providers",
      ],
    },
    {
      name: "Plus",
      price: "6",
      icon: "star",
      cta: "Upgrade to Plus",
      items: [
        "Daily curated recommendations",
        "Calendar reminders & sync",
        "Message parents & providers",
        "Save favourites & activity map",
        "Make-up tokens & package tracking",
      ],
      featured: true,
    },
    {
      name: "Premium",
      price: "10",
      icon: "crown",
      cta: "Upgrade to Premium",
      items: [
        "AI activity planner",
        "Weekly schedule generator",
        "Schedule export",
        "Priority support",
      ],
    },
  ];

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[1120px] px-6 py-8">
        <section className="text-center">
          <Icon name="heart" className="mx-auto h-9 w-9 text-baby-pink" />
          <h1 className="mt-2 text-[36px] font-black leading-tight">
            Choose the plan that's right for your family
          </h1>
          <p className="mt-2 text-lg font-semibold text-[#68718f]">
            Discover, book and enjoy the best activities for your little ones.
          </p>
          <div className="mx-auto mt-5 grid h-11 max-w-[360px] grid-cols-2 rounded-full border border-[#e2e7f4] bg-white p-1 font-black">
            <button className="rounded-full bg-baby-blue text-white">Monthly</button>
            <button className="text-[#59658d]">Annual <span className="text-baby-pink">(Save 20%)</span></button>
          </div>
        </section>
        <section className="mt-7 grid gap-5 lg:grid-cols-3">
          {plans.map((plan) => (
            <article
              key={plan.name}
              className={`relative rounded-[18px] border bg-white p-6 shadow-card ${
                plan.featured ? "border-baby-blue ring-1 ring-baby-blue/20" : "border-[#e7ebf6]"
              }`}
            >
              {plan.featured && (
                <span className="absolute left-1/2 top-[-15px] -translate-x-1/2 rounded-full bg-baby-blue px-8 py-2 text-sm font-black text-white">
                  MOST POPULAR
                </span>
              )}
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#f4ecff] text-baby-lilac">
                <Icon name={plan.icon} className="h-8 w-8" />
              </div>
              <h2 className="mt-4 text-center text-2xl font-black">{plan.name}</h2>
              <p className="mt-2 text-center">
                <span className="text-lg font-black text-[#68718f]">SGD </span>
                <span className="text-[44px] font-black text-baby-lilac">{plan.price}</span>
                {plan.name !== "Free" && <span className="font-bold text-[#68718f]"> /mo</span>}
              </p>
              <div className="my-5 border-t border-[#eef1f7]" />
              <div className="space-y-3">
                {plan.items.map((item) => (
                  <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-baby-blue text-baby-blue">
                      <Icon name="check" className="h-3 w-3" />
                    </span>
                    {item}
                  </p>
                ))}
              </div>
              {plan.name !== "Free" && (
                <p className="mt-5 rounded-[10px] bg-[#f3f7ff] px-4 py-3 text-center text-sm font-black text-baby-blue">
                  First month free for first 500 customers
                </p>
              )}
              <Button href={plan.name === "Free" ? "/" : "/payment"} variant={plan.name === "Free" ? "outline" : "primary"} className="mt-5 w-full">
                {plan.cta}
              </Button>
            </article>
          ))}
        </section>
        <section className="mt-5 grid gap-4 rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card md:grid-cols-3">
          {[
            ["store", "Corporate discounts", "available for bulk packages"],
            ["calendar", "Monthly or annual billing", "Choose the plan that works for you"],
            ["shield", "Cancel anytime", "Monthly plans can be cancelled with 14 days notice"],
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
  return (
    <main className="grid min-h-screen bg-baby-paper text-baby-ink lg:grid-cols-[390px_1fr]">
      <aside className="bg-gradient-to-b from-[#fff0f7] to-white px-8 py-10">
        <a href="/pricing" className="font-black text-baby-ink">←</a>
        <div className="mt-6 text-center">
          <img src={`${import.meta.env.BASE_URL}assets/crops/logo-mascot.png`} alt="" className="mx-auto h-28 w-28" />
          <div className="text-[40px] font-black"><span className="text-baby-pink">Baby</span><span className="text-baby-blue">Brain</span></div>
        </div>
        <h1 className="mt-8 text-2xl font-black">Subscribe to Plus</h1>
        <p className="mt-3 text-[44px] font-black">SGD 6.00 <span className="text-lg font-bold">per month</span></p>
        <p className="mt-6 flex gap-3 font-semibold"><Icon name="gift" className="h-6 w-6 text-baby-pink" /> First month free for first 500 customers. Cancel anytime.</p>
        <section className="mt-8 rounded-[16px] bg-white p-6 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-[#fff0f7] text-baby-pink"><Icon name="star" className="h-7 w-7" /></span>
              <p><strong className="block">Plus Plan</strong><span className="text-[#59658d]">Billed monthly</span></p>
            </div>
            <strong>SGD 6.00</strong>
          </div>
          <div className="my-5 border-t border-[#eef1f7]" />
          <p className="flex justify-between font-bold"><span>Subtotal</span><span>SGD 6.00</span></p>
          <p className="mt-5 flex justify-between font-bold text-green-600"><span>First month free</span><span>- SGD 6.00</span></p>
          <div className="my-5 border-t border-[#eef1f7]" />
          <p className="flex justify-between text-xl font-black"><span>Total today</span><span>SGD 0.00</span></p>
        </section>
        <div className="mt-8 space-y-4">
          {["Full access to Plus features", "Cancel anytime with 14 days notice", "Monthly or annual billing"].map((item) => (
            <p key={item} className="flex gap-3 font-semibold"><Icon name="check" className="h-5 w-5 text-baby-blue" /> {item}</p>
          ))}
        </div>
      </aside>
      <section className="mx-auto w-full max-w-[620px] px-8 py-24">
        <h2 className="text-[32px] font-black">Enter payment details</h2>
        <button className="mt-8 h-16 w-full rounded-[8px] bg-black text-2xl font-black text-white">Apple Pay</button>
        <div className="my-10 flex items-center gap-6 text-center font-semibold text-[#68718f]"><span className="h-px flex-1 bg-[#dfe5f2]" />Or pay with card<span className="h-px flex-1 bg-[#dfe5f2]" /></div>
        <form className="space-y-5">
          {["Email", "Name on card"].map((label) => (
            <label key={label} className="block font-black">{label}<input className="mt-2 h-14 w-full rounded-[10px] border border-[#dfe5f2] px-5 text-lg font-semibold outline-none focus:border-baby-blue" placeholder={label === "Email" ? "name@example.com" : "Full name on card"} /></label>
          ))}
          <label className="block font-black">Card information<input className="mt-2 h-14 w-full rounded-t-[10px] border border-[#dfe5f2] px-5 text-lg font-semibold outline-none focus:border-baby-blue" placeholder="1234 1234 1234 1234" /></label>
          <div className="grid grid-cols-2">
            <input className="h-14 rounded-bl-[10px] border border-t-0 border-[#dfe5f2] px-5 text-lg font-semibold" placeholder="MM / YY" />
            <input className="h-14 rounded-br-[10px] border border-l-0 border-t-0 border-[#dfe5f2] px-5 text-lg font-semibold" placeholder="CVC" />
          </div>
          <label className="block font-black">Country or region<input className="mt-2 h-14 w-full rounded-[10px] border border-[#dfe5f2] px-5 text-lg font-semibold" defaultValue="Singapore" /></label>
          <label className="flex gap-3 rounded-[10px] border border-[#dfe5f2] p-4 font-bold"><input type="checkbox" className="h-5 w-5" /> Securely save my information for 1-click checkout</label>
          <Button href="/pricing" className="w-full text-lg">Start subscription</Button>
        </form>
      </section>
    </main>
  );
}

function BookingPage() {
  return (
    <PageShell active="/book">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Tiny Tunes: Music & Movement</span><span>›</span><span className="text-baby-blue">Book</span></div>
        <section className="rounded-[18px] border border-[#e7ebf6] bg-white shadow-card">
          <header className="grid items-center gap-5 border-b border-[#eef1f7] p-6 md:grid-cols-[90px_1fr_240px]">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-blue text-white"><Icon name="calendar" className="h-10 w-10" /></span>
            <div><h1 className="text-[34px] font-black">Book your class</h1><p className="text-lg font-semibold">Choose your preferred date and time.</p></div>
            <img src={`${import.meta.env.BASE_URL}assets/crops/book-mascot-banner.png`} alt="" className="hidden h-24 object-contain md:block" />
          </header>
          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
            <section>
              <div className="grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={`${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`} alt="Tiny Tunes" className="h-52 w-full rounded-[12px] object-cover" />
                <div>
                  <h2 className="text-xl font-black">Tiny Tunes: Music & Movement</h2>
                  <p className="mt-2 font-semibold">6 months - 3 years</p>
                  <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                    <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 text-baby-lilac" /> Little Steps Playhouse</p>
                    <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 text-baby-lilac" /> 45 minutes per session</p>
                    <p className="flex gap-2"><Icon name="user" className="h-5 w-5 text-baby-lilac" /> Max 12 children per class</p>
                    <p className="flex gap-2"><Icon name="music" className="h-5 w-5 text-baby-lilac" /> Interactive music & movement</p>
                  </div>
                </div>
              </div>
              <BookingChooser />
            </section>
            <BookingSummary />
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#fff0f7] text-baby-pink"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total Amount</span><strong className="text-3xl">$38.00</strong></p></div>
          <Button href="/booked" size="lg"><Icon name="lock" className="h-5 w-5" /> Pay Now</Button>
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

function BookingChooser() {
  return (
    <div className="mt-6 space-y-6 border-t border-[#eef1f7] pt-5">
      <section>
        <h3 className="mb-4 text-xl font-black">1. Choose a date</h3>
        <div className="grid grid-cols-5 gap-3">
          {["Fri 23 May", "Sat 24 May", "Sun 25 May", "Mon 26 May", "Tue 27 May"].map((date, index) => (
            <button key={date} className={`rounded-[10px] border px-3 py-4 text-sm font-bold ${index === 2 ? "border-baby-blue bg-[#f3f7ff] text-baby-blue" : "border-[#dfe5f2] bg-white"}`}>{date}<span className="mt-2 block text-xs">{index === 1 ? "Full" : `${index + 2} spots left`}</span></button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-4 text-xl font-black">2. Choose a time</h3>
        <div className="grid grid-cols-5 gap-3">
          {["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "3:00 PM"].map((time, index) => (
            <button key={time} className={`rounded-[10px] border px-3 py-4 font-bold ${index === 1 ? "border-baby-blue bg-[#f3f7ff] text-baby-blue" : "border-[#dfe5f2] bg-white"}`}>{time}<span className="mt-2 block text-xs">{index + 6} spots left</span></button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-xl font-black">3. Number of children</h3>
        <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#dfe5f2] text-xl font-black"><button className="h-12 w-12">-</button><span className="grid h-12 w-14 place-items-center">1</span><button className="h-12 w-12">+</button></div>
      </section>
    </div>
  );
}

function BookingSummary() {
  return (
    <aside className="rounded-[16px] border border-[#e7ebf6] bg-white p-5 shadow-card">
      <h2 className="text-xl font-black">Booking Summary</h2>
      <div className="mt-5 flex gap-4">
        <img src={`${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`} alt="" className="h-24 w-28 rounded-[10px] object-cover" />
        <div><h3 className="font-black">Tiny Tunes: Music & Movement</h3><p className="mt-1 text-sm font-semibold">6 months - 3 years</p><span className="mt-2 inline-block rounded-full bg-[#f3f7ff] px-3 py-1 text-xs font-bold text-baby-blue">Music</span></div>
      </div>
      <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
        <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 text-baby-lilac" /> Sun, 25 May 2024</p>
        <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 text-baby-lilac" /> 10:00 AM - 10:45 AM</p>
        <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 text-baby-lilac" /> Little Steps Playhouse, 123 Orchard Road</p>
        <p className="flex gap-2"><Icon name="user" className="h-5 w-5 text-baby-lilac" /> 1 child, ages 6 months - 3 years</p>
      </div>
      <div className="my-5 border-t border-[#eef1f7]" />
      <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-blue">$38.00</span></p>
      <div className="mt-5 rounded-[12px] bg-[#f8fbff] p-4"><h3 className="font-black">Why parents love us</h3>{["Trusted by thousands of parents", "Safe & engaging environments", "Expert-led activities", "Hassle-free booking"].map((item) => <p key={item} className="mt-3 flex gap-2 text-sm font-semibold"><Icon name="check" className="h-4 w-4 text-baby-blue" /> {item}</p>)}</div>
    </aside>
  );
}

function BookedPage() {
  return (
    <PageShell active="/booked" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Class Details</span><span>›</span><span className="text-baby-blue">Book</span></div>
        <section className="grid items-center gap-5 rounded-[18px] border border-[#e7ebf6] bg-gradient-to-r from-[#fff0f7] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-blue text-white"><Icon name="check" className="h-12 w-12" /></span>
          <div><h1 className="text-[36px] font-black">Your class is booked!</h1><p className="mt-2 text-lg font-semibold">We can't wait to see your little one there.</p></div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/book-mascot-banner.png`} alt="" className="hidden h-24 object-contain md:block" />
        </section>
        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
          <div className="space-y-5">
            <article className="rounded-[16px] border border-[#e7ebf6] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Class details</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={`${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`} alt="" className="h-52 w-full rounded-[12px] object-cover" />
                <div><h3 className="text-xl font-black">Tiny Tunes: Music & Movement</h3><p className="mt-2 font-semibold">6 months - 3 years</p><div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><Icon name="pin" className="mr-2 inline h-5 w-5 text-baby-lilac" />Central</p><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />Sat, 25 May 2024</p><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />10:00 AM - 11:00 AM</p><p><Icon name="user" className="mr-2 inline h-5 w-5 text-baby-lilac" />Little Steps Playhouse</p></div></div>
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
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Class</span><span>Tiny Tunes: Music & Movement</span></p><p className="flex justify-between"><span>Date</span><span>Sat, 25 May 2024</span></p><p className="flex justify-between"><span>Time</span><span>10:00 AM - 11:00 AM</span></p><p className="flex justify-between"><span>Total Paid</span><strong className="text-baby-blue">$38.00</strong></p></div>
              <p className="mt-5 rounded-[12px] bg-[#eefbf1] p-4 font-semibold text-green-700"><Icon name="check" className="mr-2 inline h-5 w-5" /> Payment successful</p>
              <Button href="/profile" className="mt-5 w-full">View My Bookings</Button>
              <Button variant="outline" className="mt-3 w-full"><Icon name="calendar" className="h-4 w-4" /> Add to Calendar</Button>
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
              <label className="mb-1 block text-sm font-black">Password</label>
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

function App() {
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/login") return <LoginPage />;
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
  return <HomePage />;
}

export default App;
