import { useState } from "react";
import { Button } from "./ui";
import { apiGet, apiPost } from "../lib/api";
import { appleSubscribeUrl, googleSubscribeUrl, isAndroidDevice, isAppleDevice, isNonSafariIos } from "../lib/ics";

type Feed = { url: string; webcalUrl: string };

/**
 * Subscribe a calendar to the parent's private schedule feed
 * (/api/public/calendar-feed/<token>.ics), so rescheduled or cancelled bookings
 * update there on their own instead of needing another export. Used by the
 * "Export your schedule" dialog and the booking confirmation page.
 *
 * Collapsed to one button until opened; the link is only fetched (and created,
 * the first time) on open. The feed covers all of the parent's confirmed
 * bookings, and the link can be reset if it is shared by mistake.
 *
 * Per platform:
 *   - Apple (iPhone / Mac) and desktop calendars open a webcal:// link straight
 *     into "Subscribe".
 *   - Android has no such handler, and browsers cannot write to the phone's
 *     calendar, so Android gets "Add to Google Calendar" instead: the feed is
 *     added to the Google account and shows in the phone's Calendar app.
 */
export default function SubscribeCalendar({ intro }: { intro?: string }) {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const android = isAndroidDevice();
  const apple = isAppleDevice();
  // Chrome, Firefox and in-app browsers on iPhone cannot hand a webcal:// link to the Calendar app.
  const iosOtherBrowser = isNonSafariIos();

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
      setErr("Couldn't get your calendar link - please try again.");
    }
    setBusy(false);
  }

  function openPanel() {
    setOpen(true);
    if (!feed) void load();
  }

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

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        className="w-full rounded-[10px] border border-[#FED7E4] px-3 py-2.5 text-sm font-black text-baby-cta hover:bg-[#FEF1F6]"
      >
        Sync to calendar
      </button>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-black">Sync to calendar</h3>
      <p className="mt-1 text-xs font-semibold text-[#59658d]">
        {intro ??
          "Your calendar re-reads this link by itself, so rescheduled or cancelled bookings update there."}{" "}
        It includes all your confirmed bookings, including future ones.
      </p>
      {err && <p className="mt-2 text-xs font-bold text-[#C90044]">{err}</p>}
      {busy && !feed && <p className="mt-2 text-xs font-bold text-[#59658d]">Getting your link...</p>}
      {feed && (
        <>
          <input
            readOnly
            value={feed.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Your private calendar link"
            className="mt-3 h-10 w-full rounded-[10px] border border-[#FED7E4] bg-[#FAF7F7] px-3 text-xs font-semibold text-[#59658d]"
          />
          <div className="mt-2 flex gap-2">
            <Button type="button" onClick={copy} className="flex-1 justify-center">
              {copied ? "Copied" : "Copy link"}
            </Button>
            {!android && (
              // A real link, not a script redirect: iOS hands a tapped webcal:// link to Calendar ("Subscribe"),
              // but is unreliable about one set from window.location.
              <a
                href={appleSubscribeUrl(feed.url)}
                className="flex h-10 flex-1 items-center justify-center rounded-[10px] border border-[#FED7E4] px-3 text-sm font-black text-baby-cta hover:bg-[#FEF1F6]"
              >
                Open in calendar app
              </a>
            )}
          </div>
          <Button
            type="button"
            variant={android ? "primary" : "outline"}
            onClick={() => window.open(googleSubscribeUrl(feed.webcalUrl), "_blank", "noopener")}
            className="mt-2 w-full justify-center"
          >
            Add to Google Calendar
          </Button>
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs font-semibold text-[#59658d]">
            <li>
              <b>Android:</b> tap Add to Google Calendar and confirm. It is added to your Google account, so it also
              shows in the Calendar app on your phone (Google refreshes it every 12-24 hours). No Google account? A
              free app like ICSx5 can subscribe to the copied link.
            </li>
            <li>
              <b>Google (computer):</b> Add to Google Calendar works here too, or use Other calendars (+), From URL
              and paste the link.
            </li>
            <li>
              <b>Apple (iPhone / Mac):</b> tap Open in calendar app, then Subscribe.
              {apple && (
                <>
                  {" "}
                  {iosOtherBrowser && <b>This browser can&rsquo;t open the Calendar app, so use Safari, or: </b>}
                  If nothing happens, tap Copy link, then on your iPhone open Settings &gt; Calendar &gt; Accounts &gt; Add
                  Account &gt; Other &gt; Add Subscribed Calendar, paste the link and tap Next, then Save.
                </>
              )}
            </li>
            <li>
              <b>Outlook:</b> Add calendar, Subscribe from web, and paste the link.
            </li>
          </ul>
          <p className="mt-3 text-xs font-semibold text-[#59658d]">
            Anyone with this link can see your bookings. If it gets shared by mistake,{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Reset your calendar link? The old one will stop updating.")) void load(true);
              }}
              className="font-black text-baby-cta underline-offset-2 hover:underline disabled:opacity-50"
            >
              reset it
            </button>
            .
          </p>
        </>
      )}
    </div>
  );
}
