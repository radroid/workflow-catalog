/**
 * The tone of a message line, shared by the popup and the options page
 * (P07-B revision 3, H1), after the design reference's `.flash` variants
 * (docs/spec/visuals/index.html), which keep amber for "needs a decision":
 *
 * - `ok`: it worked -- "Sent to the runner.", "Paired." (`.flash.ok`).
 * - `info`: progress, or a retry the extension makes on its own --
 *   "Pairing…", "The runner isn't reachable right now — it'll be sent
 *   automatically once it's back." Nothing for the person to do, so a
 *   neutral edge (`.flash.info`).
 * - `act`: the person has to do something -- pair (again), start the
 *   runner, enter a code (plain `.flash`, amber).
 * - `bad`: the capture was refused or couldn't be stored, and nothing kept
 *   it (`.flash.bad`, red).
 *
 * Revision 2 used amber for waiting too, and red for the 401/403 pauses,
 * which only need a re-pair.
 */
export type Tone = "ok" | "info" | "act" | "bad";

export const FLASH_CLASS: Readonly<Record<Tone, string>> = {
  ok: "flash ok",
  info: "flash info",
  act: "flash",
  bad: "flash bad",
};
