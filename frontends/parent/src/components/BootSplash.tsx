import { useLayoutEffect, useRef } from "react";
import { SPLASH_LOGO } from "../lib/splashLogo";

const ORBIT_DOTS = [
  { color: "#ffc1d6", size: 8, angle: 0 },
  { color: "#ffd77a", size: 7, angle: 72 },
  { color: "#a8e59a", size: 9, angle: 144 },
  { color: "#a7d8f8", size: 7, angle: 216 },
  { color: "#c7b1e6", size: 8, angle: 288 },
];
/** "BabyBrain", one colour per letter — same sweep as index.html's #bb-boot. */
const NAME_COLORS = ["#ffc1d6", "#ffc1d6", "#ffb77a", "#ffd77a", "#a8e59a", "#a7d8f8", "#a7d8f8", "#c7b1e6", "#c7b1e6"];

/**
 * Full-screen boot loader — the mascot orbited by the brand dots, matching
 * index.html's #bb-boot splash (see styles/index.css's bb-splash-* rules)
 * so the "still loading" look stays the same once React has mounted (a lazy
 * route chunk downloading, or the auth gate resolving) instead of dropping
 * to the plain <RainbowLoader> partway through boot — which is what QA saw
 * as "the logo splash keeps getting replaced by six flat dots".
 *
 * Boot hands off between several of these (#bb-boot → auth gate → lazy
 * chunk fallback → login redirect), so two things keep the hand-off
 * invisible:
 *  - Position: a fixed full-screen overlay laid out exactly like #bb-boot
 *    (same box, gap, font and line-height), so the logo sits on the same
 *    pixel whatever wrapper renders this.
 *  - Phase: every instance pins its animations' startTime to 0 on the
 *    document timeline (#bb-boot does the same in index.html), so a fresh
 *    mount picks the orbit and bob up mid-motion instead of snapping back
 *    to 0°.
 */
export function BootSplash({ label = "Loading" }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    syncToTimeline(ref.current);
  }, []);
  return (
    <div
      ref={ref}
      role="status"
      aria-label={label}
      className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-3.5 bg-[#fffcf8] leading-normal"
      style={{ fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif" }}
    >
      <div className="relative flex h-[116px] w-[116px] items-center justify-center">
        <div className="bb-splash-orbit absolute inset-0">
          {ORBIT_DOTS.map((d, i) => (
            <i
              key={i}
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 rounded-full"
              style={{
                width: d.size,
                height: d.size,
                marginTop: -d.size / 2,
                marginLeft: -d.size / 2,
                background: d.color,
                transform: `rotate(${d.angle}deg) translateY(-52px)`,
              }}
            />
          ))}
        </div>
        <img
          src={SPLASH_LOGO}
          width={64}
          height={64}
          alt=""
          className="bb-splash-icon relative z-10 h-16 w-16 object-contain"
        />
      </div>
      <div className="flex text-[15px] font-extrabold tracking-[-0.01em]">
        {"BabyBrain".split("").map((ch, i) => (
          <i key={i} style={{ color: NAME_COLORS[i], fontStyle: "normal" }}>{ch}</i>
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Starts every CSS animation under `el` at time 0 of the page's timeline, so
 *  all splash instances share one phase. No-op where getAnimations is missing. */
function syncToTimeline(el: HTMLElement | null) {
  if (!el || typeof el.getAnimations !== "function") return;
  for (const a of el.getAnimations({ subtree: true })) a.startTime = 0;
}

export default BootSplash;
