import { cn } from "@/lib/utils"

/** The six supplied brand pastels, in rainbow order. */
const DOTS = ["#FFC1D6", "#FFB77A", "#FFD77A", "#A8E59A", "#A7D8F8", "#C7B1E6"]

/**
 * RainbowLoader — the brand's six pastels bouncing in a wave. Use for inline
 * and in-card loading states (the full-page boot loader lives in index.html).
 * Animation + reduced-motion handling come from `.bb-wave-dot` in index.css.
 */
export function RainbowLoader({
  className,
  label = "Loading",
}: {
  className?: string
  label?: string
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex items-end gap-2", className)}
    >
      {DOTS.map((color, i) => (
        <span
          key={color}
          className="bb-wave-dot"
          style={{ background: color, animationDelay: `${i * 0.1}s` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

export default RainbowLoader
