export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 40;

export type DisplayNameValidation = { ok: true; value: string } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to reject them.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// Unicode category Cf ("Format") — invisible characters that change how
// surrounding text is interpreted rather than adding visible content. This
// already covers every bidi control (RLO/LRO/RLE/LRE/PDF U+202A-U+202E,
// RLI/LRI/FSI/PDI U+2066-U+2069, RLM/LRM U+200E-U+200F) plus others like
// zero-width joiner/non-joiner. Left unchecked, a display name could use
// these to visually reorder or disguise itself — e.g. an RLO could make
// "Ada" render right-to-left, or spoof a different name than what's stored.
const FORMAT_OR_BIDI_CHARACTERS = /\p{Cf}/u;

/**
 * The only human-entered text the catalog ever stores (spec: "No career
 * data, ever"). Trimmed, 1–40 characters, no control, format, or bidi
 * characters.
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
  const trimmed = raw.trim();

  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: `Display name must be ${DISPLAY_NAME_MIN_LENGTH}–${DISPLAY_NAME_MAX_LENGTH} characters.` };
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "Display name cannot contain control characters." };
  }

  if (FORMAT_OR_BIDI_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "Display name cannot contain invisible formatting or bidi control characters." };
  }

  return { ok: true, value: trimmed };
}
