import Link from "next/link";
import { requireSession } from "../../lib/auth/require-session";
import { signOutAction } from "../../lib/actions/session";

// Layer 2 of the two-layer session check for every route this layout wraps
// (currently /install and /learn — /learn/[...slug] is a Route Handler, so
// it does NOT inherit this and checks independently, see that route's
// comment). `requireSession` redirects to "/" on any failure: signature
// invalid, or the database says the session is revoked.
export default async function GatedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <>
      <nav className="top-nav">
        <div className="row">
          <Link href="/templates/job-assistant">Template</Link>
          <Link href="/install">Install</Link>
          <Link href="/learn">Learn</Link>
        </div>
        <div className="row">
          <span className="who">{session.displayName}</span>
          <form action={signOutAction}>
            <button type="submit" className="ghost small">
              Sign out
            </button>
          </form>
        </div>
      </nav>
      {children}
    </>
  );
}
