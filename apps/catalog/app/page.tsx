export default function HomePage() {
  return (
    <main className="wrap">
      <p className="eyebrow">workflow-catalog</p>
      <h1>workflow catalog</h1>
      <p className="lede">
        An invite-only catalog of reusable agent workflow templates.
        Execution is never hosted — each person installs a versioned workflow
        package into a local runner on their own machine, with their own
        model access.
      </p>
      <div className="card">
        Sign-in, template pages, and the install guide arrive in later
        packets.
      </div>
    </main>
  );
}
