import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

const FAQS: [string, string][] = [
  [
    'How do I get my business listed on BabyBrain?',
    "Send us an enquiry below and we'll be in touch. If we've already listed you from public information, use Claim Your Business to take ownership of the listing.",
  ],
  [
    'What does it cost?',
    'A basic listing is free. Paid plans add direct booking and payments, messaging with parents, priority ranking and analytics — see Plans & Pricing for the detail.',
  ],
  [
    'How do parents book?',
    "On a paid plan, parents book and pay through BabyBrain and the booking lands in your portal. On the free plan we link parents to your own booking page instead.",
  ],
  [
    'When do I get paid?',
    'Payments run through Stripe Connect. Once your Stripe account is set up, payouts follow your Stripe schedule, less the platform commission shown on your plan.',
  ],
  [
    'Can I manage more than one venue?',
    "Yes — add each venue under Settings and assign classes to it. Parents then see the right location on the map for every class.",
  ],
  [
    'How do I edit my classes or timetable?',
    'Everything lives under Activities in the portal: edit details, prices, age ranges and session times, and changes appear on the parent site straight away.',
  ],
  [
    'Who do I contact if something goes wrong?',
    'WhatsApp is quickest. For anything involving a booking or payment, email us so we have a written record and we will come back to you within one working day.',
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
      tone: 'bg-pink-50 text-[#E91E63]',
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
        <h1 className="text-3xl font-bold text-[#1B1F3B]">How can we help?</h1>
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
                {c.tag && <span className="ml-2 rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-[#E91E63]">{c.tag}</span>}
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
          <h2 className="text-2xl font-bold text-[#1B1F3B]">Send us an enquiry</h2>
          <p className="mt-1 text-gray-600">Tell us about your business and we'll come back to you.</p>
          {sent ? (
            <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-6 text-center">
              <h3 className="text-lg font-bold text-green-800">Thanks — enquiry received</h3>
              <p className="mt-1 text-sm text-green-700">We'll be in touch within one working day.</p>
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
          <h2 className="text-2xl font-bold text-[#1B1F3B]">Frequently asked questions</h2>
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
