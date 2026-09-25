import { AnimalAvatar, Button, CategoryTile, Footer, Icon, MiniActivityGrid, PageShell, SectionTitle } from "../components/ui";
import { AGE_BANDS, categories } from "../data/content";

/** Marketing sub-line for each band, used by the home page tiles. */
const AGE_BAND_COPY = [
  "Social awakening",
  "Curious little movers",
  "First little steps",
  "Busy toddlers",
  "Confident explorers",
];

export default function HomePage() {
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
