import { useEffect, useState } from "react";
import {
  PageShell,
  Button,
  Icon,
  Footer,
  SectionTitle,
  SUPPORT_EMAIL,
  SUPPORT_PHONE,
  phoneDigits,
} from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { apiPost } from "../lib/api";
import { scrollToWhenReady } from "../lib/nav";
import { emailError } from "../lib/validation";

const FAQ_LINK = "font-black text-baby-pink hover:underline";
const FAQ_GROUPS: { group: string; items: [string, React.ReactNode][] }[] = [
  {
    group: "Booking & getting started",
    items: [
      ["How does booking work?", "For providers integrated with BabyBrain, you find a class you like, select your package and session, and book directly through us — no contact forms, no waiting for a reply. For providers who aren't integrated, we'll redirect you to their site to book."],
      ["Why can I book some providers on BabyBrain but get sent to others' websites?", "It depends on the plan each provider is on. Some are fully set up to book directly through BabyBrain; others aren't there yet or have decided not to integrate, so we send you to their site to book. We're working on getting more providers fully integrated to make the process smoother for you."],
      ["What happens after I book?", "You'll get a booking confirmation by email, along with reminders before your class so nothing slips."],
      ["What if I need to cancel or reschedule?", "Cancellation and rescheduling policies are set by each provider and vary, so check the provider's page for the details before you book."],
      ["Can I get a refund?", "Whether a refund is issued is decided by each provider, under the policy on their page. Have a look there before booking so you know where you stand."],
      ["What happens if a provider cancels a class?", "You'll get an email letting you know. What happens next — a make-up token, a refund, or something else — depends on that provider's policy."],
      ["Do I have to create an account?", "Yes — you'll need a free account to book and to receive your confirmations and reminders. It only takes a minute."],
    ],
  },
  {
    group: "Cost & payment",
    items: [
      ["Does BabyBrain cost anything to use?", "BabyBrain is free to browse and book — you just pay the price of the activity. Your family profile, reviews and personalised suggestions are all free too. If you'd like extras like pass tracking, saved providers, calendar export and messaging, our Plus plan is SGD 9/month or SGD 99/year on top of activity prices."],
      ["How do I pay?", "PayNow, Apple Pay, Google Pay or card — whatever's easiest for you."],
      ["Is my payment secure?", "Payments are handled by Stripe, a global provider trusted by millions of businesses. Your card details are never stored by BabyBrain."],
    ],
  },
  {
    group: "Managing your account",
    items: [
      ["Can I manage passes I've already bought?", "Yes — with Plus, your packages and make-up tokens across every provider live in one place on your profile, so you never lose track of what you've paid for. Just click through to use them. On the free plan, these are sent to you by email to use from there."],
      ["How do make-up classes work?", "Make-up tokens follow each provider's own rules. With Plus, they're gathered on your profile and you click through to book one. On the free plan, they come to you by email and you book from the link there."],
      ["What if I have more than one child?", "Add as many children as you like on the free plan — your family profile holds all of them, and you'll see suggestions based on each child's age and your preferences, with every booking in one place."],
      ["Why should I upgrade to Plus?", "Free covers everything you need to browse & book, keep your family profile and get suggestions. Plus (SGD 9/month or SGD 99/year) adds twice-weekly curated activity emails, all your packages and make-up tokens for every vendor in one place, saved favourite providers, exporting and sharing your booked activities in calendar view, messaging integrated providers and other parents booked on the same activity, and priority support."],
      ["Can I cancel my Plus subscription anytime?", "Yes. On the monthly plan you can cancel anytime with 14 days' notice. The annual plan runs for the full year and isn't refundable if you cancel partway through."],
      ["Why can I see messages from parents and the provider but not respond?", "Seeing messages on your booked classes comes with every account. Sending them is a Plus feature — and the provider needs to offer messaging too. Upgrade to Plus, and where the provider has it enabled, you'll be able to message them and other parents in the class."],
    ],
  },
  {
    group: "Providers & activities",
    items: [
      ["Are the providers on BabyBrain vetted or endorsed?", "Every provider here has been tried and tested by the parent community behind BabyBrain. That's not formal vetting, and we don't take liability for the activities — but it does mean real parents have used them."],
      ["There's an activity I love that I can't find here — can I ask for it to be added?", <>Yes, please do — we're always growing our list, just drop us a message via our <a href="/contact" className={FAQ_LINK}>Contact Us page</a>.</>],
      ["I'm an activity provider — how do I join?", <>We'd love to have a conversation with you. Head to our <a href="/vendor/" className={FAQ_LINK}>For Partners page</a> and send us an enquiry.</>],
    ],
  },
  {
    group: "Privacy & safety",
    items: [
      ["How is my data — and my children's information — handled?", <>We take your family's privacy seriously and only collect what we need to run your account and bookings — like your details, your children's ages and preferences, and payment through Stripe (we never store your card). Full details are in our <a href="/terms#privacy" className={FAQ_LINK}>Privacy Policy</a>.</>],
      ["Does BabyBrain advise on what's right for my child's development?", "We share recommendations to make finding activities easier, but we do not provide professional advice. For anything to do with your child's health or development, always speak to a qualified professional."],
    ],
  },
];

/** Contact form that emails the support inbox.
 *
 *  QA: "Bottom of contact page, doesn't make sense to have 'still need help'
 *  and 'send us a message' since that is directly above — could we add a
 *  contact form here which sends to the e-mail?" */
function ContactForm() {
  const { session, profile } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill for signed-in parents so they don't retype what we already know.
  useEffect(() => {
    if (profile?.full_name) setName(profile.full_name);
    if (session?.user.email) setEmail(session.user.email);
  }, [profile, session]);

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold focus:border-baby-pink focus:outline-none";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Please tell us your name.");
    const emailProblem = emailError(email);
    if (emailProblem) return setError(emailProblem);
    if (message.trim().length < 10) return setError("Please add a little more detail to your message.");
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/contact", {
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        message: message.trim(),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't send that — please email us directly.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-[18px] border border-[#EBE3E5] bg-white p-8 text-center shadow-card">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#F1FBEF] text-[#A8E59A]"><Icon name="check" className="h-8 w-8" /></span>
        <h2 className="mt-4 text-2xl font-black">Message sent</h2>
        <p className="mt-2 font-semibold text-[#59658d]">Thanks {name.split(" ")[0]} — we endeavour to reply within 3 days.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[18px] border border-[#EBE3E5] bg-white p-6 shadow-card sm:p-8">
      <h2 className="text-[28px] font-black leading-tight text-baby-orange">Still don't have the answer you are looking for?</h2>
      <h3 className="mt-2 text-2xl font-black">Send us a message</h3>
      <p className="mt-1 font-semibold text-[#68718f]">Fill this in and it comes straight to our inbox.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-black">Your name</label>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sarah Tan" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-black">Email address</label>
          <input type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
        </div>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-sm font-black">Subject <span className="font-semibold text-[#6D748D]">(optional)</span></label>
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's this about?" />
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-sm font-black">Message</label>
        <textarea
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help?"
          className="w-full rounded-[10px] border border-[#FED7E4] px-3 py-2.5 text-sm font-semibold focus:border-baby-pink focus:outline-none"
        />
      </div>
      {error && <p role="alert" className="mt-3 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
      <Button type="submit" className="mt-4 w-full justify-center sm:w-auto" disabled={busy}>
        {busy ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}

export default function ContactPage() {
  // Vite renders after the browser has already tried to resolve #faq, so a
  // link from another page landed at the top of Contact. Scroll once mounted.
  useEffect(() => {
    if (window.location.hash !== "#faq") return;
    return scrollToWhenReady("faq");
  }, []);
  return (
    <PageShell active="/contact">
      <main className="mx-auto max-w-[1024px] px-6 py-8">
        <section className="grid items-center gap-7 md:grid-cols-[1fr_420px]">
          <div>
            {/* Blue, not pink. The eyebrow is 18px bold — just under the
                large-text threshold — so it takes the readable blue ink;
                the heart beside it is decorative and can run brighter. */}
            <p className="mb-5 flex items-center gap-2 text-lg font-black text-palette-blue">We're here to help! <Icon name="heart" className="h-5 w-5 fill-current text-palette-blue" /></p>
            <h1 className="text-[40px] font-black leading-tight">How can our team support you today?</h1>
            <p className="mt-5 text-lg font-semibold leading-8 text-[#68718f]">Have a question, feedback, or need assistance? Our team is happy to help.</p>
          </div>
          {/* The reply-time note used to be absolutely positioned over the
              mascot. The logo is far wider than that illustration, so the note
              covered most of it — they sit side by side now instead. */}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-end">
            <div className="rounded-[16px] bg-white p-4 text-sm font-semibold leading-6 shadow-soft sm:max-w-[190px] sm:shrink">We endeavor to respond within 3 days. If more urgent, please call us. <Icon name="heart" className="inline h-4 w-4 fill-current text-palette-blue" /></div>
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="h-[200px] shrink-0 object-contain" />
          </div>
        </section>

        <section className="mt-8">
          <SectionTitle emoji="👇🏻">Get in touch</SectionTitle>
          {/* QA 21/08: "can we remove the message us options to save credits for
              the users messaging vendors and each other" — the in-app support
              chat card is gone, leaving WhatsApp, email and phone. Three
              columns, so the row still fills its width. */}
          <div className="grid gap-5 md:grid-cols-3">
            {[
              { icon: "whatsapp", title: "WhatsApp us", tag: "Recommended", copy: "Message us on WhatsApp for the quickest response.", label: "WhatsApp us", variant: "pink", href: `https://wa.me/${phoneDigits(SUPPORT_PHONE)}` },
              { icon: "mail", title: "Email us", tag: "", copy: "For more complex enquiries, send us an e-mail and we'll get back to you.", label: "Email us", variant: "outline", href: `mailto:${SUPPORT_EMAIL}` },
              { icon: "phone", title: "Call us", tag: "", copy: "Speak with our friendly support team if urgent.", label: "Call us", variant: "outline", href: `tel:+${phoneDigits(SUPPORT_PHONE)}` },
            ].map((c) => (
              <article key={c.title} className="flex flex-col rounded-[16px] border border-[#FED7E4] bg-white/70 p-5 text-center shadow-card">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#FEEBF2] to-[#FED7E4] text-baby-cta"><Icon name={c.icon} className="h-9 w-9" /></div>
                <h3 className="text-xl font-black">{c.title} {c.tag && <span className="rounded-full bg-[#FED7E4] px-2 py-1 text-[10px] text-baby-cta">{c.tag}</span>}</h3>
                <p className="my-5 text-sm font-semibold leading-6 text-[#28345f]">{c.copy}</p>
                <Button variant={c.variant === "pink" ? "pink" : "outline"} className="mt-auto w-full" href={c.href}>{c.label}</Button>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="mt-9 scroll-mt-24">
          <SectionTitle emoji="ℹ️">Frequently asked questions</SectionTitle>
          <div className="space-y-5">
            {FAQ_GROUPS.map(({ group, items }) => (
              <div key={group}>
                <h3 className="mb-2 px-1 text-lg font-black text-baby-lilac">{group}</h3>
                <div className="overflow-hidden rounded-[16px] border border-[#EBE3E5] bg-white">
                  {items.map(([question, answer]) => (
                    <details key={question} className="border-b border-[#F4EFF0] px-6 py-4 last:border-b-0">
                      <summary className="cursor-pointer list-none font-bold">Q&nbsp;&nbsp; {question} <span className="float-right">⌄</span></summary>
                      <p className="mt-3 text-sm font-semibold leading-6 text-[#59658b]">{answer}</p>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="contact-form" className="mt-9 scroll-mt-24">
          <ContactForm />
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}
