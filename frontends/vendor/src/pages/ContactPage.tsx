import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, MessageCircle, Phone, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import SiteFooter, { SUPPORT_EMAIL, SUPPORT_PHONE, phoneDigits } from '@/components/SiteFooter';
import { apiPost } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Partner contact page — QA: "On vendor portal, contact page just goes to
 * e-mail. Would like a contact page with WhatsApp, e-mail, FAQs etc similar to
 * parents."
 */

const faqLink = 'font-medium text-[#FA4D8D] underline underline-offset-2 hover:text-[#e0417b]';

const FAQS: [string, ReactNode][] = [
  [
    'How does BabyBrain help my business?',
    'BabyBrain combines a targeted consumer marketplace with tools to help you manage your bookings, customers and day-to-day operations. This gives you a new channel to reach relevant parents while helping you manage your business more efficiently.',
  ],
  [
    'How do I get my business listed?',
    'If you provide activities for children aged 0–12 years, send us an enquiry above and we’ll be in touch.',
  ],
  [
    'What does it cost?',
    <>
      With our Pay as You Grow plan, there is no fixed monthly subscription — you only pay a commission on new
      bookings. Our Pro and Premium plans have a monthly subscription fee and give you access to enhanced marketing
      and customer management tools, including features such as parent messaging, priority ranking and analytics.
      See <Link to="/plans" className={faqLink}>Plans</Link> for full details.
    </>,
  ],
  [
    'How do parents book?',
    'On a paid plan, parents can discover, book and pay for your activities through BabyBrain, with the booking appearing in your BabyBrain portal. If you currently use another booking system, we can integrate with it where the platform supports integration, allowing you to manage your bookings and availability across both systems.',
  ],
  [
    'Can I still accept bookings directly through my own website?',
    'Yes. BabyBrain is designed to work alongside your existing booking processes. If you use booking software, we can integrate with it where supported. If you manage bookings manually, you can add bookings from other channels directly into your BabyBrain portal so that you can keep your bookings and customer information in one place.',
  ],
  [
    'Do I need to change my existing booking system?',
    'No. BabyBrain is designed to work alongside the tools you already use. Where your existing booking platform supports integration, we can connect the two systems so you don’t have to manually manage the same information in multiple places.',
  ],
  [
    'How does commission work and when do I get paid?',
    'Payments are processed through Stripe Connect. Any applicable BabyBrain commission and payment processing fees are deducted from the booking payment before the remaining balance is paid out to you. Payouts are then made to your connected account in accordance with the agreed commercial terms and payout schedule.',
  ],
  [
    'How do I edit my profile?',
    <>
      If we’ve already listed your business using publicly available information, use{' '}
      <Link to="/claim-business" className={faqLink}>Claim your business</Link> to take ownership of the listing.
      Once claimed, you can edit your business information, upload photos and your logo, add or amend activities,
      schedules and locations, and update your packages and pricing.
    </>,
  ],
  [
    'Can I manage more than one venue?',
    'Yes. You can add and manage multiple locations from your BabyBrain portal.',
  ],
  [
    'Who is responsible for the activity or class?',
    'The provider is responsible for delivering the activity or class and for anything that occurs during the session. BabyBrain provides the marketplace and technology that enables parents to discover and book activities, but the provider remains responsible for the activity itself.',
  ],
  [
    'What is the policy on cancellations and rescheduling?',
    'BabyBrain can be configured to reflect your own cancellation and rescheduling policies. Settings can be adjusted so that cancellation or rescheduling options are not offered, or so that they are only available up to a specified cut-off time. If you offer make-up classes or tokens, you can assign these directly to parents through your BabyBrain portal.',
  ],
  [
    'How do reviews work?',
    'Parents can leave reviews based on their experience with your business. Reviews are monitored, and reviews that are found to be false, fraudulent or malicious may be removed. If you believe a review is inappropriate or inaccurate, you can request that it is assessed at any time using the enquiry form above.',
  ],
  [
    'Can I remove my listing at any time?',
    <>
      Yes. If you have not claimed your listing, you can{' '}
      <Link to="/plans" className={faqLink}>opt out</Link> at any time. If you have a subscription, you can{' '}
      <Link to="/billing" className={faqLink}>unsubscribe</Link> at any time. Depending on the terms of your plan,
      you may be charged for the next subscription cycle if the required notice period has not been met.
    </>,
  ],
];

export default function ContactPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [business, setBusiness] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // HashRouter means #faq is part of the route, so scroll manually.
  useEffect(() => {
    if (!window.location.hash.endsWith('faq')) return;
    const t = setTimeout(() => document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth' }), 80);
    return () => clearTimeout(t);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Please tell us your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (message.trim().length < 10) return setError('Please add a little more detail.');
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/contact', {
        name: name.trim(),
        email: email.trim(),
        subject: `Partner enquiry${business.trim() ? ` — ${business.trim()}` : ''}`,
        message: message.trim(),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : `We couldn't send that — please email ${SUPPORT_EMAIL}.`);
    } finally {
      setBusy(false);
    }
  }

  const cards = [
    {
      icon: MessageCircle,
      title: 'WhatsApp us',
      tag: 'Fastest',
      copy: 'Message our partnerships team for a quick answer.',
      label: 'Chat on WhatsApp',
      href: `https://wa.me/${phoneDigits(SUPPORT_PHONE)}`,
      tone: 'bg-green-50 text-green-600',
    },
    {
      icon: Mail,
      title: 'Email us',
      tag: '',
      copy: 'Best for anything involving bookings, payments or your plan.',
      label: 'Email us',
      href: `mailto:${SUPPORT_EMAIL}`,
      tone: 'bg-pink-50 text-[#FA4D8D]',
    },
    {
      icon: Phone,
      title: 'Call us',
      tag: '',
      copy: 'Speak to us directly if it is urgent.',
      label: 'Call us',
      href: `tel:+${phoneDigits(SUPPORT_PHONE)}`,
      tone: 'bg-purple-50 text-purple-600',
    },
  ];

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4 sm:px-8">
        <button className="flex cursor-pointer items-center gap-2" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />
          
        </button>
        <Button variant="outline" className="gap-2 rounded-lg border-gray-300" onClick={() => navigate('/')}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10 sm:px-8">
        <h1 className="text-3xl font-bold text-[#111A4C]">How can we help?</h1>
        <p className="mt-2 text-gray-600">
          Whether you're thinking about joining or already listed with us, we're here.
        </p>

        <section className="mt-8 grid gap-5 md:grid-cols-3">
          {cards.map((c) => (
            <article key={c.title} className="rounded-2xl border border-gray-200 p-6 text-center">
              <div className={`mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full ${c.tone}`}>
                <c.icon className="h-7 w-7" />
              </div>
              <h2 className="text-lg font-bold text-gray-900">
                {c.title}
                {c.tag && <span className="ml-2 rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-[#FA4D8D]">{c.tag}</span>}
              </h2>
              <p className="my-4 text-sm text-gray-500">{c.copy}</p>
              <Button asChild variant="outline" className="w-full rounded-xl">
                <a href={c.href} target={c.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                  {c.label}
                </a>
              </Button>
            </article>
          ))}
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold text-[#111A4C]">Send us an enquiry</h2>
          <p className="mt-1 text-gray-600">Tell us about your business and we'll come back to you.</p>
          {sent ? (
            <div className="mt-5 rounded-2xl border border-green-300 bg-green-50 p-6 text-center">
              <h3 className="text-lg font-bold text-green-800">Thanks — enquiry received</h3>
              <p className="mt-1 text-sm text-green-700">We'll be in touch within 3 working days.</p>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-5 rounded-2xl border border-gray-200 p-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-900">Your name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl" placeholder="e.g. Katie Crowson" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-900">Business name</label>
                  <Input value={business} onChange={(e) => setBusiness(e.target.value)} className="rounded-xl" placeholder="e.g. Little Steps Playhouse" />
                </div>
              </div>
              <div className="mt-4">
                <label className="mb-1 block text-sm font-semibold text-gray-900">Email address</label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl" placeholder="you@yourbusiness.com" />
              </div>
              <div className="mt-4">
                <label className="mb-1 block text-sm font-semibold text-gray-900">Message</label>
                <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} className="rounded-xl" placeholder="Tell us what you offer and what you'd like from BabyBrain." />
              </div>
              {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}
              <Button type="submit" disabled={busy} className="gradient-primary mt-4 gap-2 rounded-xl px-8 text-white hover:opacity-90">
                <Send className="h-4 w-4" /> {busy ? 'Sending…' : 'Send enquiry'}
              </Button>
            </form>
          )}
        </section>

        <section id="faq" className="mt-12 scroll-mt-24">
          <h2 className="text-2xl font-bold text-[#111A4C]">Frequently asked questions</h2>
          <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200">
            {FAQS.map(([q, a]) => (
              <details key={q} className="border-b border-gray-100 px-6 py-4 last:border-b-0">
                <summary className="cursor-pointer list-none font-semibold text-gray-900">
                  {q} <span className="float-right text-gray-400">⌄</span>
                </summary>
                <p className="mt-3 text-sm leading-6 text-gray-600">{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
