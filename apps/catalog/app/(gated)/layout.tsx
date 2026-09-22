import { requireSession } from "../../lib/auth/require-session";
import { signOutAction } from "../../lib/actions/session";
import { GatedNav } from "../../components/gated-nav";

// Layer 2 of the two-layer session check for every route this layout wraps
// (currently /install, /templates/job-assistant, and /learn —
// /learn/[...slug] is a Route Handler, so it does NOT inherit this and
// checks independently, see that route's comment). `requireSession`
// redirects to "/" on any failure: signature invalid, or the database says
// the session is revoked.
export default async function GatedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <>
      <GatedNav displayName={session.displayName} signOutAction={signOutAction} />
      {children}
    </>
  );
}
