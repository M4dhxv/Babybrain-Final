import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveAvatar } from "../lib/avatars";
import type { Activity } from "../data/content";
import { routes } from "../data/content";
import { useActivities } from "../lib/useActivities";
import { useFavorite } from "../lib/data";
import { useAuth } from "../auth/AuthProvider";
import { formatDuration, regionLabel } from "../lib/database.types";
import { goTo } from "../lib/nav";

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
        <p className="mt-3 text-sm font-black text-palette-blue">Upgrade for just SGD 9 per month.</p>
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
  | "chat";

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
  chat: "M4.5 6.5h15v10h-8L7 20v-3.5H4.5v-10Z",
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

/** Header search — jumps to Explore with the term applied. Kept as a plain
 *  form so Enter works and no client router is needed. */
function SearchBox({ className = "", autoFocus = false }: { className?: string; autoFocus?: boolean }) {
  const [term, setTerm] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
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
  const [menuOpen, setMenuOpen] = useState(false);
  const navItems = [
    routes[0],
    { href: active === "/matches" ? "/matches" : "/explore", label: "Explore Activities" },
    routes[2],
    routes[3],
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-[#F4EFF0] bg-baby-paper/95 backdrop-blur">
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
          <div className="hidden items-center gap-4 text-sm font-bold lg:flex">
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

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="grid h-10 w-10 place-items-center rounded-[10px] border border-[#EBE3E5] bg-white text-baby-ink lg:hidden"
        >
          <Icon name={menuOpen ? "close" : "menu"} className="h-5 w-5" />
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
              <div className="flex flex-col gap-1 text-[15px] font-bold">
                <a href="/profile" className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 hover:bg-white">
                  <Icon name="user" className="h-5 w-5 text-baby-pink" /> {profile?.full_name?.split(" ")[0] || "My account"}
                </a>
                <a href="/profile" className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 hover:bg-white">
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

/** Date field that always reads and writes DD/MM/YYYY.
 *
 *  `<input type="date">` renders in the browser's locale, which showed
 *  MM/DD/YYYY for our QA reviewers. This keeps the value in ISO (yyyy-mm-dd)
 *  for the database while the parent only ever sees day-first, and auto-inserts
 *  the slashes as they type. */
export function DateInput({
  value,
  onChange,
  className = "",
  id,
  placeholder = "DD/MM/YYYY",
}: {
  /** ISO yyyy-mm-dd, or "" when empty. */
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  id?: string;
  placeholder?: string;
}) {
  const isoToUk = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };
  const [text, setText] = useState(() => isoToUk(value));

  // Follow the value when it's changed from outside (e.g. a form reset or a
  // record loading in), but never fight the user mid-typing.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(isoToUk(value));
  }

  function handle(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
    const pretty = parts.join("/");
    setText(pretty);

    if (digits.length < 8) {
      if (value) onChange("");
      return;
    }
    const [dd, mm, yyyy] = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)];
    const iso = `${yyyy}-${mm}-${dd}`;
    // Reject impossible dates (31/02) — Date normalises them silently. Dates
    // that are real but out of range are still emitted: clamping them to ""
    // here made every range problem surface as "enter a date as DD/MM/YYYY",
    // which QA read as the format being wrong. Range is the caller's to judge.
    const d = new Date(`${iso}T00:00:00Z`);
    const isRealDate =
      d.getUTCFullYear() === Number(yyyy) &&
      d.getUTCMonth() + 1 === Number(mm) &&
      d.getUTCDate() === Number(dd);
    onChange(isRealDate ? iso : "");
  }

  /* QA asked for "a calendar pop out so you can easily select dates (but also
   * be able to type too if you wish)". The visible field stays day-first text
   * so typing is unambiguous — a native `type="date"` renders MM/DD/YYYY for
   * some locales, which is what it replaced. The calendar button opens a
   * hidden native date input over the same spot, so picking a date is one tap
   * and the two stay in sync. */
  const picker = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const el = picker.current;
    if (!el) return;
    // showPicker() is the reliable way; older browsers fall back to a click,
    // which opens the picker on the (visually hidden) native control.
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        /* not allowed in this context — fall through */
      }
    }
    el.focus();
    el.click();
  };

  return (
    <span className="relative block">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        aria-describedby={id ? `${id}-format` : undefined}
        onChange={(e) => handle(e.target.value)}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={openPicker}
        aria-label="Open calendar"
        className="absolute right-0 top-0 grid h-full w-10 place-items-center text-[#6D748A] transition hover:text-baby-pink"
      >
        <Icon name="calendar" className="h-4 w-4" />
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value || ""}
        onChange={(e) => {
          const iso = e.target.value;
          setText(isoToUk(iso));
          setLastValue(iso);
          onChange(iso);
        }}
        // Sits under the button so the native popup anchors there, but is
        // never focusable or readable — the text field is the real control.
        className="pointer-events-none absolute right-2 bottom-0 h-0 w-0 opacity-0"
      />
    </span>
  );
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

/** Badge marking listings bookable on BabyBrain (these also sort first). */
export function InstantBookBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-1 rounded-full bg-[#F1FBEF] px-2.5 py-1 text-[11px] font-bold text-[#A8E59A] shadow-soft ${className}`}>
      <Icon name="spark" className="h-3 w-3" /> Instant book
    </span>
  );
}

export function ActivityCard({
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
    <article className="overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white shadow-card">
      <div className="relative h-[108px]">
        <img
          src={activity.image}
          alt=""
          className="h-full w-full object-cover"
        />
        <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-palette-blue shadow-soft">
          {activity.category}
        </span>
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5">
          {activity.instantBook && <InstantBookBadge />}
          {activity.boosted && (
            <span className="flex items-center gap-1 rounded-full bg-[#FEF2D7] px-2.5 py-1 text-[11px] font-bold text-[#FFD77A] shadow-soft">
              <Icon name="star" className="h-3 w-3 fill-current" /> Featured
            </span>
          )}
        </div>
        <SaveHeart
          activityId={activity.id}
          className="absolute right-3 top-3 h-8 w-8"
          onToggled={onFavoriteToggled && activity.id ? (saved) => onFavoriteToggled(activity.id as string, saved) : undefined}
        />
      </div>
      <div className="p-3.5">
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
            {activity.date ? <>{activity.date} · {activity.time}</> : "Schedule TBC"}
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
        {compact ? (
          <div className="mt-3 flex gap-2">
            <Button href={href} size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              View details
            </Button>
            <Button variant="outline" size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              Manage booking
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between border-t border-[#F4EFF0] pt-3">
            <a href={href} className="text-sm font-extrabold text-palette-blue">
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
}

export function ActivityRow({ activity }: { activity: Activity }) {
  const href = activity.slug ? `/activity?slug=${activity.slug}` : "/activity";
  return (
    <a href={href} className="grid grid-cols-1 overflow-hidden rounded-[12px] border border-[#EBE3E5] bg-white shadow-card sm:grid-cols-[170px_1fr] xl:grid-cols-[220px_1fr]">
      <div className="relative">
        <img src={activity.image} alt="" className="h-44 w-full object-cover sm:h-full sm:min-h-[100px]" />
        <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-palette-blue">
          {activity.category}
        </span>
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5">
          {activity.instantBook && <InstantBookBadge />}
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
        <div className="grid grid-cols-2 gap-y-1.5 pr-10 text-[11.5px] font-semibold text-[#52608b]">
          <p className="flex items-center gap-1"><Icon name="user" className="h-3.5 w-3.5 text-palette-blue" /> {activity.age}</p>
          <p className="flex items-center gap-1"><Icon name="pin" className="h-3.5 w-3.5 text-palette-blue" /> {placeLabel(activity)}</p>
          <p className="flex items-center gap-1"><Icon name="calendar" className="h-3.5 w-3.5 text-palette-blue" /> {activity.date || "Schedule TBC"}</p>
          <p>{activity.time}</p>
          {formatDuration(activity.durationMins) && (
            <p className="flex items-center gap-1"><Icon name="clock" className="h-3.5 w-3.5 text-palette-blue" /> {formatDuration(activity.durationMins)}</p>
          )}
          {priceLabel(activity) && <p className="font-black text-palette-blue">{priceLabel(activity)}</p>}
          {activity.rating && <p className="flex items-center gap-1"><Icon name="star" className="h-3.5 w-3.5 text-palette-blue" /> {activity.rating}</p>}
        </div>
      </div>
    </a>
  );
}

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

export function Footer() {
  const { session } = useAuth();
  /* "How It Works" points at the signed-out home page, which a signed-in
     parent never sees — their home is the dashboard — so the link would drop
     them somewhere unrecognisable. Hidden once they're logged in. */
  const exploreLinks: [string, string | null, string?][] = [
    ...(session ? [] : ([["How It Works", "/#how-it-works"]] as [string, string | null][])),
    ["Activities", "/explore"],
    ["About Us", "/about"],
    ["For Partners", "/vendor/"],
  ];
  return (
    <footer className="border-t border-[#F4EFF0] bg-white/70 py-6">
      <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-8 px-6 md:grid-cols-[1.8fr_1fr_1fr_1fr]">
        <div>
          <Brand />
          <p className="mt-3 max-w-[230px] text-sm font-semibold leading-5 text-[#59658d]">
            Helping parents discover and book activities for their children.
          </p>
        </div>
        {([
          ["Explore", exploreLinks],
          ["Support", [["Contact Us", "/contact"], ["FAQs", "/contact#faq"], ["Privacy Policy", "/terms#privacy"], ["Terms of Service", "/terms"]]],
          ["Follow Us", [["Instagram", "https://instagram.com/babybrainsg", "instagram"]]],
        ] as [string, [string, string | null, string?][]][]).map(([title, links]) => (
          <div key={title} className="text-sm">
            <h3 className="mb-3 font-black">{title}</h3>
            <div className="space-y-1.5 font-semibold text-[#59658d]">
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
