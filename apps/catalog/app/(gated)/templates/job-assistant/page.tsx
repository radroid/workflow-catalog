import { Fragment } from "react";
import Link from "next/link";
import { requireSession } from "../../../../lib/auth/require-session";
import { workflowManifest } from "../../../../lib/workflow-manifest";
import { getCachedPackageRelease } from "../../../../lib/release";
import { BROWSER_PERMISSION_DESCRIPTIONS, CONNECTION_LABELS, SOURCE_CATEGORY_LABELS } from "../../../../lib/template-labels";

export const metadata = { title: "job-assistant template · workflow catalog" };

// P09-catalog-site.md part B / mvp-spec.md F2. Session-gated like /install —
// this route lives under app/(gated)/, so it inherits the database-backed
// session check from app/(gated)/layout.tsx's own requireSession() call;
// the explicit call here too matches every other gated page in this app
// (e.g. app/(gated)/install/page.tsx) and is cheap: getActiveSession is
// wrapped in React's cache(), so within one request it only hits the
// database once regardless of how many times it's called.
export default async function TemplatePage() {
  await requireSession();

  const releaseResult = await getCachedPackageRelease(workflowManifest.version);
  const changelogNewestFirst = [...workflowManifest.changelog].reverse();

  return (
    <main className="wrap">
      <p className="eyebrow">Template</p>
      <h1>{workflowManifest.name}</h1>
      <p className="lede">{workflowManifest.description}</p>

      <h2>Download</h2>
      <div className="card pad stack">
        {releaseResult.kind === "found" ? (
          <>
            <p className="tight">
              Version {workflowManifest.version}&nbsp;&middot; Release: published
            </p>
            <p className="tight">Checksum&nbsp;&mdash; SHA-256 of the release tarball itself</p>
            <p className="mono break-all">{releaseResult.release.checksum}</p>
            <div className="row multiline">
              <a className="button primary" href={releaseResult.release.tarballUrl}>
                Download {releaseResult.release.tarballName}
              </a>
              <a className="button ghost" href={releaseResult.release.checksumAssetUrl}>
                {releaseResult.release.tarballName}.sha256
              </a>
            </div>
          </>
        ) : releaseResult.kind === "not_found" ? (
          <>
            <p className="tight">
              Version {workflowManifest.version}&nbsp;&middot; Release: not published yet
            </p>
            <p className="lede tight">
              Checksum and download appear with the first release. Meanwhile, see the{" "}
              <Link href="/install">install guide</Link>.
            </p>
          </>
        ) : (
          <>
            <p className="tight">
              Version {workflowManifest.version}&nbsp;&middot; Release: temporarily unavailable
            </p>
            <p className="lede tight">Checksum and download are temporarily unavailable. Try again shortly.</p>
          </>
        )}
      </div>

      <h2>What it needs</h2>

      <div className="card pad">
        <h3>Sources</h3>
        <p className="lede">
          Every one of these is accounted for during onboarding&nbsp;&mdash; provided, unavailable, or not
          applicable, never silently skipped.
        </p>
        <ul className="plain-list">
          {workflowManifest.requiredSources.map((source) => (
            <li key={source}>{SOURCE_CATEGORY_LABELS[source]}</li>
          ))}
        </ul>
      </div>

      <div className="card pad">
        <h3>Connections</h3>
        <p className="lede">Ways the runner can bring each source in.</p>
        <ul className="plain-list">
          {workflowManifest.connections.map((connection) => (
            <li key={connection}>{CONNECTION_LABELS[connection]}</li>
          ))}
        </ul>
      </div>

      <div className="card pad">
        <h3>Browser permissions</h3>
        <p className="lede">
          Exactly these six, and nothing else&nbsp;&mdash; no host access beyond the extension&apos;s own
          bridge, no <code>tabs</code>, <code>debugger</code>, or remote code.
        </p>
        <dl className="perm-list">
          {workflowManifest.browserPermissions.map((permission) => (
            <Fragment key={permission}>
              <dt>{permission}</dt>
              <dd>{BROWSER_PERMISSION_DESCRIPTIONS[permission]}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <h2>Changelog</h2>
      <div className="card pad stack">
        {changelogNewestFirst.map((entry) => (
          <div key={entry.version}>
            <p className="tight">
              <strong>{entry.version}</strong> <span className="mono">{entry.date}</span>
            </p>
            <ul className="changelog-notes">
              {entry.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </main>
  );
}
