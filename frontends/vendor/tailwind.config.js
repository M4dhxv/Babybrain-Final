/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        /* The vendor portal styles itself almost entirely with Tailwind's stock
         * colour classes (bg-pink-100, text-green-600, …) — ~1000 usages across
         * ~40 files. Rather than rewrite every one, the stock ramps are
         * re-pointed at the brand palette here, so the whole portal moves with
         * a single source of truth.
         *
         * `300` is the palette colour exactly as supplied. 50–200 are its
         * tints, 500 clears 3:1 and 600+ clear 4.5:1 (against paper, white and
         * this hue's own tints), because at 1.4–1.9:1 the palette colours
         * themselves can fill but never carry text.
         *
         * `red` keeps its own identity — errors shouldn't blend into the
         * palette — but 500 is darkened from Tailwind's #EF4444 (3.68:1) so
         * error text and "remove my listing" links are actually legible. */
        red:    { 50:"#FEF2F2",100:"#FEE2E2",200:"#FECACA",300:"#FCA5A5",400:"#F87171",500:"#E02929",600:"#C81E1E",700:"#A61B1B",800:"#881A1A",900:"#701C1C" },
        pink:   { 50:"#FEF5F8",100:"#FEECF2",200:"#FED7E4",300:"#FFC1D6",400:"#FF89B1",500:"#FF528C",600:"#C90044",700:"#A50038",800:"#87002E",900:"#6D0025" },
        yellow: { 50:"#FEFCF5",100:"#FEF8EC",200:"#FEF2D7",300:"#FFD77A",400:"#FFBC1F",500:"#C38800",600:"#936700",700:"#6F4E00",800:"#513900",900:"#372700" },
        green:  { 50:"#F8FDF7",100:"#F1FAEF",200:"#E3F6DF",300:"#A8E59A",400:"#6DD355",500:"#42A72B",600:"#317D20",700:"#266119",800:"#1C4812",900:"#14340D" },
        blue:   { 50:"#F6FBFE",100:"#EDF6FD",200:"#DAEEFB",300:"#A7D8F8",400:"#60B9F2",500:"#1999ED",600:"#0E6FAF",700:"#0B5A8E",800:"#094872",900:"#07395A" },
        purple: { 50:"#F9F8FC",100:"#F4F0FA",200:"#E9E1F5",300:"#C7B1E6",400:"#B69ADE",500:"#A582D7",600:"#7D4AC5",700:"#6B39B2",800:"#5D329B",900:"#522B88" },
        orange: { 50:"#FEFAF5",100:"#FEF4EC",200:"#FEE9D7",300:"#FFB77A",400:"#FF9135",500:"#EE6D00",600:"#AE5000",700:"#8A4000",800:"#6C3200",900:"#522600" },
        /* Aliases so a stray `rose-`/`emerald-`/`amber-`/`violet-`/`sky-` class
         * can't reintroduce an off-palette hue. */
        rose:    { 50:"#FEF5F8",100:"#FEECF2",200:"#FED7E4",300:"#FFC1D6",400:"#FF89B1",500:"#FF528C",600:"#C90044",700:"#A50038",800:"#87002E",900:"#6D0025" },
        emerald: { 50:"#F8FDF7",100:"#F1FAEF",200:"#E3F6DF",300:"#A8E59A",400:"#6DD355",500:"#42A72B",600:"#317D20",700:"#266119",800:"#1C4812",900:"#14340D" },
        amber:   { 50:"#FEFCF5",100:"#FEF8EC",200:"#FEF2D7",300:"#FFD77A",400:"#FFBC1F",500:"#C38800",600:"#936700",700:"#6F4E00",800:"#513900",900:"#372700" },
        violet:  { 50:"#F9F8FC",100:"#F4F0FA",200:"#E9E1F5",300:"#C7B1E6",400:"#B69ADE",500:"#A582D7",600:"#7D4AC5",700:"#6B39B2",800:"#5D329B",900:"#522B88" },
        sky:     { 50:"#F6FBFE",100:"#EDF6FD",200:"#DAEEFB",300:"#A7D8F8",400:"#60B9F2",500:"#1999ED",600:"#0E6FAF",700:"#0B5A8E",800:"#094872",900:"#07395A" },
        /* Warm neutral, so borders and panels sit with the pastels instead of
         * fighting them. `400` is darkened from Tailwind's stock #9CA3AF, which
         * is 2.85:1 — the portal uses it on real text ~50 times. */
        gray:   { 50:"#FAF7F7",100:"#F4EFF0",200:"#EBE3E5",300:"#DCD2D5",400:"#7B7278",500:"#6E646B",600:"#5A5157",700:"#494146",800:"#332D31",900:"#211D20" },
        slate:  { 50:"#FAF7F7",100:"#F4EFF0",200:"#EBE3E5",300:"#DCD2D5",400:"#7B7278",500:"#6E646B",600:"#5A5157",700:"#494146",800:"#332D31",900:"#211D20" },

        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // BabyBrain custom colors
        bb: {
          pink: {
            DEFAULT: "hsl(var(--bb-pink))",
            light: "hsl(var(--bb-pink-light))",
          },
          orange: {
            DEFAULT: "hsl(var(--bb-orange))",
          },
          navy: {
            DEFAULT: "hsl(var(--bb-navy))",
          },
          green: {
            DEFAULT: "hsl(var(--bb-green))",
            light: "hsl(var(--bb-green-light))",
          },
          purple: {
            DEFAULT: "hsl(var(--bb-purple))",
            light: "hsl(var(--bb-purple-light))",
          },
          blue: {
            DEFAULT: "hsl(var(--bb-blue))",
            light: "hsl(var(--bb-blue-light))",
          },
          yellow: {
            DEFAULT: "hsl(var(--bb-yellow))",
            light: "hsl(var(--bb-yellow-light))",
          },
          teal: {
            DEFAULT: "hsl(var(--bb-teal))",
          },
          gray: {
            DEFAULT: "hsl(var(--bb-gray))",
            light: "hsl(var(--bb-gray-light))",
          },
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        card: "0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03)",
        "card-hover": "0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04)",
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "slide-out-right": "slide-out-right 0.3s ease-out",
        "fade-in": "fade-in 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
