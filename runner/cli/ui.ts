import { systemClock } from "../lib/clock.ts";
import { loadSettings } from "../lib/settings.ts";
import { BRIDGE_ORIGIN } from "../server/app.ts";
import { UiLoginLinks } from "../store/ui-login.ts";
import { Workspace } from "../store/workspace.ts";
import { fail } from "./args.ts";

/** npm run ui: a fresh one-time sign-in link for the runner's local UI (10 minutes, works once). */
const settings = await loadSettings();
if (!settings.workspace || !settings.uiToken) fail("Setup has not finished. Run `npm run setup` first.");
const workspace = await Workspace.open(settings.workspace).catch((error: Error) => fail(error.message));
const { url, expiresAt } = await new UiLoginLinks(workspace, systemClock).issue(BRIDGE_ORIGIN);
console.log(`Open this link in your browser while the runner is running (works once, until ${expiresAt.toLocaleTimeString()}):`);
console.log(url);
