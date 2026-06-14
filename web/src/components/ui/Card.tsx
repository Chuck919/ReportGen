import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  padding = true,
}: {
  children: ReactNode;
  className?: string;
  padding?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-2xl border border-stone-200 bg-white shadow-sm",
        padding ? "p-6" : "",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}
