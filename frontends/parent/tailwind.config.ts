import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Brand accents ARE the palette shades now. They used to be each hue
         * darkened for legibility, which read as crimson / forest green /
         * aubergine rather than the pastels — the "strange colours" from QA.
         * `blue` stays the CTA blue; `ink` and `paper` are neutrals. */
        baby: {
          ink: "#111A4C",
          blue: "#4597F7",
          pink: "#FFC1D6",
          /* The CTA gradient's own pink — the colour of the filled buttons.
           * Used for text sitting on a pink pastel, so labels read in the same
           * pink as the buttons rather than a darker crimson. */
          cta: "#FA4D8D",
          lilac: "#C7B1E6",
          green: "#A8E59A",
          orange: "#FFB77A",
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
        /* This config only *extends*, so Tailwind's stock ramps stay reachable
         * and a plain `text-green-700` / `bg-amber-50` silently paints an
         * off-palette hue. Re-point the stock ramps at the palette (same values
         * as the vendor portal) so no stray class can escape it.
         *
         * `300` is the palette colour exactly as supplied; 50–200 are its
         * tints, 500 clears 3:1 and 600+ clear 4.5:1. `red` keeps its own
         * identity so errors don't blend into the palette. */
        red:    { 50:"#FEF2F2",100:"#FEE2E2",200:"#FECACA",300:"#FCA5A5",400:"#F87171",500:"#E02929",600:"#C81E1E",700:"#A61B1B",800:"#881A1A",900:"#701C1C" },
        pink:   { 50:"#FEF5F8",100:"#FEECF2",200:"#FED7E4",300:"#FFC1D6",400:"#FF89B1",500:"#FF528C",600:"#C90044",700:"#A50038",800:"#87002E",900:"#6D0025" },
        yellow: { 50:"#FEFCF5",100:"#FEF8EC",200:"#FEF2D7",300:"#FFD77A",400:"#FFBC1F",500:"#C38800",600:"#936700",700:"#6F4E00",800:"#513900",900:"#372700" },
        green:  { 50:"#F8FDF7",100:"#F1FAEF",200:"#E3F6DF",300:"#A8E59A",400:"#6DD355",500:"#42A72B",600:"#317D20",700:"#266119",800:"#1C4812",900:"#14340D" },
        blue:   { 50:"#F6FBFE",100:"#EDF6FD",200:"#DAEEFB",300:"#A7D8F8",400:"#60B9F2",500:"#1999ED",600:"#0E6FAF",700:"#0B5A8E",800:"#094872",900:"#07395A" },
        purple: { 50:"#F9F8FC",100:"#F4F0FA",200:"#E9E1F5",300:"#C7B1E6",400:"#B69ADE",500:"#A582D7",600:"#7D4AC5",700:"#6B39B2",800:"#5D329B",900:"#522B88" },
        orange: { 50:"#FEFAF5",100:"#FEF4EC",200:"#FEE9D7",300:"#FFB77A",400:"#FF9135",500:"#EE6D00",600:"#AE5000",700:"#8A4000",800:"#6C3200",900:"#522600" },
        /* Aliases, so a stray `rose-`/`amber-`/`emerald-`/`sky-`/`violet-`
         * can't reintroduce an off-palette hue either. */
        rose:    { 50:"#FEF5F8",100:"#FEECF2",200:"#FED7E4",300:"#FFC1D6",400:"#FF89B1",500:"#FF528C",600:"#C90044",700:"#A50038",800:"#87002E",900:"#6D0025" },
        amber:   { 50:"#FEFCF5",100:"#FEF8EC",200:"#FEF2D7",300:"#FFD77A",400:"#FFBC1F",500:"#C38800",600:"#936700",700:"#6F4E00",800:"#513900",900:"#372700" },
        emerald: { 50:"#F8FDF7",100:"#F1FAEF",200:"#E3F6DF",300:"#A8E59A",400:"#6DD355",500:"#42A72B",600:"#317D20",700:"#266119",800:"#1C4812",900:"#14340D" },
        sky:     { 50:"#F6FBFE",100:"#EDF6FD",200:"#DAEEFB",300:"#A7D8F8",400:"#60B9F2",500:"#1999ED",600:"#0E6FAF",700:"#0B5A8E",800:"#094872",900:"#07395A" },
        violet:  { 50:"#F9F8FC",100:"#F4F0FA",200:"#E9E1F5",300:"#C7B1E6",400:"#B69ADE",500:"#A582D7",600:"#7D4AC5",700:"#6B39B2",800:"#5D329B",900:"#522B88" },
        /* Warm neutral, so borders and panels sit with the pastels instead of
         * fighting them. This also fixes the *default* border colour: Tailwind
         * resolves `borderColor.DEFAULT` from `gray.200`, so every element with
         * a border width but no explicit colour was painting stock #E5E7EB — a
         * cool grey, and by far the most-applied colour on the page. */
        gray:   { 50:"#FAF7F7",100:"#F4EFF0",200:"#EBE3E5",300:"#DCD2D5",400:"#7B7278",500:"#6E646B",600:"#5A5157",700:"#494146",800:"#332D31",900:"#211D20" },
        slate:  { 50:"#FAF7F7",100:"#F4EFF0",200:"#EBE3E5",300:"#DCD2D5",400:"#7B7278",500:"#6E646B",600:"#5A5157",700:"#494146",800:"#332D31",900:"#211D20" },
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
