import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiteFooter from '@/components/SiteFooter';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Partner-side Terms & Conditions. There is ONE site-wide T&C for BabyBrain
 * (it covers parents, providers and payments alike); the parent app renders
 * the same document at `/terms`. This copy exists only so the vendor footer's
 * "Terms of Service" / "Privacy Policy" links resolve inside the vendor
 * HashRouter with vendor chrome, instead of handing the tab off to the parent
 * app (which showed parent navigation and a parent account in the corner).
 *
 * The `sections` array below is a verbatim mirror of
 * frontends/parent/src/pages/TermsPage.tsx — keep the two in sync.
 */
const sections: { id?: string; title: string; body: string }[] = [
  {
    title: '1. Acceptance of Terms',
    body: 'By creating an account, browsing, booking, or subscribing on BabyBrain.sg ("BabyBrain", "we", "us"), you agree to these Terms & Conditions and the disclosures below. If you do not agree, please do not use the platform.',
  },
  {
    title: '2. Accounts & Eligibility',
    body: 'You must be at least 18 and provide accurate information. You are responsible for activity under your account and for keeping your login secure.',
  },
  {
    id: 'privacy',
    title: '3. Privacy & PDPA',
    body: "We collect and process personal data in accordance with Singapore's Personal Data Protection Act (PDPA). We collect what we need to run the service (your profile, your children's ages/interests, bookings, and usage). You consent to this processing when you use BabyBrain. Our full Privacy Policy forms part of these Terms.",
  },
  {
    title: '4. Cookie Consent',
    body: 'We use cookies and similar technologies for authentication, preferences, and basic analytics. By continuing to use the site you consent to essential cookies; non-essential cookies are used only where permitted.',
  },
  {
    title: "5. Children's Data",
    body: 'Child details (name, date of birth, interests) are provided by you as the parent/guardian to personalise recommendations. We process them solely to deliver the service and never sell them. You may edit or delete them at any time.',
  },
  {
    title: '6. Vendor Data Sharing',
    body: 'When you book, enquire, or join a class chat, we share the information necessary to fulfil that booking (e.g. your name and relevant details) with the activity provider. Providers are independent businesses responsible for their own services.',
  },
  {
    title: '7. Bookings & Payments',
    body: "Bookings are contracts between you and the provider. Payments are processed securely by Stripe; by paying you accept Stripe's payment terms. BabyBrain is not the provider of the classes and is not liable for the conduct or cancellation of a class by a provider.",
  },
  {
    title: '8. BabyBrain Plus — Subscription Terms',
    body: 'BabyBrain Plus costs SGD 9/month or SGD 99/year, plus GST. New subscribers get a 30-day free trial (first month free). Billing and card details are handled by Stripe.',
  },
  {
    title: '9. Auto-Renewal Disclosure',
    body: 'Plus is a recurring subscription. After any free trial, it automatically renews at the end of each billing period (monthly or yearly) and your payment method is charged until you cancel. The renewal date is shown in Profile → Settings.',
  },
  {
    title: '10. Managing & Cancelling Your Subscription',
    body: 'You can view, update your card, or cancel Plus at any time from Profile → Settings → Manage / Cancel, which opens the Stripe billing portal. Cancelling stops future renewals; you keep Plus access until the end of the current paid period. See our refund policy below.',
  },
  {
    title: '11. Refunds & Cancellation Policy',
    body: "Subscription fees are non-refundable except where required by law; cancelling prevents the next charge. Class booking refunds and reschedules follow the individual provider's cancellation policy shown at booking.",
  },
  {
    title: '12. AI Planner Disclaimer',
    body: 'The AI planning tool provides suggestions to help you organise activities around your schedule. It may be inaccurate or incomplete and is not professional, medical, or developmental advice. Always use your own judgement; you are responsible for decisions made using it.',
  },
  {
    title: '13. Recommendations & Personalisation',
    body: 'We generate recommendations from the preferences and child details you provide and your activity on the platform. Recommendations are suggestions only and are not guarantees of suitability.',
  },
  {
    title: '14. Marketing Consent',
    body: 'With your consent, we send curated-activity emails and updates. You can opt in or out at any time in your settings or via the unsubscribe link in any marketing email. Essential service messages (bookings, billing) are always sent.',
  },
  {
    title: '15. Calendar Integration Consent',
    body: 'If you enable calendar reminders/sync or export, you consent to BabyBrain creating calendar entries for your bookings. You can disable this at any time.',
  },
  {
    title: '16. Reviews & Moderation',
    body: 'You may review any class listed on BabyBrain, whether or not you booked it through us. Reviews must be honest, first-hand and lawful. We may moderate or remove content that is abusive, misleading, or violates these Terms.',
  },
  {
    title: '17. Messaging Rules',
    body: 'All users can read messages on their booked classes. Sending messages to other parents and providers is a Plus feature. Messaging must be respectful and used only for coordinating activities; misuse may lead to suspension.',
  },
  {
    title: '18. Data Retention, Deletion & Account Closure',
    body: 'You have the right to access and delete your personal data. You can delete your account from your settings or by contacting us; we then remove or anonymise your data except where we must retain records (e.g. transaction records) under applicable law.',
  },
  {
    title: '19. Security',
    body: 'We apply reasonable technical and organisational controls (encryption in transit, access controls, RLS) to protect your data. No system is perfectly secure, so please protect your own credentials.',
  },
  {
    title: '20. Changes & Contact',
    body: 'We may update these Terms; material changes will be notified in-app or by email. Questions? Contact hello@babybrain.sg.',
  },
];

export default function TermsPage() {
  const navigate = useNavigate();

  /* Footer links here as `/terms#privacy`; under HashRouter that lands as
     `#/terms#privacy`, so scroll the Privacy section into view once painted.
     App's <ScrollToTop> fires an instant scroll-to-0 on the same navigation
     and a single 80ms timeout raced it, so keep re-aligning for ~1s until the
     section is actually at the top. */
  useEffect(() => {
    if (!window.location.hash.endsWith('privacy')) return;
    let tries = 0;
    const id = setInterval(() => {
      const el = document.getElementById('privacy');
      if (el) el.scrollIntoView({ behavior: tries === 0 ? 'auto' : 'smooth' });
      if (++tries >= 10 || (el && Math.abs(el.getBoundingClientRect().top - 96) < 4)) {
        clearInterval(id);
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

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

      <main className="mx-auto max-w-3xl px-6 py-10 sm:px-8">
        <h1 className="text-3xl font-bold text-[#111A4C] sm:text-4xl">Terms &amp; Conditions</h1>
        <p className="mt-2 text-sm font-semibold text-gray-400">Last updated: July 2026</p>
        <p className="mt-4 leading-7 text-gray-600">
          These Terms cover your use of BabyBrain, including bookings, the BabyBrain Plus subscription, privacy, and
          the disclosures we're required to make. Please read them.
        </p>
        <div className="mt-8 space-y-7">
          {sections.map((s) => (
            <section key={s.title} id={s.id} className="scroll-mt-24">
              <h2 className="text-lg font-bold text-[#111A4C]">{s.title}</h2>
              <p className="mt-2 leading-7 text-gray-600">{s.body}</p>
            </section>
          ))}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
