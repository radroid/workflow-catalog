/**
 * A small renderer for the job-assistant package's `*.md.hbs` templates
 * (P05). The templates use a fixed subset of Handlebars, so this renders
 * exactly that subset, with no dependency and no code in the template:
 *
 *   {{path}}              a value (`person.name`, `this.text`, `this`)
 *   {{#if path}}…{{/if}}  a section shown when the value is truthy (a
 *                         non-empty array counts, an empty one doesn't)
 *   {{#each path}}…{{/each}}  once per item; inside, `this` is the item
 *   {{!-- … --}}, {{! … }}   a comment
 *
 * As in Handlebars, a block tag or comment alone on its line takes the whole
 * line with it, so a template reads as it renders. Values are passed
 * through `escape`, which the caller chooses: the Markdown exporter escapes
 * Markdown, so no statement can add a link, an image or a heading.
 * Anything else in `{{ }}` is an error, never silently dropped.
 */

export type Escape = (value: string) => string;

type Node =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "value"; readonly path: string }
  | { readonly type: "if"; readonly path: string; readonly children: readonly Node[] }
  | { readonly type: "each"; readonly path: string; readonly children: readonly Node[] };

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

const TAG = /\{\{(!--[\s\S]*?--|![\s\S]*?|[#/]?[^{}]*?)\}\}/g;

/** Removes the line around a block tag or comment that stands alone on it (Handlebars' "standalone" rule). */
function dropStandaloneLines(source: string): string {
  return source.replace(/^[ \t]*(\{\{(?:!--[\s\S]*?--|![^}]*|[#/][^}]*)\}\})[ \t]*(?:\r?\n|$)/gm, "$1");
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ readonly type: "if" | "each"; readonly path: string; readonly children: Node[] }> = [];
  const current = () => stack.at(-1)?.children ?? root;
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    if (match.index > last) current().push({ type: "text", text: source.slice(last, match.index) });
    last = match.index + match[0].length;
    const inner = match[1]!.trim();
    if (inner.startsWith("!")) continue;
    if (inner.startsWith("#")) {
      const [helper, path, ...rest] = inner.slice(1).trim().split(/\s+/);
      if ((helper !== "if" && helper !== "each") || !path || rest.length > 0) throw new TemplateError(`Unsupported block: {{${inner}}}`);
      stack.push({ type: helper, path, children: [] });
      continue;
    }
    if (inner.startsWith("/")) {
      const helper = inner.slice(1).trim();
      const open = stack.pop();
      if (!open || open.type !== helper) throw new TemplateError(`Unbalanced block: {{${inner}}}`);
      current().push({ type: open.type, path: open.path, children: open.children });
      continue;
    }
    if (!/^(?:this|[A-Za-z_][\w]*)(?:\.[A-Za-z_][\w]*)*$/.test(inner)) throw new TemplateError(`Unsupported expression: {{${inner}}}`);
    current().push({ type: "value", path: inner });
  }
  if (stack.length > 0) throw new TemplateError(`Unclosed block: {{#${stack.at(-1)!.type} ${stack.at(-1)!.path}}}`);
  if (last < source.length) root.push({ type: "text", text: source.slice(last) });
  return root;
}

/** `this…` reads the current item; any other path reads the current item first, then the top-level context. */
function lookup(path: string, scope: unknown, root: unknown): unknown {
  const parts = path.split(".");
  const field = (target: unknown, name: string): unknown => (target !== null && typeof target === "object" ? (target as Record<string, unknown>)[name] : undefined);
  let value: unknown = parts[0] === "this" ? scope : (field(scope, parts[0]!) ?? field(root, parts[0]!));
  for (const part of parts.slice(1)) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function renderNodes(nodes: readonly Node[], scope: unknown, root: unknown, escape: Escape): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.text;
    else if (node.type === "value") {
      const value = lookup(node.path, scope, root);
      if (value !== undefined && value !== null) out += escape(String(value));
    } else if (node.type === "if") {
      if (truthy(lookup(node.path, scope, root))) out += renderNodes(node.children, scope, root, escape);
    } else {
      const list = lookup(node.path, scope, root);
      if (Array.isArray(list)) for (const item of list) out += renderNodes(node.children, item, root, escape);
    }
  }
  return out;
}

/** Renders `source` with `context`, escaping every value with `escape`. Throws TemplateError on anything outside the subset. */
export function renderTemplate(source: string, context: Record<string, unknown>, escape: Escape): string {
  return renderNodes(parse(dropStandaloneLines(source)), context, context, escape);
}
