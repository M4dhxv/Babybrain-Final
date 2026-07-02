import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        baby: {
          ink: "#111A4C",
          blue: "#4597F7",
          pink: "#FA5D93",
          lilac: "#9568DF",
          paper: "#FFFCF8",
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
