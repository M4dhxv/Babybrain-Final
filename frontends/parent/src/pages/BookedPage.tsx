import { useEffect, useState } from "react";
import { PageShell, Button, Icon, Footer } from "../components/ui";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { getParam } from "../lib/nav";
import AddToCalendar from "../components/AddToCalendar";
import SubscribeCalendar from "../components/SubscribeCalendar";
import { useAuth } from "../auth/AuthProvider";
import { usePlan } from "../lib/data";
import { resolveActivityImage, FALLBACK_LOGO_URL } from "../lib/activityMedia";
import { wixThumbUrl } from "../components/ui";
import { canShare, mapsUrl, share } from "../lib/share";

export default function BookedPage() {
  const { session } = useAuth();
  const { isPlus, known: planKnown } = usePlan();
  const title = getParam("title") || "your class";
  const when = getParam("when") || "";
  const status = getParam("status") || "confirmed";
  const start = getParam("start");
  const end = getParam("end");
  const venue = getParam("venue") || "";
  // Who's taking it and where in the building (QA 24/08).
  const staff = getParam("staff") || "";
  const slug = getParam("slug") || "";
  const waitlisted = status === "waitlisted";
  // A party that straddled the session's capacity (00104): the seats that fit
  // are confirmed/paid, this many are still on the waitlist.
  const wlLeft = Number(getParam("wl") || 0);

  /* QA 24/08 + 28/08: "you can't change the information on the activity
     confirmation screen" and "vendors currently can't edit the message that is
     displayed under what to bring & know". This page was entirely hardcoded —
     every booking, whatever it was for, showed the same music-class blurb, the
     same photo and the same three generic cards. It now reads the real
     activity, including the two fields vendors can write (migration 00074). */
  const [detail, setDetail] = useState<{
    description: string | null;
    image_urls: string[] | null;
    image_source: string | null;
    cover_image_url: string | null;
    providers: { logo_url: string | null; cover_image_url: string | null; gallery_urls: string[] | null } | null;
    what_to_bring: string | null;
    confirmation_message: string | null;
  } | null>(null);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    supabase
      .from("activities")
      .select("description, image_urls, image_source, cover_image_url, what_to_bring, confirmation_message, providers(logo_url, cover_image_url, gallery_urls)")
      .eq("slug", slug)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) setDetail((data as unknown as typeof detail) ?? null); });
    return () => { cancelled = true; };
  }, [slug]);

  // Paid bookings come back through Stripe; apply the payment immediately
  // rather than waiting on the webhook.
  // A Wix event ticket is only real once the organiser's Wix has accepted the order. When it hasn't
  // yet (their Wix refused it and we are retrying) the parent has paid but holds no ticket, so say so
  // instead of "Your session is booked!". `confirmed` is false only in that case.
  const [unconfirmed, setUnconfirmed] = useState(false);
  useEffect(() => {
    const checkoutSession = getParam("session_id");
    if (checkoutSession) {
      apiPost<{ confirmed?: boolean | null }>("/api/stripe/reconcile", { session_id: checkoutSession })
        .then((r) => { if (r?.confirmed === false) setUnconfirmed(true); })
        .catch(() => {});
    }
  }, []);
  return (
    <PageShell active="/booked" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Session details</span><span>›</span><span className="text-baby-pink">Book</span></div>
        <section className="grid items-center gap-5 rounded-[18px] border border-[#EBE3E5] bg-gradient-to-r from-[#FEEBF2] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="check" className="h-12 w-12" /></span>
          <div><h1 className="text-[36px] font-black">{unconfirmed ? "We've got your payment!" : waitlisted ? "You're on the waitlist!" : "Your session is booked!"}</h1><p className="mt-2 text-lg font-semibold">{unconfirmed ? "We're just finishing confirming your place with the organiser. There's nothing you need to do — we'll email you as soon as it's confirmed, and your ticket will appear under Bookings. If we can't confirm your place, we'll let you know and refund you." : waitlisted ? "This session is full — we'll email you the moment a spot opens up so you can book it. Joining the waitlist is free." : "We can't wait to see your little one there."}</p>{!waitlisted && wlLeft > 0 && <p className="mt-2 font-semibold text-palette-orangeStrong">{wlLeft === 1 ? "One place didn't fit and is on the waitlist" : `${wlLeft} places didn't fit and are on the waitlist`} — we'll email you if a spot opens so you can book {wlLeft === 1 ? "it" : "them"}. You haven't been charged for {wlLeft === 1 ? "it" : "them"}.</p>}</div>
          {/* The full stacked logo (mascot + wordmark), not the confetti mascot
              crop lifted from the mockup — same call as the Book page header,
              which already dropped the confetti. */}
          <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="hidden h-24 object-contain md:block" />
        </section>
        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
          <div className="space-y-5">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Session details</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                {/* The photo the activity page leads with. Until it has loaded, a neutral block: the old
                    fixed stock image flashed here first and read as the wrong class. */}
                {detail || !slug ? (
                  <img
                    src={wixThumbUrl(detail ? (resolveActivityImage(detail, detail.providers) ?? FALLBACK_LOGO_URL) : FALLBACK_LOGO_URL, 490, 416)}
                    alt=""
                    className="h-52 w-full rounded-[12px] bg-[#F3EDF0] object-contain"
                  />
                ) : (
                  <div className="h-52 w-full rounded-[12px] bg-[#F3EDF0]" />
                )}
                <div>
                  <h3 className="text-xl font-black">{title}</h3>
                  {when && <div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />{when}</p></div>}
                  {/* Tap for directions: Apple Maps on iPhone, Google Maps elsewhere. */}
                  {venue && <p className="mt-3 font-semibold text-[#4a5685]"><Icon name="pin" className="mr-2 inline h-5 w-5 text-baby-lilac" /><a href={mapsUrl(venue)} target="_blank" rel="noopener noreferrer" className="underline decoration-[#C7B1E6] decoration-dotted underline-offset-4 hover:text-baby-cta">{venue}</a></p>}
                </div>
              </div>
              {detail?.description?.trim() && (
                <div className="mt-5 border-t border-[#F4EFF0] pt-5">
                  <h3 className="font-black">About this session</h3>
                  <p className="mt-3 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.description.trim()}</p>
                </div>
              )}
              {detail?.confirmation_message?.trim() && (
                <div className="mt-5 rounded-[12px] bg-[#F4F0FA] p-4">
                  <h3 className="font-black text-baby-lilac">From {`“${title}”`}</h3>
                  <p className="mt-2 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.confirmation_message.trim()}</p>
                </div>
              )}
            </article>
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">What to bring &amp; know</h2>
              {detail?.what_to_bring?.trim() ? (
                <p className="mt-5 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{detail.what_to_bring.trim()}</p>
              ) : (
                /* Fallback while a vendor hasn't written their own. */
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  {[["bell", "Arrive 10 mins early", "Enable your child to get comfortable"], ["shoe", "Dress comfortably", "Allow for movement and potential mess"], ["bottle", "Bring essentials", "Socks, water and wipes encouraged"]].map(([icon, title, note]) => <div key={title} className="text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta"><Icon name={icon} className="h-8 w-8" /></span><h3 className="mt-3 font-black">{title}</h3><p className="mt-2 text-sm font-semibold text-[#59658d]">{note}</p></div>)}
                </div>
              )}
            </article>
          </div>
          <aside className="lg:sticky lg:top-[90px] lg:self-start">
            {/* The scroll boundary on desktop: max-height + overflow live on
                this wrapper, which also owns the rounded corners (16px,
                matching both cards below) — not on the <aside> above, a plain
                rectangle with no radius of its own, whose native scrollbar
                would otherwise be drawn flush with ITS square edge and poke
                out past the rounded cards sitting inside it. Unconstrained on
                mobile, where this is just a normal-flow block. */}
            <div className="space-y-5 lg:max-h-[calc(100dvh-106px)] lg:overflow-y-auto lg:rounded-[16px] bb-slim-scroll">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Activity</span><span className="text-right">{title}</span></p>{when && <p className="flex justify-between"><span>When</span><span className="text-right">{when}</span></p>}{venue && <p className="flex justify-between"><span>Where</span><span className="text-right">{venue}</span></p>}{staff && <p className="flex justify-between"><span>With</span><span className="text-right">{staff}</span></p>}<p className="flex justify-between"><span>Status</span><strong className={waitlisted ? "text-palette-yellow" : "text-palette-green"}>{waitlisted ? "Waitlisted" : "Confirmed"}</strong></p></div>
              <p className={`mt-5 rounded-[12px] p-4 font-semibold ${waitlisted ? "bg-amber-50 text-palette-yellow" : "bg-[#F1FBEF] text-palette-green"}`}><Icon name="check" className="mr-2 inline h-5 w-5" /> {waitlisted ? "Added to the waitlist" : "Booking confirmed"}</p>
              <Button href="/profile?tab=bookings" className="mt-5 w-full">View my bookings</Button>
              {/* Phones only: pass the booking on to a partner or helper through
                  the share sheet (WhatsApp, iMessage, AirDrop). */}
              {canShare() && (
                <Button
                  variant="outline"
                  type="button"
                  className="mt-3 w-full"
                  onClick={() =>
                    void share({
                      title,
                      text: [waitlisted ? `On the waitlist: ${title}` : `Booked: ${title}`, when, venue].filter(Boolean).join("\n"),
                      ...(slug ? { url: `${window.location.origin}/activity?slug=${encodeURIComponent(slug)}` } : {}),
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
                  </svg>
                  Share booking
                </Button>
              )}
              {start && (
                <AddToCalendar event={{ id: `${start}-${title}`, title, startsAt: start, endsAt: end || null, venue }} />
              )}
              {/* Live version of "add to calendar": this booking and every future
                  one land in (and stay current in) the parent's calendar. */}
              {session && planKnown && (
                <div className="mt-4 border-t border-[#F4EFF0] pt-4">
                  {isPlus ? (
                    <SubscribeCalendar intro="Add this booking, and every future one, to your calendar once. It updates on its own if a session moves or is cancelled." />
                  ) : (
                    /* Calendar sync is a Plus feature (same as the schedule export). */
                    <a
                      href="/pricing"
                      className="block rounded-[10px] bg-[#FEF4EB] px-3 py-2.5 text-center text-sm font-black text-[#C2691F] hover:bg-[#FDECD9]"
                    >
                      Keep your calendar up to date automatically with Plus &rarr;
                    </a>
                  )}
                </div>
              )}
            </article>
            <article className="rounded-[16px] bg-[#F4F0FA] p-6">
              <h2 className="text-xl font-black text-baby-lilac">Need help?</h2>
              <p className="mt-3 font-semibold">Questions about this session? Message the provider directly.</p>
              <Button
                href={slug ? `/activity?slug=${encodeURIComponent(slug)}#enquire` : "/contact"}
                variant="outline"
                className="mt-4 w-full"
              >
                <Icon name="mail" className="h-4 w-4" /> Message the provider
              </Button>
              <a href="/contact" className="mt-3 block text-center text-sm font-black text-baby-lilac hover:underline">
                Contact BabyBrain support →
              </a>
            </article>
            </div>
          </aside>
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}
