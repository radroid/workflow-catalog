import { acceptInviteAction } from "../../../lib/actions/invite";
import { getDb } from "../../../lib/db";
import { checkInviteToken } from "../../../lib/invites";
import { DISPLAY_NAME_MAX_LENGTH } from "../../../lib/display-name";
import { inviteErrorMessage } from "../../../lib/error-messages";

export const metadata = { title: "Accept invite · workflow catalog" };

interface InvitePageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function InvitePage({ params, searchParams }: InvitePageProps) {
  const { token } = await params;
  const { error: errorCode } = await searchParams;
  const error = inviteErrorMessage(errorCode);

  const db = await getDb();
  const status = await checkInviteToken(db, token);

  return (
    <main className="wrap">
      <p className="eyebrow">Invite</p>
      <h1>Join the pilot</h1>

      {status === "invalid" ? (
        <div className="flash error" role="alert" tabIndex={-1} autoFocus>
          <span className="tag">Refused</span>
          This invite link is invalid or has already been used. Ask the owner for a new one.
        </div>
      ) : (
        <>
          <p className="lede">Choose a display name to sign in. It is the only thing the catalog stores about you.</p>

          {error ? (
            <div id="invite-error" className="flash error" role="alert" tabIndex={-1} autoFocus>
              <span className="tag">Refused</span>
              {error}
            </div>
          ) : null}

          <form action={acceptInviteAction} className="card pad">
            <input type="hidden" name="token" value={token} />
            <div className="field">
              <label htmlFor="displayName">Display name</label>
              <input
                type="text"
                id="displayName"
                name="displayName"
                autoComplete="off"
                required
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                aria-invalid={errorCode === "invalid_display_name" ? "true" : undefined}
                aria-describedby={error ? "invite-error" : undefined}
              />
              <p className="field-note">1&ndash;{DISPLAY_NAME_MAX_LENGTH} characters.</p>
            </div>
            <button type="submit" className="primary">
              Continue
            </button>
          </form>
        </>
      )}
    </main>
  );
}
