import { Instagram, Mail, MessageCircle, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Footer for the vendor portal — QA: "On vendor portal, there is no footer."
 * Shown on the public partner pages and beneath the signed-in portal.
 */

export const SUPPORT_EMAIL = 'partners@babybrain.sg';
export const SUPPORT_PHONE = '+65 8996 6716';
export const phoneDigits = (p: string) => p.replace(/[^\d]/g, '');

const columns: { title: string; links: { label: string; to?: string; href?: string }[] }[] = [
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
      { label: 'Privacy Policy', href: '/terms#privacy' },
      { label: 'Terms of Service', href: '/terms' },
    ],
  },
  {
    title: 'For Parents',
    links: [
      { label: 'Explore Activities', href: '/explore' },
      { label: 'About Us', href: '/about' },
      { label: 'Parent Sign Up', href: '/onboarding' },
    ],
  },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white px-6 py-10 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div>
          <BrandLogo className="h-10" />
          <p className="mt-3 max-w-[260px] text-sm text-gray-500">
            Helping Singapore's activity providers reach the parents looking for them.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <a
              href={`https://wa.me/${phoneDigits(SUPPORT_PHONE)}`}
              target="_blank"
              rel="noreferrer"
              aria-label="WhatsApp us"
              className="grid h-9 w-9 place-items-center rounded-full bg-green-50 text-green-600 hover:bg-green-100"
            >
              <MessageCircle className="h-4 w-4" />
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              aria-label="Email us"
              className="grid h-9 w-9 place-items-center rounded-full bg-pink-50 text-[#E91E63] hover:bg-pink-100"
            >
              <Mail className="h-4 w-4" />
            </a>
            <a
              href={`tel:+${phoneDigits(SUPPORT_PHONE)}`}
              aria-label="Call us"
              className="grid h-9 w-9 place-items-center rounded-full bg-purple-50 text-purple-600 hover:bg-purple-100"
            >
              <Phone className="h-4 w-4" />
            </a>
            <a
              href="https://instagram.com/babybrainsg"
              target="_blank"
              rel="noreferrer"
              aria-label="Instagram"
              className="grid h-9 w-9 place-items-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100"
            >
              <Instagram className="h-4 w-4" />
            </a>
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.title} className="text-sm">
            <h3 className="mb-3 font-bold text-gray-900">{col.title}</h3>
            <div className="space-y-1.5 text-gray-500">
              {col.links.map((l) => (
                <p key={l.label}>
                  {l.to ? (
                    <Link to={l.to} className="hover:text-[#E91E63]">{l.label}</Link>
                  ) : (
                    <a href={l.href} className="hover:text-[#E91E63]">{l.label}</a>
                  )}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-8 text-center text-xs text-gray-400">
        © {new Date().getFullYear()} BabyBrain.sg. All rights reserved.
      </p>
    </footer>
  );
}
