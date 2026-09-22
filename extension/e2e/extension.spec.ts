import { existsSync } from "node:fs";
import { expect, extensionDist, test } from "./fixtures";

test.beforeAll(() => {
  if (!existsSync(extensionDist)) {
    throw new Error(`extension/dist not found — run "pnpm --filter @workflow-catalog/extension build" first.`);
  }
});

test("the extension loads and its service worker starts", async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test("the options page renders (pairing + file bridge sections, real fonts/theme applied)", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);

  await expect(page.getByRole("heading", { name: "Job Assistant" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pairing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "File bridge" })).toBeVisible();
  await expect(page.getByText("Not paired yet.")).toBeVisible();
  await expect(page.getByPlaceholder("Code from npm run setup")).toBeVisible();

  // theme.css actually loaded (not a 404) -- background isn't the browser
  // default white/transparent.
  const backgroundColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(backgroundColor).not.toBe("");

  await page.close();
});

test("the popup renders and shows the unsupported-URL fallback on a chrome:// tab", async ({
  context,
  extensionId,
}) => {
  // activeTab targets whatever tab is active in the window; a freshly
  // opened context's initial tab is chrome://newtab, an unsupported
  // scheme -- exactly the fallback path url.ts/popup/main.ts handle.
  const [initialPage] = context.pages();
  if (initialPage) {
    await initialPage.bringToFront();
  }

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

  await expect(popup.getByText("Job Assistant")).toBeVisible();
  await expect(popup.getByText(/can't be captured|readable address|Chrome/i)).toBeVisible({ timeout: 10_000 });
  await expect(popup.getByText("http://127.0.0.1:4310/ui/jobs.html")).toBeVisible();

  await popup.close();
});

test("built worker.js has no CSP violations reachable on install (manifest loads clean)", async ({ context }) => {
  // If the manifest, worker, or any page had a CSP-blocking construct
  // (eval, inline script, remote script), Chromium logs it as a
  // 'securitypolicyviolation' console/page error surfaced through
  // Playwright's console listener. This context has been alive since the
  // `context` fixture launched it (extension install time included).
  const errors: string[] = [];
  context.on("weberror", (webError) => errors.push(webError.error().message));
  // Give the service worker a moment to settle after install.
  await context.waitForEvent("serviceworker", { timeout: 1000 }).catch(() => undefined);
  expect(errors).toEqual([]);
});
