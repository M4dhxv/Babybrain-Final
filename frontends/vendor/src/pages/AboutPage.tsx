import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiteFooter from '@/components/SiteFooter';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Partner-side About page. The vendor CHROME (this header + SiteFooter) is the
 * portal's own; the CENTRE column is a faithful copy of the parent app's
 * About page — same copy, type (Nunito), lilac display headings, pastel
 * founder panel, rounded imagery and spacing — so the two read as one brand.
 * Mirrors frontends/parent/src/pages/AboutPage.tsx; keep them in sync. The
 * parent page's two CTA buttons (Explore / Join today) are dropped here —
 * both point into the parent app and would bounce the vendor back out.
 */
export default function AboutPage() {
  const navigate = useNavigate();
  const base = import.meta.env.BASE_URL;
  const softShadow = 'shadow-[0_2px_6px_rgba(17,26,76,0.06),0_12px_28px_rgba(17,26,76,0.10)]';

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4 sm:px-8">
        <button className="flex cursor-pointer items-center gap-2" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />
        </button>
        {/* Return to wherever they came from (a footer link on any portal
            page), not a fixed route. Falls back to the dashboard when there's
            no in-app history — e.g. the page was opened directly. */}
        <Button
          variant="outline"
          className="gap-2 rounded-lg border-gray-300"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/dashboard'))}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </header>

      {/* Centre column mirrors the parent About page 1:1 — Nunito face, the
          parent's arbitrary sizes/colours, no vendor restyling. */}
      <main
        className="mx-auto max-w-[1024px] px-6 py-8 text-[#111A4C]"
        style={{ fontFamily: "'Nunito', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}
      >
        <section className="relative grid items-center gap-8 md:grid-cols-[1fr_520px]">
          <div className="relative z-10">
            <h1 className="text-[54px] font-black leading-tight text-[#C7B1E6]">About</h1>
            <p className="mt-5 text-2xl font-black leading-tight">
              BabyBrain helps parents to discover &amp; book amazing activities for their little ones.
            </p>
            <p className="mt-5 max-w-[420px] font-semibold leading-7 text-[#3f4b78]">
              We curate options based on your children's age, interests and your location, making it quicker and
              easier to find great activities and less overwhelming to adjust plans when the schedule changes.
            </p>
          </div>
          {/* Portrait cropped low (10% from top) so Katie's head clears the
              top edge instead of a centre-crop cutting into her hair. */}
          <img
            src={`${base}assets/crops/about-family.jpg`}
            alt="Katie, BabyBrain's founder, holding her son"
            width={1000}
            height={1000}
            className={`relative z-10 mx-auto aspect-square w-full max-w-[460px] rounded-[24px] object-cover object-[50%_10%] ${softShadow}`}
          />
        </section>

        <section className="relative mt-8 grid items-center gap-8 overflow-hidden rounded-[24px] bg-gradient-to-r from-[#FEEBF2] to-[#FFF5F8] p-8 md:grid-cols-[300px_1fr]">
          <img
            src={`${base}assets/crops/founder-katie.jpg`}
            alt="Katie Crowson, founder of BabyBrain"
            width={720}
            height={880}
            className={`relative z-10 mx-auto h-[340px] w-full max-w-[290px] rounded-[18px] object-cover ${softShadow}`}
          />
          <div className="relative z-10">
            <p className="font-black text-[#C7B1E6]">Meet our founder</p>
            <h2 className="mt-1 text-[38px] font-black leading-tight">Katie Crowson</h2>
            <p className="mt-4 font-semibold leading-7 text-[#3f4b78]">Hi! I'm Katie, a mum, and the founder of BabyBrain.</p>
            <p className="mt-3 font-semibold leading-7 text-[#3f4b78]">
              After having our son, I realised how unnecessarily difficult it was to find out what activities are on
              offer and book, only to have to start afresh when the schedule changes.
            </p>
            <p className="mt-3 font-semibold leading-7 text-[#3f4b78]">
              BabyBrain was created to make that journey quicker and easier.
            </p>
            <p className="mt-4 flex items-center gap-2 font-black">
              <Heart className="h-5 w-5 text-[#C7B1E6]" /> Made by a parent, for parents.
            </p>
          </div>
        </section>

        {/* No tinted panel — the mission sits straight on the page. */}
        <section className="mt-5 grid items-center gap-6 px-2 py-8 md:grid-cols-[1fr_320px]">
          <div>
            <h2 className="text-[46px] font-black leading-none text-[#C7B1E6]">Our mission</h2>
            <p className="mt-5 text-2xl font-black leading-tight">
              To reduce the mental load for parents in Singapore.
            </p>
            <p className="mt-4 max-w-[440px] font-semibold leading-7 text-[#3f4b78]">
              We want to help you spend less time on administration and more time having meaningful experiences.
            </p>
          </div>
          <img src={`${base}assets/crops/mission-target.png`} alt="" className="mx-auto h-48 object-contain" />
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
