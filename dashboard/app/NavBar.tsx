"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/jobs", label: "Jobs" },
  { href: "/dead-letter", label: "Dead Letter" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/85 backdrop-blur-sm">
      <nav className="mx-auto flex max-w-5xl items-center gap-8 px-6 py-4">
        <span className="flex items-center gap-2 font-mono text-sm font-medium tracking-tight text-text">
          <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-dim)]" />
          VigilQ
        </span>
        <div className="flex gap-6">
          {links.map((link) => {
            // next/navigation's usePathname() already strips the basePath, so
            // this compares against plain "/", "/jobs", etc. — no manual
            // "/dashboard" prefix handling needed here or in the Link hrefs.
            // trailingSlash:true means pathname is "/jobs/" not "/jobs", so
            // both sides are normalized before comparing.
            const normalize = (p: string) => (p !== "/" && p.endsWith("/") ? p.slice(0, -1) : p);
            const active = normalize(pathname) === normalize(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm transition-colors ${
                  active ? "font-medium text-accent" : "text-text-dim hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
