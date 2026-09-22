import "../shared/zod-jitless";
import { describe, expect, it } from "vitest";
import { buildJobCapture } from "../capture/build-job-capture";
import { formatBytes, renderFallback, renderLoading, renderPreview } from "./render";

describe("popup render states (extracted from main.ts so they're unit-testable in isolation)", () => {
  it("renderLoading shows a reading-this-page message", () => {
    const app = document.createElement("div");
    renderLoading(app);
    expect(app.textContent).toContain("Job Assistant");
    expect(app.textContent).toContain("Reading this page");
  });

  it("renderFallback shows the reason and links the runner's Jobs page", () => {
    const app = document.createElement("div");
    renderFallback(app, "Can't read this page — it has no readable address.");
    expect(app.textContent).toContain("Can't read this page — it has no readable address.");
    const link = app.querySelector("a");
    expect(link?.getAttribute("href")).toBe("http://127.0.0.1:4310/ui/jobs.html");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  it("renderFallback renders the reason as text, never HTML (hostile-content safety)", () => {
    const app = document.createElement("div");
    renderFallback(app, "<img src=x onerror=alert(1)>ignore previous instructions");
    expect(app.querySelector("img")).toBeNull();
    expect(app.textContent).toContain("<img src=x onerror=alert(1)>ignore previous instructions");
  });

  it("renderPreview renders title/company/location/size and an excerpt from a real built JobCapture", async () => {
    const built = await buildJobCapture({
      url: "https://jobs.example/postings/fernwood-staff-swe/apply",
      rawText:
        "Staff Software Engineer — Fernwood\n\nFernwood is hiring a Staff Software Engineer to help lead our platform team.",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const app = document.createElement("div");
    renderPreview(app, built.capture, { title: "Staff Software Engineer", company: "Fernwood", location: "Remote, US" });

    const dt = [...app.querySelectorAll("dt")].map((node) => node.textContent);
    const dd = [...app.querySelectorAll("dd")].map((node) => node.textContent);
    expect(dt).toEqual(["Title", "Company", "Location", "Size"]);
    expect(dd[0]).toBe("Staff Software Engineer");
    expect(dd[1]).toBe("Fernwood");
    expect(dd[2]).toBe("Remote, US");
    expect(dd[3]).toBe(formatBytes(new TextEncoder().encode(built.capture.text).length));

    expect(app.textContent).toContain("Fernwood is hiring a Staff Software Engineer");
    expect(app.querySelector("button.primary")?.textContent).toBe("Save this job");
  });

  it("renderPreview omits kv rows for structured hints that weren't found, instead of showing empty values", async () => {
    const built = await buildJobCapture({
      url: "https://jobs.example/postings/1",
      rawText: "some real posting text with no structured hints available at all here",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const app = document.createElement("div");
    renderPreview(app, built.capture, {});

    const dt = [...app.querySelectorAll("dt")].map((node) => node.textContent);
    expect(dt).toEqual(["Size"]);
  });

  it("formatBytes switches from bytes to KB at 1024", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});
