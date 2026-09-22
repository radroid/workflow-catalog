import Link from "next/link";
import { getActiveSession } from "../lib/auth/require-session";
import { signOutAction } from "../lib/actions/session";

export default async function HomePage() {
  const session = await getActiveSession();

  return (
    <main className="wrap">
      <p className="eyebrow">Five-person pilot</p>
      <h1>workflow catalog</h1>
      <p className="lede">
        An invite-only catalog of reusable agent workflow templates. Execution is never
        hosted&nbsp;— each person installs a versioned workflow package into a local runner on
        their own machine, with their own model access. The catalog itself stores nothing
        personal: only invites, sessions, and install-checklist ticks.
      </p>

      {session ? (
        <div className="card pad stack">
          <p>
            Signed in as <strong>{session.displayName}</strong>.
          </p>
          <div className="row multiline">
            <Link href="/templates/job-assistant" className="button">
              Template
            </Link>
            <Link href="/install" className="button">
              Install guide
            </Link>
            <Link href="/learn" className="button">
              Learn
            </Link>
            <form action={signOutAction}>
              <button type="submit" className="ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="card pad stack">
          <p>
            Access is by invite only. If someone gave you a link, open it to choose a display
            name and get started.
          </p>
          <div className="row">
            <Link href="/admin" className="button ghost">
              Owner sign-in
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
