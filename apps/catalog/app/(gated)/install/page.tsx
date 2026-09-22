import { requireSession } from "../../../lib/auth/require-session";
import { toggleInstallItemAction } from "../../../lib/actions/install";
import { getDb } from "../../../lib/db";
import { INSTALL_CHECKLIST_ITEMS, listCheckedItems } from "../../../lib/install-status";
import { INSTALL_STEPS } from "../../../lib/install-commands";

export const metadata = { title: "Install · workflow catalog" };

export default async function InstallPage() {
  const session = await requireSession();
  const db = await getDb();
  const checkedItems = await listCheckedItems(db, session.id);

  return (
    <main className="wrap">
      <p className="eyebrow">Guided install</p>
      <h1>Get the runner running</h1>
      <p className="lede">
        Run these on your own machine. Nothing here runs on the catalog&nbsp;— the runner and the
        extension are the only two pieces that ever touch your career data.
      </p>

      <h2>Commands</h2>
      <ol className="step-list">
        {INSTALL_STEPS.map((step) => (
          <li key={step.id}>
            <p className="step-label">{step.label}</p>
            {step.commands ? (
              <pre className="command-block">
                <code>{step.commands.join("\n")}</code>
              </pre>
            ) : null}
            {step.note ? <p className="step-note">{step.note}</p> : null}
          </li>
        ))}
      </ol>

      <h2>Checklist</h2>
      <div className="card pad">
        {INSTALL_CHECKLIST_ITEMS.map((item) => {
          const isChecked = checkedItems.has(item.id);
          return (
            <div className="check-row" key={item.id}>
              <span className="check-label">
                <span className={`check-mark${isChecked ? " done" : ""}`} aria-hidden="true">
                  {isChecked ? "✓" : ""}
                </span>
                {item.label}
              </span>
              <form action={toggleInstallItemAction}>
                <input type="hidden" name="item" value={item.id} />
                <input type="hidden" name="checked" value={isChecked ? "false" : "true"} />
                {/* A visually hidden, item-specific prefix makes each button's
                    accessible name distinct (a screen reader announces e.g.
                    "Node 24 present — Done, pressed" instead of five
                    indistinguishable buttons), while the accessible name
                    still *contains* the visible text verbatim — satisfying
                    WCAG 2.5.3 Label in Name, which a first attempt using
                    aria-label (replacing the text outright, rather than
                    prefixing it) failed: axe's label-content-name-mismatch
                    flagged all five buttons once the visible text no longer
                    appeared anywhere in the accessible name.

                    The visible word itself used to flip between "Mark done"
                    and "Undo" — a P09-B must-fix caught that against the
                    ARIA APG toggle-button pattern: a toggle's accessible
                    name must stay constant across its two states (like a
                    mute button that always reads "Mute", never "Unmute"),
                    with aria-pressed alone carrying which state it's in.
                    "Done" is that constant word here; the pressed/not-pressed
                    state is then shown visually two ways — the check-mark
                    span above, and this button filling solid (see globals.css
                    ".check-row button[aria-pressed='true']") — so a sighted
                    user isn't relying on the (identical) button text alone. */}
                <button type="submit" className="small" aria-pressed={isChecked}>
                  <span className="visually-hidden">{item.label} — </span>
                  Done
                </button>
              </form>
            </div>
          );
        })}
      </div>

      <h2>Privacy</h2>
      <div className="card pad stack">
        <p>Everything personal stays in your local workspace on your own machine.</p>
        <p>Your chosen provider receives only the content selected for each model call.</p>
        <p>
          eve telemetry is off by default in the installer (<code>EVE_TELEMETRY_DISABLED=1</code>,{" "}
          <code>EVE_TRACES_CONTENT=off</code>).
        </p>
        <p>The catalog itself stores only invites, sessions, and these checklist ticks&nbsp;&mdash; never career data.</p>
        <p>Preparation does not run while your machine is off or asleep; a missed run catches up when you&apos;re back.</p>
      </div>
    </main>
  );
}
