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
 */
export function BootSplash({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col items-center justify-center gap-3.5 py-16">
      <div className="relative flex h-[92px] w-[92px] items-center justify-center">
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
                transform: `rotate(${d.angle}deg) translateY(-38px)`,
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
      <div className="flex text-[15px] font-extrabold tracking-tight">
        {"BabyBrain".split("").map((ch, i) => (
          <i key={i} style={{ color: NAME_COLORS[i], fontStyle: "normal" }}>{ch}</i>
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default BootSplash;
