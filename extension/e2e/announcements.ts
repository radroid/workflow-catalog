/**
 * P07-B revision 4, K1: records, in the page itself, what a screen reader
 * would announce from the page's DOM changes. It follows the live-region
 * rules this extension relies on, which are also Chrome's defaults:
 * - an alert (`role="alert"`) is announced when it is inserted with text;
 * - any other live region (`role="status"` or `"log"`, or `aria-live`
 *   `polite` or `assertive`) is announced when content is added to it while
 *   it is on the page. It is not announced when it arrives with its content
 *   already in it, or when content is only removed (the default
 *   `aria-relevant`, "additions text");
 * - `aria-live="off"`, and anything outside a live region, is never
 *   announced.
 *
 * Each mutation record is judged on its own, as the round-4 UI critic's
 * logger does: text added to a region counts even if the same region is
 * moved later in the same batch (the Pairing line is re-appended into
 * every rebuilt card, revision 1's B7). A region's text is read when the
 * batch is handed over, and each region is counted at most once a batch.
 *
 * All three functions are self-contained, with no imports and nothing from
 * module scope. An e2e spec passes them to `page.evaluate` or
 * `page.addInitScript`; a unit test calls them directly on happy-dom's
 * window.
 */
export function installAnnouncementRecorder(): void {
  const host = window as unknown as { __announcements?: string[]; __announcementObserver?: MutationObserver };
  if (host.__announcementObserver) return;
  const announcements: string[] = [];
  const LIVE_SELECTOR = '[role="status"], [role="alert"], [role="log"], [aria-live]';
  const isLive = (element: Element): boolean => {
    const live = element.getAttribute("aria-live");
    if (live !== null) return live !== "off";
    return element.matches('[role="status"], [role="alert"], [role="log"]');
  };
  const liveRegionOf = (node: Node): Element | null => {
    for (let element: Element | null = node instanceof Element ? node : node.parentElement; element !== null; element = element.parentElement) {
      if (isLive(element)) return element;
    }
    return null;
  };
  const textOf = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const observer = new MutationObserver((records) => {
    const counted = new Set<Element>();
    const announce = (region: Element): void => {
      if (counted.has(region) || !region.isConnected || textOf(region) === "") return;
      counted.add(region);
      announcements.push(textOf(region));
    };
    for (const record of records) {
      // Live regions this record inserted: an alert says its text, any
      // other region says nothing.
      const inserted = new Set<Element>();
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        for (const region of [node, ...Array.from(node.querySelectorAll(LIVE_SELECTOR))]) {
          if (!isLive(region)) continue;
          inserted.add(region);
          if (region.getAttribute("role") === "alert") announce(region);
        }
      }
      // Content added inside a region that was already there.
      const region = liveRegionOf(record.target);
      if (region === null || inserted.has(region)) continue;
      const added = record.type === "characterData" || Array.from(record.addedNodes).some((node) => textOf(node) !== "");
      if (added) announce(region);
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  host.__announcements = announcements;
  host.__announcementObserver = observer;
}

/** Returns what was announced since the last call, and forgets it. */
export function takeAnnouncements(): string[] {
  const host = window as unknown as { __announcements?: string[] };
  const recorded = host.__announcements ?? [];
  return recorded.splice(0, recorded.length);
}

/** Stops recording (unit tests share one window between tests). */
export function stopAnnouncementRecorder(): void {
  const host = window as unknown as { __announcements?: string[]; __announcementObserver?: MutationObserver };
  host.__announcementObserver?.disconnect();
  delete host.__announcementObserver;
  delete host.__announcements;
}
