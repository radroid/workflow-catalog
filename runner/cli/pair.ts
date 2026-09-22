import { systemClock } from "../lib/clock.ts";
import { loadSettings } from "../lib/settings.ts";
import { PairingCodes } from "../store/pairing.ts";
import { Workspace } from "../store/workspace.ts";
import { fail } from "./args.ts";

/** npm run pair: a new pairing code for the extension's options page (10 minutes, single use). */
const settings = await loadSettings();
if (!settings.workspace) fail("No workspace yet. Run `npm run setup` first.");
const workspace = await Workspace.open(settings.workspace).catch((error: Error) => fail(error.message));
const { code, expiresAt } = await new PairingCodes(workspace, systemClock).issue();
console.log(`Pairing code: ${code}`);
console.log(`Enter it on the extension's options page before ${expiresAt.toLocaleTimeString()} (10 minutes, works once).`);
