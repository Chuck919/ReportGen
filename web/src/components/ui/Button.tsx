import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

const styles: Record<Variant, string> = {
  primary:
    "border-stone-900 bg-stone-900 text-white shadow-sm hover:bg-stone-800",
  secondary:
    "border-stone-300 bg-white text-stone-800 shadow-sm hover:bg-stone-50",
  ghost: "border-transparent bg-transparent text-stone-600 hover:bg-stone-100 hover:text-stone-900",
};

export function Button({
  children,
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button
      type="button"
      className={[
        "inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium transition",
        styles[variant],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}
