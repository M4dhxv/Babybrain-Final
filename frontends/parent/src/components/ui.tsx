import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatePicker } from "./DatePicker";
import { resolveAvatar } from "../lib/avatars";
import type { Activity } from "../data/content";
import { routes } from "../data/content";
import { useActivities } from "../lib/useActivities";
import { useFavorite } from "../lib/data";
import { useAuth } from "../auth/AuthProvider";
import { formatDuration, regionLabel } from "../lib/database.types";
import { goTo, useLocation } from "../lib/nav";
import { warmDashboard } from "../lib/prefetch";
import { FALLBACK_LOGO_URL } from "../lib/activityMedia";
import { requestInstall, useInstallState } from "../lib/install";
import { useUnreadMessages } from "../lib/chat";
import { useUnreadNotifications } from "../lib/notifications";

/** Requests a resized rendition from Wix's own CDN (documented `/v1/fill/`
 *  URL transform) instead of the full original upload — a card renders at a
 *  few hundred px wide, but an unresized Wix photo is routinely 1500px+, so
 *  every card view was downloading many times the bytes it displays. A
 *  non-Wix URL (a placeholder, Supabase Storage) is returned unchanged. */
export function wixThumbUrl(url: string, w: number, h: number): string {
  if (!/^https:\/\/static\.wixstatic\.com\/media\//.test(url)) return url;
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(url.split("?")[0].split("#")[0]);
  const ext = extMatch?.[1].toLowerCase() === "jpeg" ? "jpg" : extMatch?.[1].toLowerCase();
  const safeExt = ext && ["jpg", "png", "webp", "gif"].includes(ext) ? ext : "jpg";
  // `fit`, not `fill`: cards show the whole image, so Wix must not crop it server-side.
  return `${url}/v1/fit/w_${w},h_${h}/file.${safeExt}`;
}

/** "That's a Plus feature" prompt.
 *
 *  QA: tapping the heart on the free plan looked like it worked but the
 *  activity never appeared under Favourites. Free parents get this instead. */
export function PlusFeatureDialog({
  title = "Favourites are a Plus feature",
  copy = "Save the classes you love and come back to them any time — on your own list.",
  onClose,
}: {
  title?: string;
  copy?: string;
  onClose: () => void;
}) {
  // Through a portal: the heart lives inside the card's own <a>, and a link
  // nested in a link would hand the "Upgrade" click to the card instead.
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="w-full max-w-[380px] rounded-[16px] bg-white p-6 text-center shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta">
          <Icon name="heart" className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-lg font-black">{title}</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-[#59658d]">{copy}</p>
        <p className="mt-3 text-sm font-black text-palette-blue">Upgrade for just SGD 15 per month.</p>
        <div className="mt-5 flex flex-col gap-2">
          <Button href="/pricing" className="w-full justify-center">Upgrade to Plus</Button>
          <Button type="button" variant="outline" className="w-full justify-center" onClick={onClose}>
            Not now
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Yes/no confirmation, same portal treatment as {@link PlusFeatureDialog}.
 *  For choices we want a parent to pause over but never want to prevent —
 *  booking the same child onto a class they already hold a place on, say. */
export function ConfirmDialog({
  title,
  copy,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  onConfirm,
  onClose,
}: {
  title: string;
  copy: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="w-full max-w-[380px] rounded-[16px] bg-white p-6 text-center shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FEF2D7] text-yellow-600">
          <Icon name="bell" className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-lg font-black">{title}</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-[#59658d]">{copy}</p>
        <div className="mt-5 flex flex-col gap-2">
          <Button type="button" className="w-full justify-center" onClick={onConfirm}>{confirmLabel}</Button>
          <Button type="button" variant="outline" className="w-full justify-center" onClick={onClose}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Heart button that saves/unsaves an activity to the parent's favorites.
 *  Guards its own click so it works inside a card link. */
export function SaveHeart({
  activityId,
  className = "",
  onToggled,
}: {
  activityId?: string;
  className?: string;
  onToggled?: (saved: boolean) => void;
}) {
  const fav = useFavorite(activityId, onToggled);
  const [showUpgrade, setShowUpgrade] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={fav.saved ? "Saved to favourites" : "Save to favourites"}
        aria-pressed={fav.saved}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          fav.toggle().then((ok) => {
            if (!ok) setShowUpgrade(true);
          });
        }}
        className={`grid place-items-center rounded-full shadow-soft transition ${
          fav.saved ? "bg-baby-pink text-white" : "bg-white text-baby-pink"
        } ${className}`}
      >
        <Icon name="heart" className="h-4.5 w-4.5" />
      </button>
      {showUpgrade && <PlusFeatureDialog onClose={() => setShowUpgrade(false)} />}
    </>
  );
}

type IconName =
  | "heart"
  | "user"
  | "search"
  | "shield"
  | "calendar"
  | "music"
  | "hand"
  | "palette"
  | "movement"
  | "flask"
  | "people"
  | "star"
  | "spark"
  | "pin"
  | "open"
  | "bookmark"
  | "home"
  | "mail"
  | "phone"
  | "pen"
  | "whatsapp"
  | "instagram"
  | "gift"
  | "chart"
  | "store"
  | "check"
  | "crown"
  | "lock"
  | "bell"
  | "shoe"
  | "bottle"
  | "target"
  | "gear"
  | "clock"
  | "menu"
  | "close"
  | "chevron"
  | "chat"
  | "compass"
  | "funnel"
  | "catMusic"
  | "catArt"
  | "catSport"
  | "catSwim"
  | "catLearn"
  | "catBaby"
  | "catPlay"
  | "catEvent"
  | "catCamp";

const iconPaths: Record<IconName, string> = {
  heart:
    "M12 20.2S4.8 15.8 3.1 10.8C1.7 6.7 5.9 3.7 9.1 6.1L12 8.3l2.9-2.2c3.2-2.4 7.4.6 6 4.7-1.7 5-8.9 9.4-8.9 9.4Z",
  user:
    "M12 12.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm-7.2 8.1c.8-3.7 3.5-5.8 7.2-5.8s6.4 2.1 7.2 5.8",
  search:
    "M10.7 17.2a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1.5 4.2 4.2",
  shield:
    "M12 3.5 19 6v5.1c0 4.4-2.7 7.7-7 9.5-4.3-1.8-7-5.1-7-9.5V6l7-2.5Zm-3 8 2.1 2.1L15.5 9",
  calendar:
    "M6 4v3m12-3v3M4.5 8h15M6 5.5h12A2.5 2.5 0 0 1 20.5 8v10A2.5 2.5 0 0 1 18 20.5H6A2.5 2.5 0 0 1 3.5 18V8A2.5 2.5 0 0 1 6 5.5Zm2 6h2v2H8v-2Zm4 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-8 4h2v2H8v-2Zm4 0h2v2h-2v-2Z",
  music:
    "M9 18.5a2.7 2.7 0 1 1-1-2.1V5.5l9-1.8v10.9a2.7 2.7 0 1 1-1-2.1V8l-7 1.4v9.1Z",
  hand:
    "M8.5 11.8V5.2a1.5 1.5 0 0 1 3 0v6.1-7.1a1.5 1.5 0 0 1 3 0v7.1-5.9a1.5 1.5 0 0 1 3 0v7.1-3.2a1.5 1.5 0 0 1 3 0v4.5c0 4.1-2.7 6.7-6.8 6.7h-1.1c-2.2 0-3.8-.9-5.3-2.5l-2.6-2.8a1.6 1.6 0 0 1 2.3-2.2l1.5 1.4",
  palette:
    "M12 3.5a8.5 8.5 0 0 0 0 17h1.2a1.8 1.8 0 0 0 1.1-3.2 1.8 1.8 0 0 1 1.1-3.2H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.6 16.7 3.5 12 3.5ZM7.8 11.2h.1m2.1-3h.1m4 0h.1m2 3h.1",
  movement:
    "m14.5 5.5-3 4 3.8 2.2 3.2 5.8m-7-8-2.8 3.3L6 20m5.5-10.5L8.8 8.2M15.4 4a1.7 1.7 0 1 1 0 .1",
  flask:
    "M9 3.5h6M10 3.5v5.2l-4.4 8A2.6 2.6 0 0 0 7.9 20.5h8.2a2.6 2.6 0 0 0 2.3-3.8l-4.4-8V3.5M8.3 15.2h7.4",
  people:
    "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.8 19.5c.5-3.3 2.3-5.1 4.7-5.1s4.2 1.8 4.7 5.1m-1.8-3.2c.9-1.2 2.2-1.9 4.1-1.9 2.4 0 4.2 1.8 4.7 5.1",
  star:
    "m12 3.8 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 3.8Z",
  spark: "M12 3.5v5m0 7v5m8.5-8.5h-5m-7 0h-5m12.5-6.5-3.5 3.5m-5 5-3.5 3.5m0-12 3.5 3.5m5 5 3.5 3.5",
  pin:
    "M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  open: "M8 5h11v11M19 5 7 17m0-8v10h10",
  bookmark: "M7 4.5h10v16L12 17l-5 3.5v-16Z",
  home: "M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z",
  mail: "M4.5 6.5h15v11h-15v-11Zm1 1L12 13l6.5-5.5",
  phone: "M7 4.5h4l1.2 4-2.4 1.5a11 11 0 0 0 4.2 4.2l1.5-2.4 4 1.2v4c0 1.2-.9 2-2.1 2A12.9 12.9 0 0 1 5 6.6c0-1.2.8-2.1 2-2.1Z",
  pen: "M5 18.5h14M7 15.5l8.8-8.8 2.5 2.5-8.8 8.8H7v-2.5Z",
  whatsapp:
    "M5.6 18.4A8 8 0 1 1 12 21a8 8 0 0 1-3.8-1l-3.7 1 1.1-2.6Zm4-8.8c.2 3.1 2.6 5 5 5.4l1.3-1.5-2-1-1 1c-1.1-.5-1.9-1.2-2.4-2.3l1-1-1-2-1 .4Z",
  instagram:
    "M7.5 3.5h9a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4v-9a4 4 0 0 1 4-4Zm4.5 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm4.6-1.1h.01",
  gift:
    "M4.5 10h15v10h-15V10Zm0 0V7h15v3M12 7v13M8.5 7C6 6.4 6 3.8 8 3.8c1.5 0 2.7 1.4 4 3.2 1.3-1.8 2.5-3.2 4-3.2 2 0 2 2.6-.5 3.2",
  chart:
    "M5 19V9m7 10V5m7 14v-7M3.5 20.5h17",
  store:
    "M4 9h16l-1.2-4.5H5.2L4 9Zm1 0v10.5h14V9M8 19.5v-6h8v6",
  check: "m5 12.5 4.2 4.2L19.5 6.5",
  crown:
    "M4.5 18.5h15M6 16.5l-1-9 5 4 2-6 2 6 5-4-1 9H6Z",
  lock:
    "M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6V10Zm6 4v3",
  bell:
    "M6.5 17h11l-1.5-2V10a4 4 0 0 0-8 0v5l-1.5 2ZM10 19a2 2 0 0 0 4 0",
  shoe:
    "M5 15.5c2.2.8 4.5.8 7.2-.2l4.8-1.8 2.5 3.5c-4.7 1.9-9.8 2.4-15 1.2V15.5Zm3.5-5 3.7 4.8",
  bottle:
    "M10 5.5h4M11 5.5V9l-1.5 2v8.5h5V11L13 9V5.5M10 14h4",
  target:
    "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm0-3.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm2-2 5-5",
  // The cog ring is Lucide's `settings` glyph (proven to stroke cleanly);
  // the old hand-drawn outline was a filled-icon silhouette being stroked
  // instead of filled, which rendered as a tangle of overlapping curves.
  gear:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915Z",
  clock:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3.5 2",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  // A right-pointing chevron with a true 90° elbow (each leg is a 7×7
  // diagonal, so the two meet square rather than in a narrow point).
  chevron: "m9 5 7 7-7 7",
  chat: "M4.5 6.5h15v10h-8L7 20v-3.5H4.5v-10Z",
  compass: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm3.5 5-2 5.5-5.5 2 2-5.5 5.5-2Z",
  funnel: "M3.5 4.5h17L14 12.5v6.5l-4 2v-8.5L3.5 4.5Z",
  // Activity-type icons on the Explore filter tiles: Lucide outlines (ISC), each
  // flattened to one path with an absolute M per subpath.
  catMusic:
    "M9 18V5l12-2v13M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M15 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  catArt:
    "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8zM13.5 6.5h.01M17.5 10.5h.01M6.5 12.5h.01M8.5 7.5h.01",
  catSport:
    "M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829zM2.5 21.5l1.4-1.4M20.1 3.9l1.4-1.4M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829zM9.6 14.4l4.8-4.8",
  catSwim:
    "M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
  catLearn:
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  catBaby:
    "M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5M15 12h.01M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1M9 12h.01",
  catPlay:
    "M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 2v4M6.8 15l-3.5 2M20.7 7l-3.5 2M6.8 9L3.3 7M20.7 17l-3.5-2M9 22l3-8 3 8M8 22h8M18 18.7a9 9 0 1 0-12 0",
  catEvent:
    "M5.8 11.3L2 22l10.7-3.79M4 3h.01M22 8h.01M15 2h.01M22 20h.01M22 2l-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10M22 13l-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17M11 2l.33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z",
  catCamp:
    "M3.5 21L14 3M20.5 21L10 3M15.5 21L12 15l-3.5 6M2 21h20",
};

export function Icon({
  name,
  className = "h-5 w-5",
  strokeWidth = 1.9,
}: {
  name: IconName | string;
  className?: string;
  strokeWidth?: number;
}) {
  const path = iconPaths[name as IconName] ?? iconPaths.spark;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      <path d={path} />
    </svg>
  );
}

/** A person emoji on a pastel circle, standing in for a photo.
 *
 *  Replaces the cartoon-animal generator — QA asked for babies and toddlers of
 *  varying age and skin tone for children, and adults of varying gender and
 *  skin tone, "a bit like the emoji's on WhatsApp". See `lib/avatars.ts` for the
 *  catalogue and how a stored seed resolves to a picture.
 *
 *  The emoji is sized in `cqw` against the wrapper, so it fills whatever box the
 *  caller's Tailwind height/width classes give it without each call site having
 *  to pass a font size. */
export function AnimalAvatar({
  seed,
  kind = "parent",
  gender,
  className = "h-11 w-11",
}: {
  seed?: string | null;
  /** `kind` picks the catalogue: children get babies and toddlers, parents adults. */
  kind?: "child" | "parent";
  /** Without a picked avatar, a stated gender chooses a girl/boy face. */
  gender?: string | null;
  className?: string;
}) {
  const { emoji, background, label } = resolveAvatar(seed, kind, gender);
  return (
    <span
      role="img"
      aria-label={label}
      style={{ containerType: "inline-size", background }}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full leading-none ${className}`}
    >
      <span style={{ fontSize: "62cqw" }} className="leading-none">
        {emoji}
      </span>
    </span>
  );
}

/** The horizontal lockup — per the brand guide this is the one for site
 *  headers and other wide spaces. It already contains the wordmark, so no
 *  text sits beside it. */
export function Brand({ className = "h-11 sm:h-12" }: { className?: string }) {
  return (
    <a href="/" className="flex shrink-0 items-center" aria-label="BabyBrain home">
      <img
        src={`${import.meta.env.BASE_URL}assets/brand/logo-horizontal.png`}
        alt="BabyBrain"
        className={`w-auto ${className}`}
      />
    </a>
  );
}

/** The icon mark on its own — for tight spaces where the wordmark won't fit. */
export function BrandIcon({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/brand/logo-icon.png`}
      alt=""
      aria-hidden="true"
      className={`object-contain ${className}`}
    />
  );
}

/** The stacked lockup — brand guide calls for this at the top of landing
 *  moments and emails. */
export function BrandStacked({ className = "h-24" }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/brand/logo-stacked.png`}
      alt="BabyBrain"
      className={`mx-auto w-auto object-contain ${className}`}
    />
  );
}

type HeaderProps = {
  active?: string;
  auth?: "public" | "user";
};

/** Header search — jumps to Explore with the term applied. A plain form so
 *  Enter just works; `goTo` handles it as a client-side navigation. */
function SearchBox({ className = "", autoFocus = false }: { className?: string; autoFocus?: boolean }) {
  const loc = useLocation();
  const [term, setTerm] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  // Keep the box in step with the URL when navigation happens elsewhere
  // (client-side nav no longer remounts this component).
  useEffect(() => {
    setTerm(new URLSearchParams(window.location.search).get("q") ?? "");
  }, [loc]);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = term.trim();
        goTo(q ? `/explore?q=${encodeURIComponent(q)}` : "/explore");
      }}
      className={`relative ${className}`}
    >
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6D7488]" />
      <input
        type="search"
        value={term}
        autoFocus={autoFocus}
        onChange={(e) => setTerm(e.target.value)}
        aria-label="Search activities"
        placeholder="Search activities…"
        className="h-9 w-full rounded-full border border-[#EBE3E5] bg-white pl-9 pr-3 text-[13px] font-semibold text-baby-ink outline-none placeholder:text-[#6D7488] focus:border-baby-pink"
      />
    </form>
  );
}

export function Header({ active = "/" }: HeaderProps) {
  const { session, profile, signOut } = useAuth();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const install = useInstallState();
  const installMenu = { show: !install.installed && (install.native || install.ios) };
  // Same unread signal the dashboard's own mobile drawer shows a dot for —
  // surfaced here too since this Header (not that drawer) is what every other
  // page's hamburger renders.
  const unreadMessages = useUnreadMessages(Boolean(session));
  const unreadNotifications = useUnreadNotifications(session?.user.id);
  const hasUnread = unreadMessages > 0 || unreadNotifications > 0;
  // Close the mobile dropdown after a navigation — client-side nav keeps the
  // Header mounted, so tapping a link no longer clears it on its own.
  useEffect(() => {
    setMenuOpen(false);
  }, [loc]);
  const navItems = [
    routes[0],
    { href: active === "/matches" ? "/matches" : "/explore", label: "Explore Activities" },
    routes[2],
    routes[3],
  ];

  // Plain cream header. In the installed app the OS status bar is a solid
  // bright pink (theme-color #FA4D8D) and meets this as a hard block — no
  // gradient bleed. In a browser tab there's no pink chrome above it.
  return (
    <header className="sticky top-0 z-30 border-b border-[#F4EFF0] bg-baby-paper [transform:translateZ(0)]">
      <div className="mx-auto flex h-[74px] max-w-[1180px] items-center justify-between gap-4 px-4 sm:px-6">
        <Brand />
        <nav className="hidden items-center gap-5 text-[13px] font-bold text-baby-ink lg:flex lg:gap-7">
          {navItems.map((route) => (
            <a
              key={route.href}
              href={route.href}
              className={`relative whitespace-nowrap py-5 ${
                active === route.href ? "text-baby-pink" : ""
              }`}
            >
              {route.label}
              {active === route.href && (
                <span className="absolute inset-x-0 bottom-0 h-1 rounded-t-full bg-baby-pink" />
              )}
            </a>
          ))}
        </nav>

        {/* Only from lg up: between 768 and 1024 the nav, search and auth
            buttons together overflow and the brand collides with "Home".
            Below lg the search lives in the mobile menu instead. */}
        <SearchBox className="hidden max-w-[210px] flex-1 lg:block" />

        {/* Desktop auth actions */}
        {!session ? (
          <div className="hidden items-center gap-3 lg:flex">
            <Button href="/login" variant="outline" size="sm">
              <Icon name="user" className="h-4 w-4" /> Log in
            </Button>
            <Button href="/onboarding" size="sm">
              <Icon name="user" className="h-4 w-4" /> Sign up
            </Button>
          </div>
        ) : (
          <div
            className="hidden items-center gap-4 text-sm font-bold lg:flex"
            onMouseEnter={warmDashboard}
            onFocusCapture={warmDashboard}
          >
            <a href="/profile?tab=favorites" className="flex items-center gap-1.5 text-baby-ink hover:text-baby-pink">
              <Icon name="heart" className="h-5 w-5 text-baby-pink" /> Saved
            </a>
            <a
              href="/profile"
              className="flex items-center gap-2 rounded-full border border-[#EBE3E5] bg-white py-1 pl-1 pr-3 shadow-soft hover:border-[#DCD2D5]"
            >
              <AnimalAvatar seed={profile?.avatar_seed ?? profile?.full_name} kind="parent" className="h-7 w-7" />
              <span className="max-w-[110px] truncate">{profile?.full_name?.split(" ")[0] || "Account"}</span>
            </a>
            <button onClick={() => signOut()} className="text-[13px] text-[#68718f] hover:text-baby-ink">
              Sign out
            </button>
          </div>
        )}

        {/* Mobile hamburger. The unread dot only shows on the bars — once the
            menu opens (and turns into a close cross) it moves to sit next to
            the profile name below, which is what it's actually pointing at. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="relative -mr-1 grid h-11 w-11 place-items-center text-baby-ink transition-colors hover:text-baby-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta lg:hidden"
        >
          {/* No box: just the bars, which turn into a cross of the same weight when open. */}
          <Icon name={menuOpen ? "close" : "menu"} className="h-6 w-6" strokeWidth={2} />
          {!menuOpen && hasUnread && (
            <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-baby-paper bg-[#C90044]" />
          )}
        </button>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <nav className="border-t border-[#F4EFF0] bg-baby-paper px-4 py-3 lg:hidden">
          <SearchBox className="mb-3" />
          <div className="flex flex-col gap-1 text-[15px] font-bold text-baby-ink">
            {navItems.map((route) => (
              <a
                key={route.href}
                href={route.href}
                className={`rounded-[10px] px-3 py-2.5 ${active === route.href ? "bg-[#FED7E4] text-baby-cta" : "hover:bg-white"}`}
              >
                {route.label}
              </a>
            ))}
          </div>
          {installMenu.show && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); void requestInstall(); }}
              className="mt-2 flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-[15px] font-bold text-baby-cta hover:bg-white"
            >
              <Icon name="spark" className="h-5 w-5" /> Install app
            </button>
          )}
          <div className="mt-3 border-t border-[#EBE3E5] pt-3">
            {!session ? (
              <div className="flex flex-col gap-2">
                <Button href="/login" variant="outline" className="w-full justify-center">
                  <Icon name="user" className="h-4 w-4" /> Log in
                </Button>
                <Button href="/onboarding" className="w-full justify-center">
                  <Icon name="user" className="h-4 w-4" /> Sign up
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1 text-[15px] font-bold" onFocusCapture={warmDashboard}>
                <a href="/profile" className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 hover:bg-white">
                  <Icon name="user" className="h-5 w-5 text-baby-pink" /> {profile?.full_name?.split(" ")[0] || "My account"}
                  {hasUnread && <span className="h-2 w-2 rounded-full bg-[#C90044]" />}
                </a>
                <a href="/profile?tab=favorites" className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 hover:bg-white">
                  <Icon name="heart" className="h-5 w-5 text-baby-pink" /> Saved
                </a>
                <button onClick={() => signOut()} className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-[#68718f] hover:bg-white">
                  Sign out
                </button>
              </div>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}

type ButtonProps = {
  children: React.ReactNode;
  href?: string;
  variant?: "primary" | "outline" | "soft" | "pink" | "ghost" | "blue" | "blueOutline";
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
};

export function Button({
  children,
  href,
  variant = "primary",
  size = "md",
  type = "button",
  className = "",
  onClick,
  disabled = false,
}: ButtonProps) {
  const sizeClass =
    size === "sm"
      ? "px-4 py-2.5 text-[13px]"
      : size === "lg"
        ? "px-7 py-3.5 text-base"
        : "px-6 py-3 text-[15px]";
  // Each variant sets its own border COLOUR and nothing else sets one. The
  // base used to carry `border-transparent` to equalise heights, but Tailwind
  // emits utilities in its own canonical order rather than the order they're
  // written, so that transparent won over the outline variants' colour and the
  // outlined buttons lost their outline. The width lives in `classes` below;
  // only the colour varies here.
  const variantClass = {
    primary:
      "border-transparent bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] text-white shadow-pink hover:brightness-105",
    // The pink CTAs (`primary`, `pink`) keep the brighter marketing gradient;
    // every other variant, blue included, sits on palette tokens.
    outline:
      "border-palette-pink bg-white text-palette-pink hover:bg-palette-pinkTint",
    soft: "border-transparent bg-palette-pinkTint text-baby-cta hover:bg-palette-pinkSoft",
    pink: "border-transparent bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] text-white shadow-pink",
    ghost: "border-transparent bg-transparent text-baby-pink hover:bg-palette-pinkTint",
    // Blue carries the in-app actions (book, buy, submit, invite); pink stays
    // for marketing CTAs and the final confirm step. Pastel fill, white text
    // — no electric `baby-blue`.
    blue: "border-transparent bg-palette-blue text-white shadow-sm hover:brightness-95",
    blueOutline: "border-palette-blue bg-white text-palette-blue hover:bg-palette-blueTint",
  }[variant];
  // `border` here is the WIDTH only, so every variant is the same height.
  const classes = `inline-flex items-center justify-center gap-2 rounded-[11px] border font-extrabold leading-none transition ${sizeClass} ${variantClass} ${className}${disabled ? " cursor-not-allowed opacity-60" : ""}`;

  if (href && !disabled) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }

  return (
    <button type={type} className={classes} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Date field — a typeable day-first text input plus our own calendar
 *  popover ({@link DatePicker}), replacing the browser's native
 *  `<input type="date">`. Value stays ISO (yyyy-mm-dd) for the database. */
export function DateInput(props: {
  /** ISO yyyy-mm-dd, or "" when empty. */
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  id?: string;
  placeholder?: string;
}) {
  return <DatePicker {...props} />;
}

/** Scattered brand confetti — hearts, stars, dots and dashes in the palette
 *  from the brand guide. Purely decorative, so it's hidden from screen
 *  readers and never intercepts clicks. Positions are percentages of the
 *  nearest positioned ancestor. */
type ConfettiPiece = {
  kind: "heart" | "star" | "dot" | "dash";
  top: string;
  left?: string;
  right?: string;
  color: string;
  size?: number;
  rotate?: number;
};

export function Confetti({ pieces, className = "" }: { pieces: ConfettiPiece[]; className?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {pieces.map((p, i) => {
        const s = p.size ?? 22;
        const style: React.CSSProperties = {
          position: "absolute",
          top: p.top,
          left: p.left,
          right: p.right,
          transform: p.rotate ? `rotate(${p.rotate}deg)` : undefined,
        };
        if (p.kind === "dot") {
          return <span key={i} style={{ ...style, width: s / 2, height: s / 2, background: p.color, borderRadius: "50%" }} />;
        }
        if (p.kind === "dash") {
          return <span key={i} style={{ ...style, width: s, height: s / 4.5, background: p.color, borderRadius: 999 }} />;
        }
        if (p.kind === "star") {
          return (
            <svg key={i} style={style} width={s} height={s} viewBox="0 0 24 24" fill={p.color}>
              <path d="m12 2.6 2.7 5.9 6.4.7-4.8 4.3 1.3 6.3L12 16.7 6.4 19.8l1.3-6.3L2.9 9.2l6.4-.7L12 2.6Z" />
            </svg>
          );
        }
        return (
          <svg key={i} style={style} width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={p.color} strokeWidth={2.2} strokeLinejoin="round">
            <path d="M12 20.2S4.8 15.8 3.1 10.8C1.7 6.7 5.9 3.7 9.1 6.1L12 8.3l2.9-2.2c3.2-2.4 7.4.6 6 4.7-1.7 5-8.9 9.4-8.9 9.4Z" />
          </svg>
        );
      })}
    </div>
  );
}

export function PageShell({
  children,
  active = "/",
  auth = "user",
}: {
  children: React.ReactNode;
  active?: string;
  auth?: "public" | "user";
}) {
  return (
    <div className="min-h-screen bg-baby-paper text-baby-ink">
      <Header active={active} auth={auth} />
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
  emoji,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  /** Literal emoji shown after the heading — a real emoji, not a drawn icon,
   *  so what ships is exactly the character specified (skin-tone modifiers
   *  included). Opt-in per section: this used to hardcode the spark on every
   *  heading, which kept reinstating it where it had been taken out. Omit it
   *  and the heading carries no glyph. */
  emoji?: string;
}) {
  // On narrow screens the heading and its action were colliding, so the action
  // drops onto its own line rather than being squeezed alongside the title.
  return (
    <div className="mb-3 flex flex-col items-start gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <h2 className="text-[22px] font-black leading-tight tracking-normal text-baby-ink">
        {children}
        {emoji && <span aria-hidden="true"> {emoji}</span>}
      </h2>
      {action}
    </div>
  );
}

/** The provider line is only worth showing when it adds information — i.e.
 *  when it differs from the activity title (many single-class providers name
 *  the activity after themselves, e.g. "Vroomtown" / "Vroomtown"). */
function providerLabel(activity: Activity): string | null {
  const name = activity.providerName?.trim();
  if (!name) return null;
  return name.toLowerCase() === activity.title.trim().toLowerCase() ? null : name;
}

/** Cards lead with the area ("East") rather than a street address + postcode —
 *  the exact address is on the listing page. Falls back to the address tail
 *  for the handful of listings with no region. */
/** Region name where we have one. The address fallback is the tail of the
 *  address, which is usually "Singapore 098327" — a postal code is no use to a
 *  parent scanning cards, so it's stripped rather than shown. */
function placeLabel(activity: Activity): string {
  const region = regionLabel(activity.region);
  if (region) return region;
  const venue = (activity.venue ?? "").replace(/\b\d{6}\b/g, "").replace(/[,\s]+$/, "").trim();
  return venue || "Singapore";
}

/** "From $32" — a price the parent can see without opening the listing. */
function priceLabel(activity: Activity): string | null {
  const p = activity.price;
  if (p == null) return null;
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return "Free";
  return `From $${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

// Explore can mount 50+ of these at once, growing with every "Show more" —
// memoized so a parent re-render (e.g. the sort dropdown, an unrelated
// favourite toggling elsewhere) doesn't re-render every card whose own props
// haven't changed.
export const ActivityCard = memo(function ActivityCard({
  activity,
  compact = false,
  onFavoriteToggled,
}: {
  activity: Activity;
  compact?: boolean;
  onFavoriteToggled?: (activityId: string, saved: boolean) => void;
}) {
  const href = activity.slug ? `/activity?slug=${activity.slug}` : "/activity";
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white shadow-card">
      <div className="relative h-[108px]">
        <img
          src={wixThumbUrl(activity.image, 640, 174)}
          alt=""
          width={400}
          height={108}
          loading="lazy"
          decoding="async"
          className={
            activity.image === FALLBACK_LOGO_URL
              ? "h-full w-full bg-[#F3EDF0] object-contain p-4"
              : "h-full w-full bg-[#F3EDF0] object-contain"
          }
        />
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5">
          {activity.boosted && (
            <span className="flex items-center gap-1 rounded-full bg-[#FEF2D7] px-2.5 py-1 text-[11px] font-bold text-[#FFD77A] shadow-soft">
              <Icon name="star" className="h-3 w-3 fill-current" /> Featured
            </span>
          )}
        </div>
        <SaveHeart
          activityId={activity.id}
          className="absolute right-3 top-3 z-10 h-8 w-8"
          onToggled={onFavoriteToggled && activity.id ? (saved) => onFavoriteToggled(activity.id as string, saved) : undefined}
        />
      </div>
      <div className="flex flex-1 flex-col p-3.5">
        <h3 className="mb-0.5 text-[15px] font-black leading-tight text-baby-ink">
          {activity.title}
        </h3>
        {providerLabel(activity) && (
          <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-bold text-palette-blue">
            <Icon name="store" className="h-3.5 w-3.5" /> {providerLabel(activity)}
          </p>
        )}
        {/* Metadata glyphs all carry the brand blue; only price and the save
            heart stay pink. The old "Popular this week" line is gone — it was
            noise — and duration takes that slot beside the rating. */}
        <div className="space-y-1 text-[11.5px] font-semibold text-[#4a5685]">
          <p className="flex items-center gap-1.5"><Icon name="user" className="h-3.5 w-3.5 text-palette-blue" /> {activity.age}</p>
          <p className="flex items-center gap-1.5"><Icon name="pin" className="h-3.5 w-3.5 text-palette-blue" /> {placeLabel(activity)}</p>
          <p className="flex items-center gap-1.5">
            <Icon name="calendar" className="h-3.5 w-3.5 text-palette-blue" />{" "}
            {activity.date ? (activity.time ? <>{activity.date} · {activity.time}</> : activity.date) : "Schedule TBC"}
          </p>
          {priceLabel(activity) && (
            <p className="font-black text-palette-blue">{priceLabel(activity)}</p>
          )}
          {!compact && (activity.rating || formatDuration(activity.durationMins)) && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {activity.rating && (
                <span className="flex items-center gap-1.5">
                  <Icon name="star" className="h-3.5 w-3.5 text-palette-blue" /> {activity.rating}
                </span>
              )}
              {formatDuration(activity.durationMins) && (
                <span className="flex items-center gap-1.5">
                  <Icon name="clock" className="h-3.5 w-3.5 text-palette-blue" /> {formatDuration(activity.durationMins)}
                </span>
              )}
            </p>
          )}
        </div>
        {/* Category tag(s) as one more attribute alongside age/venue/date,
            rather than floating over the image — the pill(s) used to sit
            top-left on the thumbnail, which crowded a 108px-tall image on
            narrow cards and could overlap a portrait photo or logo.
            mb-3 (not just mt-auto on the footer below) because mt-auto only
            eats *leftover* flex space — when a card's own content already
            fills the column with none to spare (e.g. it's the tallest card
            in its grid row), mt-auto resolves to 0 and the footer's
            border-top lands flush against these chips with no gap, cutting
            through them (QA). This margin is unconditional, so there's
            always a minimum gap regardless of how much leftover space
            mt-auto has to work with. */}
        <div className="mb-3 mt-1.5 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-palette-blueTint px-2.5 py-1 text-[10.5px] font-bold text-palette-blueInk">{activity.category}</span>
          {activity.category2 && <span className="rounded-full bg-palette-blueTint px-2.5 py-1 text-[10.5px] font-bold text-palette-blueInk">{activity.category2}</span>}
        </div>
        {compact ? (
          <div className="mt-auto flex gap-2 pt-3">
            <Button href={href} size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              View details
            </Button>
            <Button variant="outline" size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              Manage booking
            </Button>
          </div>
        ) : (
          <div className="mt-auto flex items-center justify-between border-t border-[#F4EFF0] pt-3">
            {/* The ::after stretches this link over the whole card, so tapping anywhere opens the
                activity; the save heart sits above it (z-10) and keeps its own tap. */}
            <a href={href} className="text-sm font-extrabold text-palette-blue after:absolute after:inset-0 after:content-['']">
              View details
            </a>
            <a href={href} aria-label="Open activity" className="text-palette-blue">
              <Icon name="open" className="h-5 w-5" />
            </a>
          </div>
        )}
      </div>
    </article>
  );
});

export const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const href = activity.slug ? `/activity?slug=${activity.slug}` : "/activity";
  return (
    <a href={href} className="grid grid-cols-1 overflow-hidden rounded-[12px] border border-[#EBE3E5] bg-white shadow-card sm:grid-cols-[170px_1fr] xl:grid-cols-[220px_1fr]">
      <div className="relative">
        <img
          src={wixThumbUrl(activity.image, 440, 352)}
          alt=""
          width={220}
          height={176}
          loading="lazy"
          decoding="async"
          className={
            activity.image === FALLBACK_LOGO_URL
              ? "h-44 w-full bg-[#F3EDF0] object-contain p-6 sm:h-full sm:min-h-[100px]"
              : "h-44 w-full bg-[#F3EDF0] object-contain sm:h-full sm:min-h-[100px]"
          }
        />
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5">
          {activity.boosted && (
            <span className="flex items-center gap-1 rounded-full bg-[#FEF2D7] px-2.5 py-1 text-[11px] font-bold text-[#FFD77A] shadow-soft">
              <Icon name="star" className="h-3 w-3 fill-current" /> Featured
            </span>
          )}
        </div>
      </div>
      <div className="relative p-4">
        <SaveHeart activityId={activity.id} className="absolute right-4 top-4 h-9 w-9" />
        <h3 className="mb-0.5 text-[16px] font-black">{activity.title}</h3>
        {providerLabel(activity) && (
          <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-bold text-palette-blue">
            <Icon name="store" className="h-3.5 w-3.5" /> {providerLabel(activity)}
          </p>
        )}
        {/* Fixed three rows (age·area / date·time / duration·price) so every
            card is the same height and the two columns line up — the left
            column sizes to its content and never wraps, the right one
            ellipsises. Missing values leave their cell blank rather than
            shifting the next value into the wrong column. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 pr-10 text-[11.5px] font-semibold text-[#52608b]">
          <span className="flex items-center gap-1 whitespace-nowrap"><Icon name="user" className="h-3.5 w-3.5 shrink-0 text-palette-blue" /> {activity.age}</span>
          <span className="flex items-center gap-1 min-w-0"><Icon name="pin" className="h-3.5 w-3.5 shrink-0 text-palette-blue" /> <span className="truncate">{placeLabel(activity)}</span></span>
          <span className="flex items-center gap-1 whitespace-nowrap"><Icon name="calendar" className="h-3.5 w-3.5 shrink-0 text-palette-blue" /> {activity.date || "Schedule TBC"}</span>
          <span className="truncate">{activity.date ? activity.time : ""}</span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            {formatDuration(activity.durationMins)
              ? <><Icon name="clock" className="h-3.5 w-3.5 shrink-0 text-palette-blue" /> {formatDuration(activity.durationMins)}</>
              : " "}
          </span>
          <span className="truncate font-black text-palette-blue">{priceLabel(activity) ?? ""}</span>
        </div>
        {/* Category tag(s) as one more attribute alongside age/venue/date,
            rather than floating over the image (see ActivityCard above for
            why: crowds a narrow thumbnail, can overlap a portrait photo or
            logo, and reads better as a legible pill in the text column on a
            small screen than a tiny overlay). */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-palette-blueTint px-2.5 py-1 text-[10.5px] font-bold text-palette-blueInk">{activity.category}</span>
          {activity.category2 && <span className="rounded-full bg-palette-blueTint px-2.5 py-1 text-[10.5px] font-bold text-palette-blueInk">{activity.category2}</span>}
        </div>
        {activity.rating && (
          <p className="mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold text-[#52608b]">
            <Icon name="star" className="h-3.5 w-3.5 shrink-0 text-palette-blue" /> {activity.rating}
          </p>
        )}
      </div>
    </a>
  );
});

export function CategoryTile({
  icon,
  label,
  copy,
  href,
  onClick,
}: {
  icon: string;
  label: string;
  copy?: string;
  href?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick ?? (href ? () => goTo(href) : undefined)}
      className="flex min-h-[72px] items-center gap-3 rounded-[12px] border border-[#EBE3E5] bg-white px-3.5 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-soft">
      <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-gradient-to-br from-[#F1FBEF] to-[#F1FBEF] text-baby-green">
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <span>
        <span className="block text-[13px] font-black leading-tight">{label}</span>
        {copy && (
          <span className="mt-0.5 block text-[11px] font-semibold leading-4 text-[#59658d]">
            {copy}
          </span>
        )}
      </span>
      <span className="ml-auto text-lg text-baby-ink">›</span>
    </button>
  );
}

/** BabyBrain's own support contacts. Declared here rather than in App so the
 *  footer can use them without importing from App (which imports this file). */
export const SUPPORT_EMAIL = "hello@babybrain.sg";
export const SUPPORT_PHONE = "+65 8996 6716"; // support line (call + WhatsApp)
export const phoneDigits = (p: string) => p.replace(/[^\d]/g, "");

export function Footer({ clearDock = false }: { clearDock?: boolean } = {}) {
  const { session } = useAuth();
  /** Which mobile accordion section is open (desktop always shows all). */
  const [openSection, setOpenSection] = useState<string | null>(null);
  /* "How It Works" points at the signed-out home page, which a signed-in
     parent never sees — their home is the dashboard — so the link would drop
     them somewhere unrecognisable. Hidden once they're logged in. */
  const exploreLinks: [string, string | null, string?][] = [
    ...(session ? [] : ([["How It Works", "/#how-it-works"]] as [string, string | null][])),
    ["Activities", "/explore"],
    ["About Us", "/about"],
    // QA 21/08: this column is the parent's own journey — the partner links
    // live in their own column below — so the slot becomes their sign-up.
    ["Sign Up", "/onboarding"],
  ];
  return (
    <footer
      className={`border-t border-[#F4EFF0] bg-white/70 pt-6 ${clearDock ? "sm:pb-6" : "pb-6"}`}
      // The Explore page floats its Type/Age/Area/More bar over the bottom of
      // the viewport on phones; keep the last line scrollable clear of it.
      style={clearDock ? { paddingBottom: "calc(6.5rem + env(safe-area-inset-bottom))" } : undefined}
    >
      <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-x-8 px-6 md:grid-cols-[1.8fr_1fr_1fr_1fr] md:gap-y-8">
        <div className="mb-2 md:mb-0">
          <Brand />
          <p className="mt-3 max-w-[230px] text-sm font-semibold leading-5 text-[#59658d]">
            Helping parents discover and book activities for their children.
          </p>
          {/* QA 21/08: the same quick-contact row the vendor footer has. */}
          <div className="mt-4 flex items-center gap-2.5">
            {([
              ["whatsapp", "WhatsApp us", `https://wa.me/${phoneDigits(SUPPORT_PHONE)}`, "bg-[#EAF7EE] text-[#3F9A5B]"],
              ["mail", "Email us", `mailto:${SUPPORT_EMAIL}`, "bg-[#FEEBF2] text-baby-cta"],
              ["phone", "Call us", `tel:+${phoneDigits(SUPPORT_PHONE)}`, "bg-[#F1EDFB] text-[#6B5AA8]"],
              ["instagram", "Instagram", "https://instagram.com/babybrainsg", "bg-[#F4EFF0] text-[#59658d]"],
            ] as [string, string, string, string][]).map(([icon, label, href, tone]) => (
              <a
                key={label}
                href={href}
                aria-label={label}
                {...(/^https?:\/\//.test(href) ? { target: "_blank", rel: "noreferrer" } : {})}
                className={`grid h-9 w-9 place-items-center rounded-full transition hover:opacity-80 ${tone}`}
              >
                <Icon name={icon} className="h-4 w-4" />
              </a>
            ))}
          </div>
        </div>
        {([
          ["Explore", exploreLinks],
          ["Support", [["Contact Us", "/contact"], ["FAQs", "/contact#faq"], ["Privacy Policy", "/terms#privacy"], ["Terms of Service", "/terms#tos"]]],
          /* QA 21/08: "change the 'Follow Us' to 'For Partners' listing out 'Why
             BabyBrain', 'Plans & Pricing', 'Claim Your Business' and 'Log in'".
             Instagram moves to the contact buttons above, so nothing is lost.
             Vendor routes are hash-based (HashRouter), hence /vendor/#/…. */
          ["For Partners", [
            ["Why BabyBrain", "/vendor/"],
            ["Plans & Pricing", "/vendor/#/plans"],
            ["Claim Your Business", "/vendor/#/claim-business"],
            ["Log in", "/vendor/#/login"],
          ]],
        ] as [string, [string, string | null, string?][]][]).map(([title, links]) => (
          <div key={title} className="border-t border-[#F4EFF0] text-sm md:border-0">
            <h3 className="font-black md:mb-3">
              <button
                type="button"
                aria-expanded={openSection === title}
                onClick={() => setOpenSection((s) => (s === title ? null : title))}
                className="flex w-full items-center justify-between py-3.5 text-left md:pointer-events-none md:cursor-default md:py-0"
              >
                {title}
                <Icon name="chevron" className={`h-4 w-4 text-[#59658d] transition-transform md:hidden ${openSection === title ? "rotate-90" : ""}`} />
              </button>
            </h3>
            <div className={`space-y-2 pb-3 font-semibold text-[#59658d] md:block md:space-y-1.5 md:pb-0 ${openSection === title ? "block" : "hidden"}`}>
              {links.map(([label, href, icon]) => {
                const external = !!href && /^https?:\/\//.test(href);
                return href ? (
                  <p key={label}>
                    <a
                      href={href}
                      className="inline-flex items-center gap-1.5 hover:text-baby-pink"
                      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                    >
                      {icon && <Icon name={icon} className="h-4 w-4" />}
                      {label}
                    </a>
                  </p>
                ) : (
                  <p key={label}>{label}</p>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-xs font-semibold text-[#69739A]">
        © 2026 BabyBrain.sg. All rights reserved.
      </p>
    </footer>
  );
}

export function MiniActivityGrid({ compact = false }: { compact?: boolean }) {
  const { activities } = useActivities({ sort: "popular", limit: 4 });
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {activities.slice(0, 4).map((activity) => (
        <ActivityCard key={activity.id} activity={activity} compact={compact} />
      ))}
    </div>
  );
}
