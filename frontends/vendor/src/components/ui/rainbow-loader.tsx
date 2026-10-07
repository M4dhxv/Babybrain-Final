import { cn } from "@/lib/utils"

/** The six supplied brand pastels, in rainbow order. */
const DOTS = ["#FFC1D6", "#FFB77A", "#FFD77A", "#A8E59A", "#A7D8F8", "#C7B1E6"]

/**
 * RainbowLoader — the brand's six pastels bouncing in a wave. The site-wide
 * inline / in-card loading indicator (the full-page boot loader lives in
 * index.html). Centred by default; pass `className` for padding or to override
 * alignment. Animation + reduced-motion handling come from `.bb-wave-dot` in
 * index.css, so it renders identically on mobile.
 */
export function RainbowLoader({
  className,
  label = "Loading",
  size = "md",
}: {
  className?: string
  label?: string
  /** `sm` for tight single-line spots, `md` (default) for cards and lists. */
  size?: "sm" | "md"
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex items-end justify-center gap-2", className)}
    >
      {DOTS.map((color, i) => (
        <span
          key={color}
          className={cn("bb-wave-dot", size === "sm" && "bb-wave-dot--sm")}
          style={{ background: color, animationDelay: `${i * 0.1}s` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

/** "BabyBrain" in the logo's rainbow, letter by letter. Same colours as the boot splash in index.html. */
const WORD = [
  ["B", "#ffc1d6"], ["a", "#ffc1d6"], ["b", "#ffb77a"], ["y", "#ffd77a"], ["B", "#a8e59a"],
  ["r", "#a7d8f8"], ["a", "#a7d8f8"], ["i", "#c7b1e6"], ["n", "#c7b1e6"],
] as const

/**
 * FullPageLoader — the full-screen loader (route chunks downloading, signing in,
 * loading the portal). Matches the boot splash in index.html — cream background,
 * the rainbow dots and the BabyBrain name — so the hand-off from splash to app
 * doesn't change look. `data-bb-loading` lets the index.html watchdog treat it
 * as "loading", not "wedged". Inline / in-card spots keep using RainbowLoader.
 */
export function FullPageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div
      data-bb-loading
      role="status"
      aria-label={label}
      className="flex h-screen flex-col items-center justify-center gap-[22px] bg-[#fffcf8]"
    >
      <div className="flex items-end gap-2.5" aria-hidden="true">
        {DOTS.map((color, i) => (
          <span
            key={color}
            className="bb-wave-dot"
            style={{ background: color, width: 14, height: 14, animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </div>
      <div className="text-[15px] font-extrabold tracking-tight" aria-hidden="true">
        {WORD.map(([ch, color], i) => (
          <span key={i} style={{ color }}>{ch}</span>
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  )
}

export default RainbowLoader
