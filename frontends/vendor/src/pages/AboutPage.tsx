import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiteFooter from '@/components/SiteFooter';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Partner-side About page. Same story and mission as the parent About page,
 * but served inside the vendor portal's own HashRouter (`/vendor/#/about`)
 * with vendor chrome — the footer link used to point at the parent app's
 * `/about`, which swapped the whole interface to the parent UI and surfaced
 * a parent account in the top-right. No call-to-action buttons here: every
 * onward destination worth linking (Explore, Parent Sign Up) lives in the
 * parent app, so linking them would reintroduce the same cross-app jump.
 */
export default function AboutPage() {
  const navigate = useNavigate();
  const base = import.meta.env.BASE_URL;

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4 sm:px-8">
        <button className="flex cursor-pointer items-center gap-2" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />
        </button>
        <Button variant="outline" className="gap-2 rounded-lg border-gray-300" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10 sm:px-8">
        <section className="grid items-center gap-8 md:grid-cols-[1fr_480px]">
          <div>
            <h1 className="text-4xl font-bold text-purple-600 sm:text-5xl">About</h1>
            <p className="mt-5 text-2xl font-bold leading-tight text-[#111A4C]">
              BabyBrain helps parents to discover &amp; book amazing activities for their little ones.
            </p>
            <p className="mt-5 max-w-[440px] leading-7 text-gray-600">
              We curate options based on children's age, interests and location, making it quicker and easier for
              parents to find great activities — and connecting Singapore's activity providers with the families
              looking for them.
            </p>
          </div>
          <img
            src={`${base}assets/crops/about-family.jpg`}
            alt="Katie, BabyBrain's founder, holding her son"
            width={1000}
            height={1000}
            className="mx-auto aspect-square w-full max-w-[440px] rounded-3xl object-cover object-[50%_10%] shadow-lg"
          />
        </section>

        <section className="mt-10 grid items-center gap-8 overflow-hidden rounded-3xl bg-gradient-to-r from-pink-50 to-purple-50 p-8 md:grid-cols-[280px_1fr]">
          <img
            src={`${base}assets/crops/founder-katie.jpg`}
            alt="Katie Crowson, founder of BabyBrain"
            width={720}
            height={880}
            className="mx-auto h-[320px] w-full max-w-[270px] rounded-2xl object-cover shadow-lg"
          />
          <div>
            <p className="font-bold text-purple-600">Meet our founder</p>
            <h2 className="mt-1 text-3xl font-bold leading-tight text-[#111A4C]">Katie Crowson</h2>
            <p className="mt-4 leading-7 text-gray-600">Hi! I'm Katie, a mum, and the founder of BabyBrain.</p>
            <p className="mt-3 leading-7 text-gray-600">
              After having our son, I realised how unnecessarily difficult it was to find out what activities are on
              offer and book, only to have to start afresh when the schedule changes.
            </p>
            <p className="mt-3 leading-7 text-gray-600">BabyBrain was created to make that journey quicker and easier.</p>
            <p className="mt-4 flex items-center gap-2 font-bold text-[#111A4C]">
              <Heart className="h-5 w-5 text-purple-600" /> Made by a parent, for parents.
            </p>
          </div>
        </section>

        <section className="mt-8 grid items-center gap-6 px-2 py-8 md:grid-cols-[1fr_300px]">
          <div>
            <h2 className="text-4xl font-bold leading-none text-purple-600">Our mission</h2>
            <p className="mt-5 text-2xl font-bold leading-tight text-[#111A4C]">
              To reduce the mental load for parents in Singapore.
            </p>
            <p className="mt-4 max-w-[460px] leading-7 text-gray-600">
              We want to help families spend less time on administration and more time having meaningful
              experiences — and to give the providers who run those experiences a simple way to reach them.
            </p>
          </div>
          <img src={`${base}assets/crops/mission-target.png`} alt="" className="mx-auto h-44 object-contain" />
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
