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

export default RainbowLoader
