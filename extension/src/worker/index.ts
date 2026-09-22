/**
 * MV3 background service worker. Part A is deliberately minimal: no
 * `GET /commands` polling, no 15-minute alarm — the P07 packet scopes
 * that session/command work to parts B and C ("NO bridge calls" for part
 * A). This still registers a real (not stubbed) module-scope listener, per
 * browser-boundary.md's worker-lifecycle guidance ("register event
 * listeners at module scope; never keep the task queue solely in
 * globals"), so later parts have a real place to add the alarm/command
 * listeners without restructuring this file.
 */
import "../shared/zod-jitless";

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Job Assistant service worker installed (${details.reason}).`);
});
