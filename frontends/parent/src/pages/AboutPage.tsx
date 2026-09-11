import { PageShell, Button, Icon, Footer } from "../components/ui";

export default function AboutPage() {
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
          <img src={`${import.meta.env.BASE_URL}assets/crops/mission-target.svg`} alt="" className="mx-auto h-48 object-contain" />
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}
