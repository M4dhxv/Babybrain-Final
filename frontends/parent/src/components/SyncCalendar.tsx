import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { appleSubscribeUrl, googleSubscribeUrl, isAndroidDevice, isAppleDevice } from "../lib/ics";

type Feed = { url: string; webcalUrl: string };

/** Outlook.com's "subscribe from web" page, pre-filled with the feed. */
const outlookSubscribeUrl = (feedUrl: string) =>
  `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}&name=${encodeURIComponent("BabyBrain")}`;

/**
 * "Sync to calendar" on the Bookings tab: subscribe a calendar to the parent's
 * private schedule feed (/api/public/calendar-feed/<token>.ics), one button per
 * calendar. Same feed and link as SubscribeCalendar (the confirmation page's
 * inline version); this one lays every route out side by side.
 *
 * Per calendar:
 *   - Google: adds the feed to the Google account, so it also shows in the
 *     Calendar app on an Android phone. Android has no "subscribe to a link"
 *     of its own, so this is the Android route.
 *   - Apple: a webcal:// link (see appleSubscribeUrl), which iPhone, iPad and Mac open straight into
 *     Calendar's Subscribe prompt.
 *   - Outlook: Outlook.com's subscribe page. The desktop Outlook app on
 *     Windows takes the copied link under Add calendar, Subscribe from web.
 *
 * The device's own calendar is listed first and filled; the rest are outlined.
 */
export default function SyncCalendar() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load(rotate = false) {
    setErr(null);
    setBusy(true);
    try {
      setFeed(
        rotate
          ? await apiPost<Feed>("/api/customer/calendar-link", {})
          : await apiGet<Feed>("/api/customer/calendar-link")
      );
    } catch {
      setErr("Couldn't get your calendar link. Please try again.");
    }
    setBusy(false);
  }
  useEffect(() => {
    void load();
  }, []);

  async function copy() {
    if (!feed) return;
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Copy this link:", feed.url);
    }
  }

  const options: { key: string; label: string; note: string; run: (f: Feed) => void }[] = [
    {
      key: "google",
      label: "Google Calendar",
      note: "Android phones, or any browser",
      run: (f) => window.open(googleSubscribeUrl(f.webcalUrl), "_blank", "noopener"),
    },
    {
      key: "apple",
      label: "Apple Calendar",
      note: "iPhone, iPad, Mac",
      run: (f) => window.location.assign(appleSubscribeUrl(f.url)),
    },
    {
      key: "outlook",
      label: "Outlook",
      note: "Windows, Outlook.com",
      run: (f) => window.open(outlookSubscribeUrl(f.url), "_blank", "noopener"),
    },
  ];
  const first = isAppleDevice() ? "apple" : isAndroidDevice() ? "google" : /Windows/i.test(navigator.userAgent) ? "outlook" : "google";
  const ordered = [...options].sort((a, b) => Number(b.key === first) - Number(a.key === first));

  const base = "flex min-h-[48px] w-full items-center justify-between gap-3 rounded-[12px] border px-4 py-2 text-left disabled:opacity-50";

  return (
    <div>
      {err && (
        <p className="mb-2 text-sm font-bold text-[#C90044]">
          {err}{" "}
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">Retry</button>
        </p>
      )}
      {busy && !feed && <p className="mb-2 text-sm font-bold text-[#59658d]">Getting your link...</p>}
      <div className="space-y-2">
        {ordered.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={!feed}
            onClick={() => feed && o.run(feed)}
            className={`${base} ${
              o.key === first
                ? "border-transparent bg-[#7D4AC5] text-white hover:brightness-110"
                : "border-palette-purple bg-white text-palette-purpleInk hover:bg-palette-purpleTint"
            }`}
          >
            <span className="text-sm font-black">{o.label}</span>
            <span className={`text-xs font-semibold ${o.key === first ? "text-white/85" : "text-[#59658d]"}`}>{o.note}</span>
          </button>
        ))}
        <button
          type="button"
          disabled={!feed}
          onClick={copy}
          className={`${base} border-[#EBE3E5] bg-white text-[#34406f] hover:bg-[#FAF7F7]`}
        >
          <span className="text-sm font-black">{copied ? "Copied" : "Copy link"}</span>
          <span className="text-xs font-semibold text-[#59658d]">Any other calendar app</span>
        </button>
      </div>

      <ul className="mt-4 list-disc space-y-1.5 border-t border-[#EBE3E5] pt-3 pl-4 text-xs font-semibold text-[#59658d]">
        <li>You only do this once. It covers all your confirmed bookings, including ones you make later.</li>
        <li>
          <b>Android:</b> tap Google Calendar and confirm. It is added to your Google account, so it shows in the
          Calendar app on your phone.
        </li>
        <li>
          <b>iPhone, iPad, Mac:</b> tap Apple Calendar, then Subscribe.
        </li>
        <li>
          <b>Windows:</b> tap Outlook for Outlook.com. In the Outlook app, choose Add calendar, Subscribe from web,
          and paste the copied link.
        </li>
        <li>
          Your calendar app decides how often it checks for changes. Google can take 12 to 24 hours; Apple and Outlook
          are usually quicker.
        </li>
        <li>
          Anyone with your link can see your bookings. If it gets shared by mistake,{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Reset your calendar link? The old one will stop updating.")) void load(true);
            }}
            className="font-black text-palette-purpleInk underline underline-offset-2 disabled:opacity-50"
          >
            reset it
          </button>
          .
        </li>
      </ul>
    </div>
  );
}
