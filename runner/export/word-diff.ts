/**
 * A word-level diff (P05): how a statement's wording differs from the claim
 * text it cites. A plain LCS over words, compared case- and
 * punctuation-insensitively, so "Led the team," and "led the team" read as
 * the same words; the shown text keeps each side's own spelling. Statements
 * and claims are short (a statement is capped at 400 characters), so the
 * table stays small; a cap keeps a pathological input from hanging.
 */

export type WordOp = { readonly kind: "same" | "added" | "removed"; readonly text: string };

const CELL_CAP = 250_000;

function split(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function comparable(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}%$€£]+|[^\p{L}\p{N}%]+$/gu, "");
}

function merge(ops: WordOp[]): WordOp[] {
  const out: WordOp[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (last && last.kind === op.kind) out[out.length - 1] = { kind: op.kind, text: `${last.text} ${op.text}` };
    else out.push(op);
  }
  return out;
}

/** The ops that turn `from` into `to`, runs of one kind merged. Undefined when the texts are too long to compare. */
export function diffWords(from: string, to: string): WordOp[] | undefined {
  const a = split(from);
  const b = split(to);
  if (a.length * b.length > CELL_CAP) return undefined;
  const ka = a.map(comparable);
  const kb = b.map(comparable);
  const table: Uint16Array[] = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = ka[i] === kb[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: WordOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      ops.push({ kind: "same", text: b[j]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) ops.push({ kind: "added", text: b[j++]! });
  return merge(ops);
}

/** Whether two texts say the same words, ignoring case and punctuation. */
export function sameWords(a: string, b: string): boolean {
  const left = split(a).map(comparable).filter(Boolean);
  const right = split(b).map(comparable).filter(Boolean);
  return left.length === right.length && left.every((word, index) => word === right[index]);
}
