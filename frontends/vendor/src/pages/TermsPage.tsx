import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, Menu, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import SiteFooter from '@/components/SiteFooter';
import { BrandLogo } from '@/components/BrandLogo';
import { LEGAL_DOCS, type LegalBlock, type LegalDoc } from '@/data/legalDocs';

/**
 * Partner-side Terms & Conditions. There is ONE site-wide set of legal
 * documents for BabyBrain (they cover parents, providers and payments
 * alike); the parent app renders the same tabs at `/terms`. This copy
 * exists only so the vendor footer's "Terms of Service" / "Privacy Policy"
 * links resolve inside the vendor HashRouter with vendor chrome, instead of
 * handing the tab off to the parent app.
 *
 * The content in ../data/legalDocs.ts is a verbatim mirror of
 * frontends/parent/src/data/legalDocs.ts — keep the two in sync.
 */

/** Underlines site links (www.babybrain.sg, https://…) inside a plain-text
 *  run — the legal text names its own domain a few times and those reads
 *  more like a link than plain prose. */
function withLinks(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s"']+|www\.[^\s"']+)/g);
  return parts.map((part, i) =>
    /^(https?:\/\/|www\.)/.test(part) ? (
      <span key={`${keyPrefix}-${i}`} className="underline">
        {part}
      </span>
    ) : (
      part
    )
  );
}

/** Renders "**bold**" spans inside otherwise-plain legal text as <strong>. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-bold text-[#111A4C]">
            {withLinks(part, `b${i}`)}
          </strong>
        ) : (
          withLinks(part, `p${i}`)
        )
      )}
    </>
  );
}

/** A clause written entirely in caps (Limitation of Liability etc.) gets a
 *  callout treatment instead of being buried as a wall of shouty text. */
function isShoutClause(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '');
  return letters.length > 60 && letters === letters.toUpperCase();
}

function Block({ block }: { block: LegalBlock }) {
  if (Array.isArray(block)) {
    return (
      <ul className="mt-2 space-y-1.5 pl-1">
        {block.map((item, i) => (
          <li key={i} className="flex gap-2 leading-7 text-gray-600">
            <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#FA4D8D]" />
            <span>
              <Inline text={item} />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (isShoutClause(block)) {
    return (
      <div className="mt-3 rounded-xl border border-pink-100 bg-pink-50/60 p-4">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#FA4D8D]">
          <ShieldAlert className="h-3.5 w-3.5" /> Important
        </p>
        <p className="mt-1.5 text-[13px] font-semibold leading-6 tracking-tight text-gray-600">
          <Inline text={block} />
        </p>
      </div>
    );
  }
  return (
    <p className="mt-3 leading-7 text-gray-600">
      <Inline text={block} />
    </p>
  );
}

function DocContent({ doc }: { doc: LegalDoc }) {
  return (
    <div>
      {doc.intro.length > 0 && (
        <div className="mb-6 rounded-xl border border-red-400 bg-gray-50 p-4">
          {doc.intro.map((b, i) => (
            <p key={i} className="leading-7 text-gray-600">
              <Inline text={b as string} />
            </p>
          ))}
        </div>
      )}
      <div className="space-y-9">
        {doc.sections.map((s) => (
          <section key={s.number} id={`${doc.key}-s${s.number}`} className="scroll-mt-24">
            <h2 className="text-lg font-bold text-[#111A4C]">
              {s.number}. {s.title}
            </h2>
            {s.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </section>
        ))}
      </div>
      {doc.key === 'privacy' && (
        <div className="mt-9 flex items-start gap-3 rounded-xl bg-purple-50 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white">
            <Mail className="h-4 w-4 text-purple-600" />
          </span>
          <div>
            <p className="font-bold text-[#111A4C]">Questions about your data?</p>
            <p className="mt-0.5 text-gray-600">
              Our Data Protection Officer, Katie Crowson, handles access, correction and consent requests — email{' '}
              <a href="mailto:hello@babybrain.sg" className="text-[#FA4D8D] underline">
                hello@babybrain.sg
              </a>
              .
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Floating "On this page" pill + popover — the sole way to jump to a
 *  section, on every screen size, so a long legal document never needs a
 *  persistent sidebar. */
function OnThisPage({ doc }: { doc: LegalDoc }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // On phones the label folds into just the icon after a few seconds, so the pill stops covering the text.
  useEffect(() => {
    const timer = setTimeout(() => setCollapsed(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => setOpen(false), [doc.key]);

  return (
    <div ref={ref} className="fixed bottom-6 right-6 z-40">
      {open && (
        <nav className="absolute bottom-[calc(100%+10px)] right-0 max-h-[60vh] w-64 space-y-0.5 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-2 shadow-lg">
          {doc.sections.map((s) => (
            <a
              key={s.number}
              href={`#${doc.key}-s${s.number}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`${doc.key}-s${s.number}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setOpen(false);
              }}
              className="block rounded-lg px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 hover:text-[#111A4C]"
            >
              {s.number}. {s.title}
            </a>
          ))}
        </nav>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="On this page"
        className={`flex items-center rounded-full bg-[#FA4D8D] py-3 text-sm font-bold text-white shadow-lg transition-all duration-300 motion-reduce:transition-none md:gap-2 md:px-4 ${collapsed ? 'gap-0 px-3.5' : 'gap-2 px-4'}`}
      >
        <Menu className="h-4 w-4" />
        <span
          aria-hidden="true"
          className={`overflow-hidden whitespace-nowrap transition-all duration-300 motion-reduce:transition-none md:max-w-[8rem] md:opacity-100 ${collapsed ? 'max-w-0 opacity-0' : 'max-w-[8rem] opacity-100'}`}
        >
          On this page
        </span>
      </button>
    </div>
  );
}

export default function TermsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeKey, setActiveKey] = useState<LegalDoc['key']>('tos');
  const doc = useMemo(() => LEGAL_DOCS.find((d) => d.key === activeKey)!, [activeKey]);

  /* Footer links here as `/terms#privacy` (or `/terms#tos`); under HashRouter
     that lands as `#/terms#privacy`, which react-router parses into
     location.hash = "#privacy". Keyed on `location.hash` (not just on
     mount): react-router keeps this page mounted for any /terms* URL, so a
     footer link clicked while already on this page (e.g. switching from the
     Privacy tab back to Terms of Service) only shows up as a hash change,
     not a remount. */
  useEffect(() => {
    if (location.hash === '#privacy') setActiveKey('privacy');
    else if (location.hash === '#tou') setActiveKey('tou');
    else if (location.hash === '' || location.hash === '#tos') setActiveKey('tos');
  }, [location.hash]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [activeKey]);

  /* Keep the URL's hash in step with the active tab, so a link back to this
     page always lands on the right tab even though this page never unmounts
     to pick it up fresh — a plain state change wouldn't touch the address
     bar at all. */
  function selectDoc(key: LegalDoc['key']) {
    setActiveKey(key);
    const hash = `#${key}`;
    if (location.hash !== hash) navigate({ hash }, { replace: true });
  }

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

      <main className="mx-auto max-w-[760px] px-6 py-10 sm:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-[#111A4C] sm:text-4xl">Terms &amp; Policies</h1>
          <p className="mt-2 text-sm font-semibold text-gray-400">Last updated: {doc.updated}</p>
          <p className="mx-auto mt-4 max-w-xl leading-7 text-gray-600">
            Our Terms of Service, Terms of Use and Privacy Policy in full — covering bookings, payments, vendor
            obligations and how we handle data under Singapore's PDPA.
          </p>

          <Tabs value={activeKey} onValueChange={(v) => selectDoc(v as LegalDoc['key'])} className="mt-7 items-center">
            <TabsList className="no-scrollbar h-auto w-fit max-w-full justify-start gap-1 overflow-x-auto rounded-full bg-gray-100 p-1.5">
              {LEGAL_DOCS.map((d) => (
                <TabsTrigger
                  key={d.key}
                  value={d.key}
                  className="rounded-full px-4 py-2 text-sm font-bold text-gray-500 data-[state=active]:bg-white data-[state=active]:text-[#FA4D8D] data-[state=active]:shadow-sm"
                >
                  {d.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="mt-10">
          <DocContent doc={doc} />
        </div>
      </main>

      <OnThisPage doc={doc} />
      <SiteFooter />
    </div>
  );
}
