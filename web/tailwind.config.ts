import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: [
    "bg-emerald-200",
    "bg-emerald-400",
    "text-emerald-950",
    "bg-green-200",
    "bg-green-400",
    "text-green-950",
    "bg-teal-200",
    "bg-teal-400",
    "text-teal-950",
    "bg-sky-200",
    "bg-sky-400",
    "text-sky-950",
    "bg-amber-200",
    "bg-amber-300",
    "text-amber-950",
    "bg-orange-200",
    "bg-orange-400",
    "text-orange-950",
    "bg-rose-200",
    "bg-rose-400",
    "text-rose-950",
    "bg-red-200",
    "bg-red-500",
    "text-red-950",
    "ring-red-300",
    "bg-stone-100",
    "bg-stone-200",
    "text-stone-400",
    "text-stone-900",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
};
export default config;
