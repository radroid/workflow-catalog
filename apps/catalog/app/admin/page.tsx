import { cookies, headers } from "next/headers";
import { AuthConfigError, getOwnerSecret, getSessionSecret } from "../../lib/auth-config";
import { OWNER_COOKIE, verifyOwnerCookieValue } from "../../lib/owner-cookie";
import { ADMIN_FLASH_INVITE_COOKIE } from "../../lib/admin-flash";
import { createInviteAction, dismissInviteFlashAction, ownerSignInAction, ownerSignOutAction } from "../../lib/actions/owner";
import { getDb } from "../../lib/db";
import { listInvites, MAX_INVITES } from "../../lib/invites";
import { adminErrorMessage } from "../../lib/error-messages";

export const metadata = { title: "Admin · workflow catalog" };

interface AdminPageProps {
  searchParams: Promise<{ error?: string }>;
}

async function siteOrigin(): Promise<string> {
  const store = await headers();
  const host = store.get("host") ?? "localhost";
  const proto = store.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { error: errorCode } = await searchParams;
  const error = adminErrorMessage(errorCode);

  let configError: string | null = null;
  try {
    getOwnerSecret();
    getSessionSecret();
  } catch (err) {
    configError = err instanceof AuthConfigError ? err.message : "Server configuration error.";
  }

  if (configError) {
    return (
      <main className="wrap">
        <p className="eyebrow">Admin</p>
        <h1>Not configured</h1>
        <div className="flash error">
          <span className="tag">Refused</span>
          {configError}
        </div>
      </main>
    );
  }

  const store = await cookies();
  const isOwner = await verifyOwnerCookieValue(store.get(OWNER_COOKIE)?.value);

  if (!isOwner) {
    return (
      <main className="wrap">
        <p className="eyebrow">Admin</p>
        <h1>Owner sign-in</h1>
        <p className="lede">Enter the owner secret to create and manage invite links.</p>

        {error ? (
          <div id="admin-error" className="flash error" role="alert" tabIndex={-1} autoFocus>
            <span className="tag">Refused</span>
            {error}
          </div>
        ) : null}

        <form action={ownerSignInAction} className="card pad">
          <div className="field">
            <label htmlFor="secret">Owner secret</label>
            <input
              type="password"
              id="secret"
              name="secret"
              autoComplete="off"
              required
              aria-invalid={errorCode === "wrong_secret" ? "true" : undefined}
              aria-describedby={error ? "admin-error" : undefined}
            />
          </div>
          <button type="submit" className="primary">
            Sign in
          </button>
        </form>
      </main>
    );
  }

  const db = await getDb();
  const invites = await listInvites(db);
  const flashToken = store.get(ADMIN_FLASH_INVITE_COOKIE)?.value ?? null;
  const origin = await siteOrigin();

  return (
    <main className="wrap wide">
      <div className="row between">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Invites</h1>
        </div>
        <form action={ownerSignOutAction}>
          <button type="submit" className="ghost small">
            Sign out
          </button>
        </form>
      </div>

      {error ? (
        <div className="flash error" role="alert" tabIndex={-1} autoFocus>
          <span className="tag">Refused</span>
          {error}
        </div>
      ) : null}

      {flashToken ? (
        <div className="flash">
          <span className="tag">New invite&nbsp;&mdash; shown once</span>
          <p className="mono break-all">
            {origin}/invite/{flashToken}
          </p>
          <form action={dismissInviteFlashAction}>
            <button type="submit" className="ghost small">
              Dismiss
            </button>
          </form>
        </div>
      ) : null}

      <div className="card pad row between">
        <p className="tight">
          {invites.length} of {MAX_INVITES} invites created.
        </p>
        <form action={createInviteAction}>
          <button type="submit" className="primary" disabled={invites.length >= MAX_INVITES}>
            Create invite
          </button>
        </form>
      </div>

      <h2>All invites</h2>
      {invites.length === 0 ? (
        <p className="lede">No invites yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite, index) => (
              <tr key={invite.id}>
                <td className="mono">{index + 1}</td>
                <td className="mono">{invite.createdAt}</td>
                <td>
                  {invite.usedAt ? <span className="pill ok">used</span> : <span className="pill">unused</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
