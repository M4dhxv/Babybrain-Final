import { AnimalAvatar, Button, CategoryTile, Footer, Icon, MiniActivityGrid, PageShell, SectionTitle, retryImage } from "../components/ui";
import { AGE_BANDS, categories } from "../data/content";

/** Marketing sub-line for each band, used by the home page tiles. */
const AGE_BAND_COPY = [
  "Social awakening",
  "Curious little movers",
  "First little steps",
  "Busy toddlers",
  "Confident explorers",
];

const REVIEWS = [
  {
    name: "Hannah",
    // Woman: blond hair, light skin tone (the avatar catalogue has no blonde option).
    emoji: "\u{1F471}\u{1F3FB}‍♀️",
    text: "BabyBrain is what we have all been waiting for! It’s amazing to have one go to platform to book classes for our child. It’s incredibly intuitive to use & has so many fantastic activities to choose from. BabyBrain is a must have for parents of young ones in Singapore!",
    role: "Mum of 2 month old",
  },
  // Man, light skin tone.
  { name: "Marcus", emoji: "\u{1F468}\u{1F3FB}", text: "Easy to use and saves us so much time planning weekends.", role: "Dad of 3.5 year old" },
  { name: "Sarah", emoji: undefined, text: "A great platform to discover new activities and local gems.", role: "Mum of 4.5 year old" },
];

export default function HomePage() {
  return (
    <PageShell active="/" auth="public">
      {/* Each section eases in with the same short rise as the Explore and
          activity pages (see .bb-reveal in styles/index.css), the first few a
          beat apart so the page settles from the top down. */}
      <main>
        <section className="bb-reveal mx-auto grid max-w-[1120px] items-center gap-8 px-6 pb-4 pt-6 lg:grid-cols-[1fr_1.1fr]">
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
              onError={retryImage}
              alt="A toddler wading through a ball pit at an indoor play space"
              width={1400}
              height={933}
              className="relative z-10 h-[370px] w-full rounded-[100px_74px_82px_52px] object-cover shadow-soft"
            />
          </div>
        </section>

        <section className="bb-reveal mx-auto grid max-w-[1120px] gap-4 px-6 py-4 md:grid-cols-3" style={{ animationDelay: "40ms" }}>
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

        <section id="how-it-works" className="bb-reveal mx-auto max-w-[1120px] scroll-mt-24 px-6 py-3" style={{ animationDelay: "80ms" }}>
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
                    <img src={`${import.meta.env.BASE_URL}assets/crops/${art}.png`} alt="" onError={retryImage} className="h-full object-contain" />
                  </div>
                  <h3 className="text-lg font-black">{title}</h3>
                  <p className="mx-auto mt-2 max-w-[230px] text-sm font-semibold leading-6 text-[#46527d]">
                    {copy}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bb-reveal mx-auto max-w-[1120px] px-6 py-4" style={{ animationDelay: "120ms" }}>
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

        <section className="bb-reveal mx-auto max-w-[1120px] px-6 py-4" style={{ animationDelay: "160ms" }}>
          <SectionTitle>Explore activities by type</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label, , slug]) => (
              <CategoryTile key={label} icon={icon} label={label} href={`/explore?cat=${slug}`} />
            ))}
          </div>
        </section>

        <section className="bb-reveal mx-auto max-w-[1120px] px-6 py-4" style={{ animationDelay: "160ms" }}>
          <SectionTitle
            action={<a href="/explore" className="font-bold text-baby-pink">View all activities ›</a>}
          >
            Activities near you
          </SectionTitle>
          <MiniActivityGrid />
        </section>

        <section className="bb-reveal mx-auto grid max-w-[1120px] gap-4 px-6 py-3 md:grid-cols-3" style={{ animationDelay: "160ms" }}>
          {REVIEWS.map(({ name, text, role, emoji }) => (
            <article key={name} className="flex gap-4 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
              <AnimalAvatar seed={name} kind="parent" emoji={emoji} className="h-11 w-11 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: 5 }).map((_, starIndex) => <Icon key={starIndex} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
                <p className="mt-2 text-sm font-semibold leading-6">{text}</p>
                {/* Names sit on a shared baseline across the three cards, however long the review above them. */}
                <div className="mt-auto pt-3">
                  <strong className="block text-sm">{name}</strong>
                  <span className="text-xs font-semibold text-[#6b759a]">{role}</span>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="bb-reveal mx-auto max-w-[1120px] px-6 py-4" style={{ animationDelay: "160ms" }}>
          <div className="grid items-center gap-6 overflow-hidden rounded-[18px] border border-[#E9E1F5] bg-gradient-to-r from-[#FEEBF2] via-white to-[#F4F0FA] px-10 py-5 md:grid-cols-[220px_1fr_280px]">
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" onError={retryImage} className="h-28 object-contain object-left" />
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
