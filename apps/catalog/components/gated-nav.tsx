"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/templates/job-assistant", label: "Template" },
  { href: "/install", label: "Install" },
  { href: "/learn", label: "Learn" },
] as const;

/**
 * The nav every app/(gated)/ page shares. Split out of the layout (a
 * Server Component, since it does the requireSession() check) because
 * knowing which link is "current" needs next/navigation's usePathname(),
 * a Client Component hook — app/(gated)/layout.tsx passes signOutAction
 * straight through as a prop, which Next.js Server Actions support without
 * this needing "use server" itself.
 *
 * P09-B revision round: previously none of the three links ever carried
 * aria-current, so assistive tech had no way to tell which page a visitor
 * was already on.
 */
export function GatedNav({
  displayName,
  signOutAction,
}: {
  displayName: string;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();

  return (
    <nav className="top-nav">
      <div className="row">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname?.startsWith(`${link.href}/`);
          return (
            <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}>
              {link.label}
            </Link>
          );
        })}
      </div>
      <div className="row">
        <span className="who">{displayName}</span>
        <form action={signOutAction}>
          <button type="submit" className="ghost small">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
