/**
 * Placeholder only — P07 packet: "A side panel placeholder page is fine;
 * part C fills it." Part C wires the current task, prepared documents,
 * remaining steps, and the Applied/Deferred buttons (F9).
 */
import "../shared/zod-jitless";
import { el, mount } from "../shared/dom";
import { applyColorScheme } from "../shared/theme-init";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("sidepanel/index.html is missing #app");
}

mount(
  app,
  el("main", { className: "panel stack" }, [
    el("div", { className: "eyebrow", text: "Job Assistant" }),
    el("h1", { text: "Coming soon" }),
    el("p", { className: "small", text: "Sessions, tasks, and Applied/Deferred controls arrive in a later version." }),
  ]),
);
