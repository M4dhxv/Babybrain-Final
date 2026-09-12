import { useEffect, useMemo, useRef, useState } from "react";
import { PageShell, Footer, Icon } from "../components/ui";
import { routePath, useLocation } from "../lib/nav";
import { LEGAL_DOCS, type LegalBlock, type LegalDoc } from "../data/legalDocs";

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
          <strong key={i} className="font-black text-baby-ink">
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
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 60 && letters === letters.toUpperCase();
}

function Block({ block }: { block: LegalBlock }) {
  if (Array.isArray(block)) {
    return (
      <ul className="mt-2 space-y-1.5 pl-1">
        {block.map((item, i) => (
          <li key={i} className="flex gap-2 font-semibold leading-7 text-[#59658d]">
            <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-baby-pink" />
            <span><Inline text={item} /></span>
          </li>
        ))}
      </ul>
    );
  }
  if (isShoutClause(block)) {
    return (
      <div className="mt-3 rounded-xl border border-[#FED7E4] bg-[#FFF5F8] p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-baby-cta">
          <Icon name="shield" className="h-3.5 w-3.5" /> Important
        </p>
        <p className="mt-1.5 text-[13px] font-bold leading-6 tracking-tight text-[#59658d]">
          <Inline text={block} />
        </p>
      </div>
    );
  }
  return (
    <p className="mt-3 font-semibold leading-7 text-[#59658d]">
      <Inline text={block} />
    </p>
  );
}

function DocContent({ doc }: { doc: LegalDoc }) {
  return (
    <div>
      {doc.intro.length > 0 && (
        <div className="mb-6 rounded-xl border border-red-400 bg-[#FAF7F7] p-4">
          {doc.intro.map((b, i) => (
            <p key={i} className="font-semibold leading-7 text-[#59658d]">
              <Inline text={b as string} />
            </p>
          ))}
        </div>
      )}
      <div className="space-y-9">
        {doc.sections.map((s) => (
          <section key={s.number} id={`${doc.key}-s${s.number}`} className="scroll-mt-28">
            <h2 className="text-lg font-black text-baby-ink">
              {s.number}. {s.title}
            </h2>
            {s.blocks.map((b, i) => <Block key={i} block={b} />)}
          </section>
        ))}
      </div>
      {doc.key === "privacy" && (
        <div className="mt-9 flex items-start gap-3 rounded-xl bg-[#F1EDFB] p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white">
            <Icon name="mail" className="h-4 w-4 text-[#6B5AA8]" />
          </span>
          <div>
            <p className="font-black text-baby-ink">Questions about your data?</p>
            <p className="mt-0.5 font-semibold text-[#59658d]">
              Our Data Protection Officer, Katie Crowson, handles access, correction and consent
              requests — email{" "}
              <a href="mailto:hello@babybrain.sg" className="text-baby-cta underline">
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
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => setOpen(false), [doc.key]);

  return (
    <div ref={ref} className="fixed bottom-6 right-6 z-40">
      {open && (
        <nav className="absolute bottom-[calc(100%+10px)] right-0 max-h-[60vh] w-64 space-y-0.5 overflow-y-auto rounded-2xl border border-[#EBE3E5] bg-white p-2 shadow-soft">
          {doc.sections.map((s) => (
            <a
              key={s.number}
              href={`#${doc.key}-s${s.number}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`${doc.key}-s${s.number}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                setOpen(false);
              }}
              className="block rounded-lg px-3 py-2 text-sm font-semibold text-[#59658d] hover:bg-[#FAF7F7] hover:text-baby-ink"
            >
              {s.number}. {s.title}
            </a>
          ))}
        </nav>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="On this page"
        className={`flex items-center rounded-full bg-baby-cta py-3 text-sm font-black text-white shadow-pink transition-all duration-300 motion-reduce:transition-none md:gap-2 md:px-4 ${collapsed ? "gap-0 px-3.5" : "gap-2 px-4"}`}
      >
        <Icon name="menu" className="h-4 w-4" />
        <span
          aria-hidden="true"
          className={`overflow-hidden whitespace-nowrap transition-all duration-300 motion-reduce:transition-none md:max-w-[8rem] md:opacity-100 ${collapsed ? "max-w-0 opacity-0" : "max-w-[8rem] opacity-100"}`}
        >
          On this page
        </span>
      </button>
    </div>
  );
}

export default function TermsPage() {
  const [activeKey, setActiveKey] = useState<LegalDoc["key"]>("tos");
  const doc = useMemo(() => LEGAL_DOCS.find((d) => d.key === activeKey)!, [activeKey]);
  const loc = useLocation();
  const activeTabRef = useRef<HTMLButtonElement>(null);

  // The pill capsule scrolls horizontally on narrow screens, and landing
  // straight on a tab other than the first (e.g. a footer link to
  // /terms#privacy) never scrolled it into view — Privacy Policy sat
  // half-clipped at the trailing edge. `nearest` only moves the capsule, not
  // the page, since the tab is already vertically in view.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  /* Reached as /terms#privacy, /terms (bare), or the bare /privacy route
     (which Stripe's billing portal links to) — each should select the
     matching tab. Keyed on `loc` (not just on mount): client-side nav keeps
     this page mounted for any /terms* URL, so a footer link clicked while
     already on this page (e.g. switching from the Privacy tab back to
     Terms of Service) only shows up as a hash change, not a remount. */
  useEffect(() => {
    if (window.location.hash === "#privacy" || routePath() === "/privacy") setActiveKey("privacy");
    else if (window.location.hash === "#tou") setActiveKey("tou");
    else if (window.location.hash === "" || window.location.hash === "#tos") setActiveKey("tos");
  }, [loc]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [activeKey]);

  /* Keep the URL's hash in step with the active tab, so a link back to this
     page (e.g. the footer's Terms of Service / Privacy Policy links) always
     lands on the right tab even when this page never unmounts to pick it up
     fresh — a plain state change wouldn't touch the address bar at all. */
  function selectDoc(key: LegalDoc["key"]) {
    setActiveKey(key);
    const hash = `#${key}`;
    if (window.location.hash !== hash) {
      window.history.replaceState({}, "", window.location.pathname + window.location.search + hash);
    }
  }

  return (
    <PageShell active="/terms" auth="public">
      <main className="mx-auto max-w-[760px] px-6 py-10">
        <div className="text-center">
          <h1 className="text-[36px] font-black leading-tight">Terms &amp; Policies</h1>
          <p className="mt-2 text-sm font-bold text-[#6D748A]">Last updated: {doc.updated}</p>
          <p className="mx-auto mt-4 max-w-[560px] font-semibold leading-7 text-[#59658d]">
            Our Terms of Service, Terms of Use and Privacy Policy in full — covering bookings,
            payments, vendor obligations and how we handle your data under Singapore's PDPA.
          </p>

          {/* Tabs */}
          <div className="mt-7 inline-flex max-w-full gap-1.5 overflow-x-auto rounded-full bg-[#F4EFF0] p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {LEGAL_DOCS.map((d) => (
              <button
                key={d.key}
                ref={d.key === activeKey ? activeTabRef : undefined}
                onClick={() => selectDoc(d.key)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-black transition ${
                  d.key === activeKey ? "bg-white text-baby-cta shadow-soft" : "text-[#6D748A] hover:text-baby-ink"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-10">
          <DocContent doc={doc} />
        </div>
      </main>
      <OnThisPage doc={doc} />
      <Footer />
    </PageShell>
  );
}
