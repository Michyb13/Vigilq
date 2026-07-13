import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ApiKeyProvider } from "@/lib/ApiKeyProvider";
import NavBar from "./NavBar";

const plexSans = localFont({
  src: "./fonts/plex-sans-var.woff2",
  variable: "--font-plex-sans",
  weight: "100 700",
  display: "swap",
});

const plexMono = localFont({
  src: [
    { path: "./fonts/plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-mono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VigilQ",
  description: "VigilQ job queue dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-full flex flex-col bg-bg text-text font-sans">
        <ApiKeyProvider>
          <NavBar />
          <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
        </ApiKeyProvider>
      </body>
    </html>
  );
}
