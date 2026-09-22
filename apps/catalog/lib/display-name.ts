export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 40;

export type DisplayNameValidation = { ok: true; value: string } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to reject them.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The only human-entered text the catalog ever stores (spec: "No career
 * data, ever"). Trimmed, 1–40 characters, no control characters.
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
  const trimmed = raw.trim();

  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: `Display name must be ${DISPLAY_NAME_MIN_LENGTH}–${DISPLAY_NAME_MAX_LENGTH} characters.` };
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "Display name cannot contain control characters." };
  }

  return { ok: true, value: trimmed };
}
