import { requireSession } from "../../../lib/auth/require-session";
import { buildLearnIndex } from "../../../lib/learn";

export const metadata = { title: "Learn · workflow catalog" };

export default async function LearnIndexPage() {
  await requireSession();
  const { lessons, reference } = buildLearnIndex();

  return (
    <main className="wrap">
      <p className="eyebrow">Learn</p>
      <h1>Course</h1>
      <p className="lede">Short lessons and printable references on running and reviewing this workflow.</p>

      <h2>Lessons</h2>
      {lessons.length === 0 ? (
        <p className="lede">No lessons yet.</p>
      ) : (
        <ul className="doc-list">
          {lessons.map((doc) => (
            <li key={doc.key}>
              <a href={`/learn/${doc.key}`}>{doc.title}</a>
            </li>
          ))}
        </ul>
      )}

      <h2>Reference</h2>
      {reference.length === 0 ? (
        <p className="lede">No reference pages yet.</p>
      ) : (
        <ul className="doc-list">
          {reference.map((doc) => (
            <li key={doc.key}>
              <a href={`/learn/${doc.key}`}>{doc.title}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
