import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppNav } from "@/components/layout/AppNav";
import { AppSessionProvider } from "@/components/providers/AppSessionProvider";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "ReportGen — Valuation workflow",
  description:
    "Upload benchmark PDFs and business tax returns. Extract numbers for Excel paste — without retyping or overwriting formula cells.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-stone-50 font-sans text-stone-900 antialiased`}
      >
        <AppNav />
        <AppSessionProvider>{children}</AppSessionProvider>
      </body>
    </html>
  );
}
