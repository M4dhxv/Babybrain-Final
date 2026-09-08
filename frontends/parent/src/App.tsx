import {
  ActivityCard,
  ActivityRow,
  AnimalAvatar,
  Button,
  BrandStacked,
  CategoryTile,
  DateInput,
  Footer,
  phoneDigits,
  Icon,
  MiniActivityGrid,
  PageShell,
  PlusFeatureDialog,
  SectionTitle,
} from "./components/ui";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SelectField, Opt } from "./components/SelectField";
import { categories } from "./data/content";
import { useActivities } from "./lib/useActivities";
import { useAuth } from "./auth/AuthProvider";
import { useActivityDetail, useFavorite, usePlan, useRecommendations, toCard } from "./lib/data";
import { supabase } from "./lib/supabase";
import { apiGet, apiPost } from "./lib/api";
import { goTo, useLocation, routePath, getParam, scrollToWhenReady } from "./lib/nav";
import { sgDateTime, sgDayRange, courseStrands } from "./lib/schedule";
import { formatChildAge, formatDuration } from "./lib/database.types";
import { EnquiryChat } from "./components/EnquiryChat";
import { ClassGroupChat } from "./components/ClassGroupChat";
import { RainbowLoader } from "./components/RainbowLoader";
import RedirectToLanding from "./components/RedirectToLanding";
import { Chip, REGION_FILTERS } from "./pages/prefChips";
import {
  ActivityCardGridSkeleton,
  ActivityRowListSkeleton,
  ChildCardSkeleton,
  ActivityDetailSkeleton,
} from "./components/Skeletons";

// leaflet (the Explore map only) stays out of the entry bundle — loaded the
// first time the map is shown.
const ExploreMap = lazy(() =>
  import("./components/ExploreMap").then((m) => ({ default: m.ExploreMap }))
);

// Routes a first visit rarely lands on — each its own chunk, fetched when the
// route is first hit rather than shipped in the entry bundle.
const AboutPage = lazy(() => import("./pages/AboutPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PricingPage = lazy(() => import("./pages/PricingPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const BookedPage = lazy(() => import("./pages/BookedPage"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
// The signed-in dashboard + booking + payment surface — the bulk of the app
// by size, and a first visit never lands here.
const ProfilePage = lazy(() => import("./pages/dashboard").then((m) => ({ default: m.ProfilePage })));
const EditProfilePage = lazy(() => import("./pages/dashboard").then((m) => ({ default: m.EditProfilePage })));
const PaymentPage = lazy(() => import("./pages/dashboard").then((m) => ({ default: m.PaymentPage })));
const BookingPage = lazy(() => import("./pages/dashboard").then((m) => ({ default: m.BookingPage })));
const LoginPage = lazy(() => import("./pages/authPages").then((m) => ({ default: m.LoginPage })));
const ForgotPasswordPage = lazy(() => import("./pages/authPages").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("./pages/authPages").then((m) => ({ default: m.ResetPasswordPage })));

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
            {child ? (
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
            ) : (
              (loading || recsLoading) && <ChildCardSkeleton />
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
            <ActivityCardGridSkeleton count={4} />
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
  // Render the list in pages of 50 rather than dumping ~300 rows (and their
  // images) into the DOM at once. The map and the "N activities found" count
  // still reflect the whole filtered set.
  const PAGE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE);

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
      /* `areas` is where this class actually runs (see useActivities). It used
         to be "the listing's region OR any venue the provider owns anywhere",
         which put a Katong class in front of a parent filtering on Sentosa
         purely because the provider also had a Sentosa branch — QA 17/08. */
      if (!a.areas.some((x) => regions.includes(x))) return false;
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

  // Any change to the filters, sort or search starts the list back at page one.
  useEffect(() => {
    setVisibleCount(PAGE);
  }, [categories_, ages, regions, dateFrom, timeRange, maxPrice, sort, query]);

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
              <SelectField value={sort} onChange={(v) => setSort(v as typeof sort)} aria-label="Sort by" className="h-10 w-full px-3 text-[13px] font-bold">
                <Opt value="popular">Most popular</Opt>
                <Opt value="distance">Nearest</Opt>
                <Opt value="soonest">Starting soonest</Opt>
              </SelectField>
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
              <SelectField
                value=""
                placeholder="pick your area"
                aria-label="Pick your area"
                onChange={(v) => {
                  const centroid = REGION_CENTROIDS[v];
                  if (centroid) setHere(centroid);
                }}
                className="h-7 px-2 text-xs font-bold text-[#4a5680]"
              >
                {REGION_FILTERS.map(([v, l]) => (
                  <Opt key={v} value={v}>{l}</Opt>
                ))}
              </SelectField>
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
              {loading ? (
                <div className="h-[395px] w-full animate-pulse bg-[#F3EDF0]" aria-hidden="true" />
              ) : (
                <Suspense
                  fallback={<div className="h-[395px] w-full animate-pulse bg-[#F3EDF0]" aria-hidden="true" />}
                >
                  <ExploreMap activities={shown} regions={regions} />
                </Suspense>
              )}
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
                {loading ? (
                  <ActivityRowListSkeleton count={6} />
                ) : (
                  <>
                    <div className="grid gap-2.5 xl:grid-cols-2">
                      {shown.slice(0, visibleCount).map((activity) => (
                        <ActivityRow key={activity.id} activity={activity} />
                      ))}
                    </div>
                    {shown.length > visibleCount && (
                      <div className="mt-5 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setVisibleCount((n) => n + PAGE)}
                          className="rounded-[10px] border border-[#EBE3E5] bg-white px-6 py-2.5 text-sm font-black text-[#4a5680] shadow-card hover:border-baby-pink"
                        >
                          Show more ({shown.length - visibleCount} left)
                        </button>
                      </div>
                    )}
                  </>
                )}
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
  const { activity, sessions, reviews, courseSpan, eventSoldOut, loading } = useActivityDetail(getParam("slug"));
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

  /* The browser resolves the hash before Vite has mounted, and reviews arrive
     asynchronously after that, so #reviews (the post-activity check-in email's
     "leave a review" link — migration 00083) would land at the top of the page.
     Poll briefly for the target, then give up quietly. */
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    return scrollToWhenReady(id);
  }, []);

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
        <ActivityDetailSkeleton />
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
  // Wix Events and Wix COURSEs have no BabyBrain waitlist (00107): a sold-out
  // event / a course with no dates left shows a disabled "Sold out" CTA
  // instead of sending the parent into a booking flow that can't complete.
  // Native and Wix CLASS activities keep the waitlist, so they are never
  // "sold out" here — a full slot still routes to Book.
  const soldOut =
    eventSoldOut || (activity.wix_service_type === "COURSE" && sessions.length === 0);

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
              <img src={images[0]} alt={activity.title} width={860} height={305} decoding="async" fetchPriority="high" className="h-[305px] w-full rounded-[18px] object-cover" />
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
                    <img src={url} alt="" width={76} height={44} loading="lazy" decoding="async" className="h-11 w-[76px] object-cover" />
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

          {/* `id` so the post-activity check-in email's "leave a review" link
              (/activity?slug=…#reviews, migration 00083) lands on the form. */}
          <section id="reviews" className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
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
            ) : soldOut ? (
              <button
                type="button"
                disabled
                className="mt-4 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#EBE3E5] bg-[#FAF7F7] px-6 py-3 text-[15px] font-extrabold leading-none text-[#6D7486]"
              >
                <Icon name="calendar" className="h-4 w-4" /> {activity.wix_service_type === "EVENT" ? "Sold out" : "Currently full"}
              </button>
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
                  <span className="text-right text-[#A7D8F8]">{next.capacity > 0 ? `${next.capacity} spots` : "Sold out"}</span>
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
  // Re-render on client-side navigation (pushState via goTo, or back/forward).
  // The pages below read the URL during render, so they pick up the new route
  // as soon as App re-renders them.
  useLocation();
  // In production a Next rewrite serves these routes from `/`, but the Vite dev
  // server hosts the bundle under its `/app/` base — strip it so local routing
  // matches what parents actually browse.
  const pathname = routePath();

  const bootLoader = (
    <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
      <RainbowLoader className="py-4" label="Loading" />
    </main>
  );

  let page: ReactNode;
  if (pathname === "/login") page = <LoginPage />;
  else if (pathname === "/forgot-password") page = <ForgotPasswordPage />;
  else if (pathname === "/reset-password") page = <ResetPasswordPage />;
  else if (pathname === "/pricing") page = <PricingPage />;
  else if (pathname === "/payment") page = <PaymentPage />;
  else if (pathname === "/book") page = <BookingPage />;
  else if (pathname === "/booked") page = <BookedPage />;
  else if (pathname === "/about") page = <AboutPage />;
  else if (pathname === "/onboarding") page = <OnboardingPage />;
  else if (pathname === "/matches") page = <MatchesPage />;
  else if (pathname === "/explore") page = <ExplorePage />;
  else if (pathname === "/activity") page = <ActivityDetailPage />;
  else if (pathname === "/profile") page = <ProfilePage />;
  else if (pathname === "/edit-profile") page = <EditProfilePage />;
  else if (pathname === "/contact") page = <ContactPage />;
  else if (pathname === "/terms") page = <TermsPage />;
  /* QA 01/09: Stripe's billing portal links out to a privacy policy, and a
     bare /privacy is the URL everyone expects (a `#privacy` fragment is also
     easy for an external service to drop). It has never been a route, so it
     fell through to the signed-in home. Same page, opened at that section. */
  else if (pathname === "/privacy") page = <TermsPage />;
  // Home: signed-in parents land on their personalised dashboard (matched
  // classes for their child), not the marketing page. While auth is still
  // resolving, a browser that has a stored session waits on a loader rather
  // than flashing the marketing landing page before the redirect.
  else if (!loading && session) page = <MatchesPage active="/" />;
  else if (loading && hasStoredSession()) page = bootLoader;
  else page = <HomePage />;

  // A lazily-loaded route's chunk still has to arrive; show the same boot
  // loader while it does. `data-bb-loading` keeps the index.html watchdog
  // treating a slow chunk as "still loading", not "wedged".
  return <Suspense fallback={bootLoader}>{page}</Suspense>;
}

export default App;
