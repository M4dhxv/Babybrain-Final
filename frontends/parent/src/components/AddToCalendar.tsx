import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "./ui";
import {
  calendarFileUrl,
  downloadBookingIcs,
  googleCalendarUrl,
  isAppleDevice,
  outlookCalendarUrl,
  type IcsEvent,
} from "../lib/ics";

/**
 * "Add to calendar" for one booking (the confirmation page), with a choice of
 * where. A single .ics download is unreliable on iPhone (and inside in-app
 * browsers), so the parent picks:
 *   - Apple Calendar — a real link that returns a calendar file; iOS opens
 *     "Add to Calendar" directly. Listed first on Apple devices.
 *   - Google Calendar / Outlook — web links, work on any phone or computer.
 *   - Download file — the old .ics, kept for desktop calendar apps.
 * The bulk "export my schedule" lives in the Bookings page's export dialog.
 */
export default function AddToCalendar({ event }: { event: IcsEvent }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const options: { key: string; label: string; note: string; run: () => void }[] = [
    {
      key: "apple",
      label: "Apple Calendar",
      note: "iPhone, iPad, Mac",
      // Same tab: iOS shows its own "Add to Calendar" sheet for the response.
      run: () => window.location.assign(calendarFileUrl(event)),
    },
    {
      key: "google",
      label: "Google Calendar",
      note: "Opens in Google Calendar",
      run: () => window.open(googleCalendarUrl(event), "_blank", "noopener"),
    },
    {
      key: "outlook",
      label: "Outlook",
      note: "Opens in Outlook.com",
      run: () => window.open(outlookCalendarUrl(event), "_blank", "noopener"),
    },
    {
      key: "file",
      label: "Download file (.ics)",
      note: "For other calendar apps",
      run: () => downloadBookingIcs(event),
    },
  ];
  const ordered = isAppleDevice() ? options : [options[1], options[2], options[0], options[3]];

  return (
    <div ref={wrap} className="relative mt-3 w-full">
      <Button
        variant="outline"
        type="button"
        className="w-full"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="calendar" className="h-4 w-4" /> Add to calendar
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 z-30 mt-2 rounded-[12px] border border-[#EBE3E5] bg-white p-1.5 shadow-card"
        >
          {ordered.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                o.run();
              }}
              className="flex w-full flex-col rounded-[9px] px-3 py-2 text-left hover:bg-[#FFF5F8]"
            >
              <span className="text-sm font-black text-[#34406f]">{o.label}</span>
              <span className="text-xs font-semibold text-[#59658d]">{o.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
