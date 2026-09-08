import { Instagram, Mail, MessageCircle, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Footer for the vendor portal — QA: "On vendor portal, there is no footer."
 * Shown on the public partner pages and beneath the signed-in portal.
 */

// QA: "On contact us page, e-mail takes you to send an e-mail to
// partners@babybrain.sg which doesn't exist — should go to hello@babybrain.sg."
export const SUPPORT_EMAIL = 'hello@babybrain.sg';
export const SUPPORT_PHONE = '+65 8996 6716';
export const phoneDigits = (p: string) => p.replace(/[^\d]/g, '');

/* `to` → in-app react-router link (stays in the vendor HashRouter).
   `href` → the parent/consumer site at the domain root; `blank` opens it in a
   new tab so it can't take over the portal tab (the shared Supabase session on
   the same domain would otherwise boot the parent UI in place — the "About
   swaps me to the parent interface" bug). */
const columns: {
  title: string;
  links: { label: string; to?: string; href?: string; blank?: boolean }[];
}[] = [
  {
    title: 'For Partners',
    links: [
      { label: 'Why BabyBrain', to: '/' },
      { label: 'Plans & Pricing', to: '/plans' },
      { label: 'Claim Your Business', to: '/claim-business' },
      { label: 'Partner Log In', to: '/login' },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'Contact Us', to: '/contact' },
      { label: 'FAQs', to: '/contact#faq' },
      { label: 'Privacy Policy', href: '/terms#privacy', blank: true },
      { label: 'Terms of Service', href: '/terms', blank: true },
    ],
  },
  {
    title: 'For Parents',
    links: [
      // These are genuine consumer-site destinations (there's no vendor
      // equivalent), so they stay `href` — but `blank` so a vendor who clicks
      // one gets the parent site in a NEW tab instead of it replacing the
      // portal in place. About Us is shared content, so it's an in-app vendor
      // page (`to`) rather than a jump to the parent app.
      // QA 21/08: "under for parents add 'Home' at the top".
      { label: 'Home', href: '/', blank: true },
      { label: 'Explore Activities', href: '/explore', blank: true },
      { label: 'About Us', to: '/about' },
      { label: 'Parent Sign Up', href: '/onboarding', blank: true },
    ],
  },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white px-6 py-14 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div>
          <BrandLogo className="h-12" />
          <p className="mt-4 max-w-[280px] text-base text-gray-500">
            Helping Singapore's activity providers reach the parents looking for them.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <a
              href={`https://wa.me/${phoneDigits(SUPPORT_PHONE)}`}
              target="_blank"
              rel="noreferrer"
              aria-label="WhatsApp us"
              className="grid h-11 w-11 place-items-center rounded-full bg-green-50 text-green-600 hover:bg-green-100"
            >
              <MessageCircle className="h-5 w-5" />
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              aria-label="Email us"
              className="grid h-11 w-11 place-items-center rounded-full bg-pink-50 text-[#FA4D8D] hover:bg-pink-100"
            >
              <Mail className="h-5 w-5" />
            </a>
            <a
              href={`tel:+${phoneDigits(SUPPORT_PHONE)}`}
              aria-label="Call us"
              className="grid h-11 w-11 place-items-center rounded-full bg-purple-50 text-purple-600 hover:bg-purple-100"
            >
              <Phone className="h-5 w-5" />
            </a>
            <a
              href="https://instagram.com/babybrainsg"
              target="_blank"
              rel="noreferrer"
              aria-label="Instagram"
              className="grid h-11 w-11 place-items-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100"
            >
              <Instagram className="h-5 w-5" />
            </a>
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.title} className="text-base">
            <h3 className="mb-4 font-bold text-gray-900">{col.title}</h3>
            <div className="space-y-2.5 text-gray-500">
              {col.links.map((l) => (
                <p key={l.label}>
                  {l.to ? (
                    <Link to={l.to} className="hover:text-[#FA4D8D]">{l.label}</Link>
                  ) : (
                    <a
                      href={l.href}
                      {...(l.blank ? { target: '_blank', rel: 'noreferrer' } : {})}
                      className="hover:text-[#FA4D8D]"
                    >
                      {l.label}
                    </a>
                  )}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-10 text-center text-sm text-gray-400">
        © {new Date().getFullYear()} BabyBrain.sg. All rights reserved.
      </p>
    </footer>
  );
}
