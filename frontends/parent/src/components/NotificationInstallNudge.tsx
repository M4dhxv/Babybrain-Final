import { useEffect, useState } from "react";
import { IosInstallSteps } from "./IosInstallSteps";
import { Icon } from "./ui";
import { isIos, isStandalone } from "../lib/install";
import { loadPushConfig, usePushServerEnabled } from "../lib/push";

/**
 * Shown on the booking-confirmed page to a parent on an iPhone / iPad who hasn't
 * installed the app. On iOS, notifications exist only for a Home Screen app, so
 * this is the moment they matter most to the parent ("remind me before the
 * session") and the only way they will ever get one.
 *
 * Appears only once the server confirms push is switched on, so it never
 * promises a reminder the site can't send.
 */
export function NotificationInstallNudge() {
  const serverEnabled = usePushServerEnabled();
  const [hidden, setHidden] = useState(false);
  useEffect(() => { void loadPushConfig(); }, []);

  if (hidden || !serverEnabled || !isIos() || isStandalone()) return null;

  return (
    <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-baby-cta">
          <Icon name="bell" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-xl font-black">Get a reminder before your session</h2>
          <p className="mt-1 text-sm font-semibold leading-6 text-[#59658d]">
            On iPhone, notifications work once BabyBrain is on your Home Screen. Add it and you will hear about changes,
            cancellations and reminders right away.
          </p>
        </div>
      </div>
      <IosInstallSteps />
      <button
        type="button"
        onClick={() => setHidden(true)}
        className="mt-4 text-sm font-bold text-[#68718f] hover:text-baby-ink"
      >
        Not now
      </button>
    </article>
  );
}
