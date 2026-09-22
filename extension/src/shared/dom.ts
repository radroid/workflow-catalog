/**
 * Small `textContent`-only DOM builder. The P07 packet is explicit that
 * hostile content is data: "the popup renders extracted text with
 * `textContent`, never `innerHTML`." Nothing in this module (or anywhere
 * else in `extension/src`) sets `.innerHTML` — every string that reaches
 * the page, including anything pulled from a captured posting, goes
 * through `el()`'s `text` option or `setText()`, both of which assign
 * `.textContent`.
 */

type ElOptions = {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function setText(node: Element, text: string): void {
  node.textContent = text;
}

export function clearChildren(node: Element): void {
  node.replaceChildren();
}

export function mount(root: Element, ...children: Array<Node | string>): void {
  clearChildren(root);
  for (const child of children) {
    root.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}
