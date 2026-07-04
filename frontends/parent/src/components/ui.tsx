import { useState } from "react";
import type { Activity } from "../data/content";
import { routes } from "../data/content";
import { useActivities } from "../lib/useActivities";
import { useFavorite } from "../lib/data";
import { useAuth } from "../auth/AuthProvider";

/** Heart button that saves/unsaves an activity to the parent's favorites.
 *  Guards its own click so it works inside a card link. */
export function SaveHeart({
  activityId,
  className = "",
}: {
  activityId?: string;
  className?: string;
}) {
  const fav = useFavorite(activityId);
  return (
    <button
      type="button"
      aria-label={fav.saved ? "Saved to favorites" : "Save to favorites"}
      aria-pressed={fav.saved}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        fav.toggle();
      }}
      className={`grid place-items-center rounded-full shadow-soft transition ${
        fav.saved ? "bg-baby-pink text-white" : "bg-white text-baby-pink"
      } ${className}`}
    >
      <Icon name="heart" className="h-4.5 w-4.5" />
    </button>
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
  | "close";

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
  gear:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3c0-.5 0-1-.1-1.4l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.5-1.4L11.9 2H8l-.5 2.8a7 7 0 0 0-2.5 1.4l-2.4-1-2 3.4 2 1.6c-.1.4-.1.9-.1 1.4s0 1 .1 1.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.5 1.4L8 22h4l.5-2.8a7 7 0 0 0 2.5-1.4l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.4Z",
  clock:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3.5 2",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
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

export function Brand() {
  return (
    <a href="/" className="flex items-center gap-2" aria-label="BabyBrain.sg home">
      <img
        src={`${import.meta.env.BASE_URL}assets/crops/logo-mascot.png`}
        alt=""
        className="h-10 w-10 rounded-full"
      />
      <span className="text-[25px] font-extrabold leading-none">
        <span className="text-baby-pink">Baby</span>
        <span className="text-baby-blue">Brain</span>
        <span className="text-sm font-black text-baby-ink">.sg</span>
      </span>
    </a>
  );
}

type HeaderProps = {
  active?: string;
  auth?: "public" | "user";
};

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
    <header className="sticky top-0 z-30 border-b border-[#edf0fb] bg-baby-paper/95 backdrop-blur">
      <div className="mx-auto flex h-[62px] max-w-[1180px] items-center justify-between px-4 sm:px-6">
        <Brand />
        <nav className="hidden items-center gap-6 text-[13px] font-bold text-baby-ink md:flex lg:gap-9">
          {navItems.map((route) => (
            <a
              key={route.href}
              href={route.href}
              className={`relative py-5 ${
                active === route.href ? "text-[#1275ff]" : ""
              }`}
            >
              {route.label}
              {active === route.href && (
                <span className="absolute inset-x-0 bottom-0 h-1 rounded-t-full bg-[#4a9cff]" />
              )}
            </a>
          ))}
        </nav>

        {/* Desktop auth actions */}
        {!session ? (
          <div className="hidden items-center gap-3 md:flex">
            <Button href="/login" variant="outline" size="sm">
              <Icon name="user" className="h-4 w-4" /> Log In
            </Button>
            <Button href="/onboarding" size="sm">
              <Icon name="user" className="h-4 w-4" /> Sign Up
            </Button>
          </div>
        ) : (
          <div className="hidden items-center gap-4 text-sm font-bold md:flex">
            <a href="/profile?tab=favorites" className="flex items-center gap-1.5 text-baby-ink hover:text-baby-pink">
              <Icon name="heart" className="h-5 w-5 text-baby-pink" /> Saved
            </a>
            <a
              href="/profile"
              className="flex items-center gap-2 rounded-full border border-[#e9edf8] bg-white py-1 pl-1 pr-3 shadow-soft hover:border-[#d4ddf3]"
            >
              <img
                src={`${import.meta.env.BASE_URL}assets/crops/mom-avatar.png`}
                alt=""
                className="h-7 w-7 rounded-full object-cover"
              />
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
          className="grid h-10 w-10 place-items-center rounded-[10px] border border-[#e4e9f6] bg-white text-baby-ink md:hidden"
        >
          <Icon name={menuOpen ? "close" : "menu"} className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <nav className="border-t border-[#edf0fb] bg-baby-paper px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1 text-[15px] font-bold text-baby-ink">
            {navItems.map((route) => (
              <a
                key={route.href}
                href={route.href}
                className={`rounded-[10px] px-3 py-2.5 ${active === route.href ? "bg-[#eaf2ff] text-[#1275ff]" : "hover:bg-white"}`}
              >
                {route.label}
              </a>
            ))}
          </div>
          <div className="mt-3 border-t border-[#e7ebf6] pt-3">
            {!session ? (
              <div className="flex flex-col gap-2">
                <Button href="/login" variant="outline" className="w-full justify-center">
                  <Icon name="user" className="h-4 w-4" /> Log In
                </Button>
                <Button href="/onboarding" className="w-full justify-center">
                  <Icon name="user" className="h-4 w-4" /> Sign Up
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1 text-[15px] font-bold">
                <a href="/profile" className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 hover:bg-white">
                  <Icon name="user" className="h-5 w-5 text-baby-blue" /> {profile?.full_name?.split(" ")[0] || "My account"}
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
  variant?: "primary" | "outline" | "soft" | "pink" | "ghost";
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
  const variantClass = {
    primary:
      "bg-gradient-to-r from-[#4aa1ff] to-[#5ea6f6] text-white shadow-blue hover:brightness-105",
    outline:
      "border border-[#4194ff] bg-white text-[#1975ff] hover:bg-[#f4f9ff]",
    soft: "bg-[#f3f7ff] text-[#2b7cff] hover:bg-[#eaf2ff]",
    pink: "bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] text-white shadow-pink",
    ghost: "bg-transparent text-[#1877ff] hover:bg-[#f3f7ff]",
  }[variant];
  const classes = `inline-flex items-center justify-center gap-2 rounded-[11px] font-extrabold leading-none transition ${sizeClass} ${variantClass} ${className}${disabled ? " cursor-not-allowed opacity-60" : ""}`;

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
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <h2 className="text-[22px] font-black leading-tight tracking-normal text-baby-ink">
        {children} <Icon name="spark" className="inline h-5 w-5 text-[#4a9cff]" />
      </h2>
      {action}
    </div>
  );
}

export function ActivityCard({
  activity,
  compact = false,
}: {
  activity: Activity;
  compact?: boolean;
}) {
  const href = activity.slug ? `/activity?slug=${activity.slug}` : "/activity";
  return (
    <article className="overflow-hidden rounded-[14px] border border-[#e6eaf6] bg-white shadow-card">
      <div className="relative h-[108px]">
        <img
          src={activity.image}
          alt=""
          className="h-full w-full object-cover"
        />
        <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-baby-pink shadow-soft">
          {activity.category}
        </span>
        <SaveHeart activityId={activity.id} className="absolute right-3 top-3 h-8 w-8" />
      </div>
      <div className="p-3.5">
        <h3 className="mb-2 text-[15px] font-black leading-tight text-baby-ink">
          {activity.title}
        </h3>
        <div className="space-y-1 text-[11.5px] font-semibold text-[#4a5685]">
          <p className="flex items-center gap-1.5"><Icon name="user" className="h-3.5 w-3.5 text-[#4a9cff]" /> {activity.age}</p>
          <p className="flex items-center gap-1.5"><Icon name="pin" className="h-3.5 w-3.5 text-[#a988ee]" /> {activity.venue}</p>
          <p className="flex items-center gap-1.5"><Icon name="calendar" className="h-3.5 w-3.5 text-[#4a9cff]" /> {activity.date} · {activity.time}</p>
          {!compact && (
            <p>
              <Icon name="star" className="inline h-3.5 w-3.5 text-[#4a9cff]" /> {activity.rating} ·{" "}
              <Icon name="spark" className="inline h-3.5 w-3.5 text-baby-pink" /> {activity.note}
            </p>
          )}
        </div>
        {compact ? (
          <div className="mt-3 flex gap-2">
            <Button href={href} size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              View Details
            </Button>
            <Button variant="outline" size="sm" className="flex-1 rounded-[8px] px-3 py-2 text-xs">
              Manage Booking
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between border-t border-[#eef1f8] pt-3">
            <a href={href} className="text-sm font-extrabold text-[#2484ff]">
              View Details
            </a>
            <div className="flex gap-4 text-xl text-[#1c2b61]">
              <button aria-label="Open"><Icon name="open" className="h-5 w-5" /></button>
              <button aria-label="Bookmark"><Icon name="bookmark" className="h-5 w-5" /></button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export function ActivityRow({ activity }: { activity: Activity }) {
  const href = activity.slug ? `/activity?slug=${activity.slug}` : "/activity";
  return (
    <a href={href} className="grid grid-cols-[240px_1fr] overflow-hidden rounded-[12px] border border-[#e5e9f5] bg-white shadow-card">
      <div className="relative">
        <img src={activity.image} alt="" className="h-full min-h-[100px] w-full object-cover" />
        <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-baby-pink">
          {activity.category}
        </span>
      </div>
      <div className="relative p-4">
        <SaveHeart activityId={activity.id} className="absolute right-4 top-4 h-9 w-9" />
        <h3 className="mb-2 text-[16px] font-black">{activity.title}</h3>
        <div className="grid grid-cols-2 gap-y-1.5 pr-10 text-[11.5px] font-semibold text-[#52608b]">
          <p className="flex items-center gap-1"><Icon name="user" className="h-3.5 w-3.5 text-baby-pink" /> {activity.age}</p>
          <p className="flex items-center gap-1"><Icon name="pin" className="h-3.5 w-3.5 text-baby-pink" /> {activity.venue}</p>
          <p className="flex items-center gap-1"><Icon name="calendar" className="h-3.5 w-3.5 text-baby-pink" /> {activity.date}</p>
          <p>{activity.time}</p>
          <p className="flex items-center gap-1"><Icon name="star" className="h-3.5 w-3.5 text-[#4a9cff]" /> {activity.rating}</p>
          <p>{activity.note}</p>
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
      onClick={onClick ?? (href ? () => { window.location.href = href; } : undefined)}
      className="flex min-h-[72px] items-center gap-3 rounded-[12px] border border-[#e9edf7] bg-white px-3.5 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-soft">
      <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-gradient-to-br from-[#fff0f7] to-[#f0f7ff] text-baby-pink">
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
  return (
    <footer className="border-t border-[#eef0f8] bg-white/70 py-6">
      <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-8 px-6 md:grid-cols-[1.8fr_1fr_1fr_1fr]">
        <div>
          <Brand />
          <p className="mt-3 max-w-[230px] text-sm font-semibold leading-5 text-[#59658d]">
            Helping parents discover and book activities that support their
            child's learning and development.
          </p>
        </div>
        {([
          ["Explore", [["Explore Classes", "/explore"], ["How it Works", "/"], ["About Us", "/about"], ["For Partners", "/contact"]]],
          ["Support", [["Contact Us", "/contact"], ["FAQ", "/contact"], ["Privacy Policy", "/terms#privacy"], ["Terms of Use", "/terms"]]],
          ["Follow Us", [["Instagram", null], ["hello@babybrain.sg", "mailto:hello@babybrain.sg"]]],
        ] as [string, [string, string | null][]][]).map(([title, links]) => (
          <div key={title} className="text-sm">
            <h3 className="mb-3 font-black">{title}</h3>
            <div className="space-y-1.5 font-semibold text-[#59658d]">
              {links.map(([label, href]) =>
                href ? (
                  <p key={label}>
                    <a href={href} className="hover:text-baby-blue">{label}</a>
                  </p>
                ) : (
                  <p key={label}>{label}</p>
                )
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-xs font-semibold text-[#7b85a7]">
        © 2024 BabyBrain.sg. All rights reserved.
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
