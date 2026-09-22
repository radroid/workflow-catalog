"use client";

import { useEffect, useRef } from "react";

/**
 * The "Refused" flash box shown after a sign-in / accept-invite refusal (see
 * app/admin/page.tsx and app/invite/[token]/page.tsx). Refusals are Server
 * Actions that call next/navigation's redirect() to a `?error=CODE` URL —
 * reached from a `<form action={...}>`, which Next's client router treats as
 * an in-app, client-side transition (no document reload) whenever
 * JavaScript is enabled, the common case. Only a genuine full-page
 * navigation (pasting a `?error=` URL directly, or the no-JS
 * progressive-enhancement fallback) has the browser's own HTML parser
 * around to honor a bare `autoFocus`/`autofocus` attribute — a P09-B
 * must-fix caught that the "Refused" box never reliably got focus on the
 * far more common in-app path. An explicit ref + effect moves focus on
 * mount instead, which fires identically for both a hard load and a
 * client-side one — every caller only renders this element once its
 * error/status state turns truthy (`{error ? <ErrorAlert ... /> : null}`),
 * so that transition is always a fresh mount.
 */
export function ErrorAlert({ id, message }: { id?: string; message: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div id={id} ref={ref} className="flash error" role="alert" tabIndex={-1}>
      <span className="tag">Refused</span>
      {message}
    </div>
  );
}
