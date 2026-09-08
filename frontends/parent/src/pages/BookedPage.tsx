import { useEffect, useState } from "react";
import { PageShell, Button, Icon, Footer } from "../components/ui";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { getParam } from "../lib/nav";
import { downloadBookingIcs } from "../lib/ics";

export default function BookedPage() {
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
    what_to_bring: string | null;
    confirmation_message: string | null;
  } | null>(null);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    supabase
      .from("activities")
      .select("description, image_urls, what_to_bring, confirmation_message")
      .eq("slug", slug)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) setDetail(data ?? null); });
    return () => { cancelled = true; };
  }, [slug]);

  // Paid bookings come back through Stripe; apply the payment immediately
  // rather than waiting on the webhook.
  useEffect(() => {
    const checkoutSession = getParam("session_id");
    if (checkoutSession) {
      apiPost("/api/stripe/reconcile", { session_id: checkoutSession }).catch(() => {});
    }
  }, []);
  return (
    <PageShell active="/booked" auth="public">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><span>Class details</span><span>›</span><span className="text-baby-pink">Book</span></div>
        <section className="grid items-center gap-5 rounded-[18px] border border-[#EBE3E5] bg-gradient-to-r from-[#FEEBF2] to-white p-8 md:grid-cols-[120px_1fr_220px]">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="check" className="h-12 w-12" /></span>
          <div><h1 className="text-[36px] font-black">{waitlisted ? "You're on the waitlist!" : "Your class is booked!"}</h1><p className="mt-2 text-lg font-semibold">{waitlisted ? "This session is full — we'll notify you the moment a spot opens up." : "We can't wait to see your little one there."}</p>{!waitlisted && wlLeft > 0 && <p className="mt-2 font-semibold text-palette-orangeStrong">{wlLeft === 1 ? "One place didn't fit and is on the waitlist" : `${wlLeft} places didn't fit and are on the waitlist`} — we'll email you to pay for {wlLeft === 1 ? "it" : "them"} when a spot opens.</p>}</div>
          {/* The full stacked logo (mascot + wordmark), not the confetti mascot
              crop lifted from the mockup — same call as the Book page header,
              which already dropped the confetti. */}
          <img src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`} alt="BabyBrain" className="hidden h-24 object-contain md:block" />
        </section>
        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
          <div className="space-y-5">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Class details</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                <img
                  src={detail?.image_urls?.[0] || `${import.meta.env.BASE_URL}assets/crops/tiny-tunes.png`}
                  alt=""
                  className="h-52 w-full rounded-[12px] object-cover"
                />
                <div>
                  <h3 className="text-xl font-black">{title}</h3>
                  {when && <div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><Icon name="calendar" className="mr-2 inline h-5 w-5 text-baby-lilac" />{when}</p></div>}
                  {venue && <p className="mt-3 font-semibold text-[#4a5685]"><Icon name="pin" className="mr-2 inline h-5 w-5 text-baby-lilac" />{venue}</p>}
                </div>
              </div>
              {detail?.description?.trim() && (
                <div className="mt-5 border-t border-[#F4EFF0] pt-5">
                  <h3 className="font-black">About this class</h3>
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
          <aside className="space-y-5">
            <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 space-y-4 font-semibold"><p className="flex justify-between"><span>Class</span><span className="text-right">{title}</span></p>{when && <p className="flex justify-between"><span>When</span><span className="text-right">{when}</span></p>}{venue && <p className="flex justify-between"><span>Where</span><span className="text-right">{venue}</span></p>}{staff && <p className="flex justify-between"><span>With</span><span className="text-right">{staff}</span></p>}<p className="flex justify-between"><span>Status</span><strong className={waitlisted ? "text-palette-yellow" : "text-palette-green"}>{waitlisted ? "Waitlisted" : "Confirmed"}</strong></p></div>
              <p className={`mt-5 rounded-[12px] p-4 font-semibold ${waitlisted ? "bg-amber-50 text-palette-yellow" : "bg-[#F1FBEF] text-palette-green"}`}><Icon name="check" className="mr-2 inline h-5 w-5" /> {waitlisted ? "Added to the waitlist" : "Booking confirmed"}</p>
              <Button href="/profile?tab=bookings" className="mt-5 w-full">View my bookings</Button>
              {start && (
                <Button
                  variant="outline"
                  type="button"
                  className="mt-3 w-full"
                  onClick={() => downloadBookingIcs({ id: `${start}-${title}`, title, startsAt: start, endsAt: end || null, venue })}
                >
                  <Icon name="calendar" className="h-4 w-4" /> Add to calendar
                </Button>
              )}
            </article>
            <article className="rounded-[16px] bg-[#F4F0FA] p-6">
              <h2 className="text-xl font-black text-baby-lilac">Need help?</h2>
              <p className="mt-3 font-semibold">Questions about this class? Message the provider directly.</p>
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
          </aside>
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}
