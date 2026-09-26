import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "workflow catalog",
  description: "An invite-only catalog of reusable agent workflow templates.",
};

// Sets data-theme="dark" on <html> before first paint, purely from
// prefers-color-scheme — no next-themes, no stored override, no flash. Must
// run as a blocking (no async/defer) script in <head> so it executes before
// the browser paints <body>.
const THEME_SCRIPT = `(function(){try{if(window.matchMedia("(prefers-color-scheme: dark)").matches){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      // The theme script below sets data-theme on the client before React
      // hydrates, which will never match the server-rendered markup (the
      // server can't know the browser's color-scheme preference). That
      // mismatch is intentional and confined to this one attribute.
      suppressHydrationWarning
    >
      <head>
        <meta name="color-scheme" content="light dark" />
        {/* Fixed literal string, defined above in this file — nothing
            user-supplied or request-derived ever reaches this script. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
