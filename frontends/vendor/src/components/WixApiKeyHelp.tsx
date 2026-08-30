import { useEffect, useRef, useState } from 'react';
import { HelpCircle, ExternalLink } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';

/**
 * Replaces the old "More on Wix API keys" link, which sent vendors to a Wix
 * support article that Wix had since retired ("We can't find the page you
 * are looking for" — QA 25/08). Wix has moved that content at least once
 * before, so rather than chase another URL, this answers the three questions
 * that link actually needed to answer directly, in-app, and keeps only one
 * link out to Wix — labelled as the complete reference, not the primary
 * explanation — so a future page move there can't break this again.
 *
 * Two pieces, used together:
 *   <WixApiKeyHelp>{...the whole Wix box...<WixApiKeyHelpTrigger /></WixApiKeyHelp>
 *
 * The popover is anchored to the *whole box* (via Radix's Anchor, decoupled
 * from the click target) rather than to the trigger text alone. Anchoring to
 * just the trigger — a small link near the *bottom* of a tall box — was what
 * made the panel land overlapping the box's own fields instead of clearly
 * beside it: Radix positions relative to whatever it's anchored to, and a
 * trigger sitting deep inside a tall card is a poor stand-in for "beside the
 * card". Anchoring to the card itself fixes that at the source.
 *
 * Used from both Wix-integration boxes on Settings → Integrate your
 * Business (the connected view and the connect/edit form), so the copy only
 * lives in one place.
 */

/** The popover's own width (28rem) plus its offset and collision padding —
 *  the actual amount of clear space it needs to the right of the box to
 *  render without overflowing. Kept as one constant so the measurement
 *  below and the rendered width can never quietly drift apart. */
const POPOVER_WIDTH_PX = 448; // 28rem
const REQUIRED_RIGHT_SPACE_PX = POPOVER_WIDTH_PX + 12 /* sideOffset */ + 16 /* collisionPadding */;

/**
 * side="right" on a narrow screen — or, it turns out, on plenty of ordinary
 * desktop widths once a sidebar and the panel's own max-w-2xl are accounted
 * for — measured as landing well past the right edge, genuinely off-screen,
 * not just visually tight. Floating UI's collision handling explains why:
 * for a *horizontal* side, `shift` only ever corrects the *vertical*
 * cross-axis; overflow along the main (horizontal) axis is handled by
 * flipping to the opposite side, not by sliding back, and flipping
 * right→left doesn't help when there isn't room on either side. A fixed
 * viewport-width breakpoint can't know how much of that width a sidebar and
 * this specific box already consumed, so this measures the box's own actual
 * position instead: side="bottom" whenever the *real* space to its right —
 * not just a guess from screen size — is too small for the popover. `shift`
 * corrects the *horizontal* cross-axis for a vertical side, so "bottom"
 * reliably stays on-screen regardless of where the box sits.
 *
 * Measured again every time the popover actually opens, not just once at
 * mount: a one-shot mount-time measurement can get stuck wrong — layout not
 * yet settled on first paint, a sidebar collapsing afterward, content still
 * loading — with nothing to correct it afterward beyond a window resize.
 * Re-measuring on open means it's always checked at the one moment it
 * actually needs to be right, using whatever the page looks like right then.
 */
function useFitsBesideAnchor(anchorRef: React.RefObject<HTMLElement | null>) {
  const [fits, setFits] = useState(true);
  const measure = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    // A width of 0 means the frame hasn't actually laid out yet — keep the
    // previous value rather than act on a reading that isn't real.
    if (!rect || window.innerWidth === 0) return;
    setFits(window.innerWidth - rect.right >= REQUIRED_RIGHT_SPACE_PX);
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { fits, measure };
}

export function WixApiKeyHelp({ children }: { children: React.ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { fits: fitsRight, measure } = useFitsBesideAnchor(anchorRef);
  return (
    <Popover onOpenChange={(open) => { if (open) measure(); }}>
      {/* asChild so this adds no extra DOM element beyond the `relative` it
          needs as the floating-position reference — the box renders exactly
          as it did before. */}
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative">{children}</div>
      </PopoverAnchor>
      <PopoverContent
        side={fitsRight ? 'right' : 'bottom'}
        align="start"
        sideOffset={12}
        collisionPadding={16}
        // Bigger, per request — and capped against however much room Radix
        // actually found (its own --available-height var) so "bigger" can
        // never mean "taller than the screen"; it scrolls internally instead.
        className="w-[28rem] max-w-[calc(100vw-2rem)] max-h-[min(34rem,var(--radix-popover-content-available-height))] overflow-y-auto p-0"
      >
        {/* type="single" + collapsible is what gives "opening one closes the
            others" for free — Radix only ever tracks one open item. */}
        <Accordion type="single" collapsible className="px-1">
          <AccordionItem value="what">
            <AccordionTrigger className="px-4 text-base">What is API key and Site ID?</AccordionTrigger>
            <AccordionContent className="px-4 text-sm text-gray-600 space-y-2">
              <p>
                Your <strong>API key</strong> is a private token that proves to Wix a request is really
                coming from your account — it's how BabyBrain is allowed to read your services and
                schedule on your behalf, without ever needing your Wix login.
              </p>
              <p>
                Your <strong>Site ID</strong> tells Wix <em>which</em> of your sites to look at. One Wix
                account can run more than one site, so this makes sure we only ever pull from the one
                you've connected here.
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="how">
            <AccordionTrigger className="px-4 text-base">How to access these credentials?</AccordionTrigger>
            <AccordionContent className="px-4 text-sm text-gray-600 space-y-4">
              <div>
                <p className="mb-1.5 font-semibold text-gray-800">API key</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Open your Wix dashboard.</li>
                  <li>
                    Go to <strong>Settings → Development &amp; Integrations</strong>.
                  </li>
                  <li>
                    Select <strong>Headless Settings</strong>.
                  </li>
                  <li>
                    Click <strong>Manage API Key</strong>.
                  </li>
                  <li>
                    Click <strong>Generate API Key</strong>.
                  </li>
                  <li>
                    Choose <strong>All site permissions</strong>.
                  </li>
                  <li>
                    Click <strong>Generate Key</strong>.
                  </li>
                  <li>Copy it immediately — Wix only shows it once.</li>
                </ol>
              </div>
              <div>
                <p className="mb-1.5 font-semibold text-gray-800">Site ID</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Open your Wix dashboard.</li>
                  <li>Look at your browser's address bar — it follows this pattern:</li>
                </ol>
                <p className="mt-1.5 rounded-lg bg-gray-50 px-2.5 py-1.5 font-mono">
                  wix.com/dashboard/<span className="font-bold text-[#FA4D8D]">SITE_ID</span>/home
                </p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5" start={3}>
                  <li>
                    Copy just the <span className="font-bold text-[#FA4D8D]">SITE_ID</span> part — the
                    segment between <span className="font-mono">/dashboard/</span> and{' '}
                    <span className="font-mono">/home</span>.
                  </li>
                </ol>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="fetch">
            <AccordionTrigger className="px-4 text-base">What do we fetch?</AccordionTrigger>
            <AccordionContent className="px-4 text-sm text-gray-600 space-y-2">
              <p>Just what's needed to list and book your classes:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Class or service name &amp; description</li>
                <li>Price</li>
                <li>Location</li>
                <li>Schedule &amp; available spots</li>
                <li>Cover photo, if you have one</li>
              </ul>
              <p>
                That's it — nothing about your Wix account, payments, or other site content is ever
                touched.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="border-t border-gray-100 px-4 py-3">
          <a
            href="https://dev.wix.com/docs/rest/articles/getting-started/api-keys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-[#FA4D8D] hover:underline"
          >
            Read the complete Wix documentation <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The click target — placed wherever inside the box the old link used to
 *  sit. Positioning comes entirely from the box-level Anchor above; this
 *  only opens and closes it. */
export function WixApiKeyHelpTrigger() {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-[#FA4D8D] hover:underline"
      >
        More on Wix API keys <HelpCircle className="w-3 h-3" />
      </button>
    </PopoverTrigger>
  );
}

export default WixApiKeyHelp;
