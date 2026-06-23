"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useTaxUpload } from "@/hooks/use-tax-upload";
import { useBenchmarkUpload } from "@/hooks/use-benchmark-upload";

type AppSessionContextValue = {
  tax: ReturnType<typeof useTaxUpload>;
  benchmark: ReturnType<typeof useBenchmarkUpload>;
};

const AppSessionContext = createContext<AppSessionContextValue | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const tax = useTaxUpload();
  const benchmark = useBenchmarkUpload();
  return (
    <AppSessionContext.Provider value={{ tax, benchmark }}>{children}</AppSessionContext.Provider>
  );
}

export function useAppSession(): AppSessionContextValue {
  const ctx = useContext(AppSessionContext);
  if (!ctx) throw new Error("useAppSession must be used within AppSessionProvider");
  return ctx;
}
