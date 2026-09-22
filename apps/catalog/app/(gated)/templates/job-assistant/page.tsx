import { requireSession } from "../../../../lib/auth/require-session";
import { workflowManifest } from "../../../../lib/workflow-manifest";
import { fetchPackageRelease } from "../../../../lib/release";
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

  const releaseResult = await fetchPackageRelease(workflowManifest.version);
  const changelogNewestFirst = [...workflowManifest.changelog].reverse();

  return (
    <main className="wrap">
      <p className="eyebrow">Template</p>
      <h1>{workflowManifest.name}</h1>
      <p className="lede">{workflowManifest.description}</p>

      <h2>Version</h2>
      <p className="tight">
        <span className="pill">{workflowManifest.version}</span>
      </p>

      <h2>Download</h2>
      <div className="card pad stack">
        {releaseResult.kind === "found" ? (
          <>
            <p className="tight">Checksum &mdash; SHA-256 of the release tarball itself</p>
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
          <p className="lede tight">Checksum and download appear with the first release.</p>
        ) : (
          <p className="lede tight">Checksum and download are temporarily unavailable. Try again shortly.</p>
        )}
      </div>

      <h2>What it needs</h2>

      <h3>Sources</h3>
      <p className="lede tight">Every one of these is accounted for during onboarding &mdash; provided, unavailable, or not applicable, never silently skipped.</p>
      <div className="row multiline">
        {workflowManifest.requiredSources.map((source) => (
          <span className="pill" key={source}>
            {SOURCE_CATEGORY_LABELS[source]}
          </span>
        ))}
      </div>

      <h3>Connections</h3>
      <div className="row multiline">
        {workflowManifest.connections.map((connection) => (
          <span className="pill" key={connection}>
            {CONNECTION_LABELS[connection]}
          </span>
        ))}
      </div>

      <h3>Browser permissions</h3>
      <p className="lede tight">Exactly these six, and nothing else &mdash; no host access beyond the extension&apos;s own bridge, no <code>tabs</code>, <code>debugger</code>, or remote code.</p>
      <ol className="step-list">
        {workflowManifest.browserPermissions.map((permission) => (
          <li key={permission}>
            <p className="step-label mono">{permission}</p>
            <p className="step-note">{BROWSER_PERMISSION_DESCRIPTIONS[permission]}</p>
          </li>
        ))}
      </ol>

      <h2>Changelog</h2>
      <div className="card pad stack">
        {changelogNewestFirst.map((entry) => (
          <div key={entry.version}>
            <p className="tight">
              <strong>{entry.version}</strong> <span className="mono">{entry.date}</span>
            </p>
            <ul>
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
