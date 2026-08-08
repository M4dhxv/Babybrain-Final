import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Brand tokens.
         *
         * These are the *text* tier: `baby-pink` alone is used as a text colour
         * ~100 times, so it has to stay readable. Each one is the legible member
         * of its hue family in `palette` below, dark enough to clear 4.5:1 on
         * the paper, on white cards, and on its own tinted badges.
         *
         * `blue` is the exception — it fills the in-app CTA button under white
         * text, so it keeps its original value. */
        baby: {
          ink: "#111A4C",
          blue: "#4597F7",
          pink: "#D9004A",
          lilac: "#7D4AC5",
          green: "#327D20",
          orange: "#AE5000",
          paper: "#FFFCF8",
        },
        /* The supplied six-colour palette, plus the tints and inks derived from
         * each hue. `surface` is the palette colour exactly as given; at
         * 1.4–1.9:1 on white it can fill and outline but must never carry text.
         * `strong` clears 3:1 (large text, icons), `ink` clears 4.5:1 (body)
         * against paper, white and that hue's own tint + soft. */
        palette: {
          pink: "#FFC1D6", pinkTint: "#FFF5F8", pinkSoft: "#FEEBF2", pinkMuted: "#FED7E4",
          pinkStrong: "#FF528C", pinkInk: "#D9004A",

          yellow: "#FFD77A", yellowTint: "#FEF9EB", yellowSoft: "#FEF2D7",
          yellowStrong: "#C28800", yellowInk: "#936700",

          green: "#A8E59A", greenTint: "#F1FBEF", greenSoft: "#E3F6DF",
          greenStrong: "#42A72B", greenInk: "#327D20",

          blue: "#A7D8F8", blueTint: "#EDF7FD", blueSoft: "#DAEEFB",
          blueStrong: "#1999ED", blueInk: "#0E6FAE",

          purple: "#C7B1E6", purpleTint: "#F4F0FA", purpleSoft: "#E9E1F5",
          purpleStrong: "#A581D7", purpleInk: "#7D4AC5",

          orange: "#FFB77A", orangeTint: "#FEF4EB", orangeSoft: "#FEE9D7",
          orangeStrong: "#ED6D00", orangeInk: "#AE5000",
        },
      },
      fontFamily: {
        sans: [
          "Nunito",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      spacing: {
        "4.5": "1.125rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(17,26,76,0.04), 0 6px 16px rgba(17,26,76,0.06)",
        soft: "0 2px 6px rgba(17,26,76,0.06), 0 12px 28px rgba(17,26,76,0.10)",
        blue: "0 8px 20px rgba(69,151,247,0.32)",
        pink: "0 8px 20px rgba(250,93,147,0.32)",
      },
    },
  },
  plugins: [],
} satisfies Config;
