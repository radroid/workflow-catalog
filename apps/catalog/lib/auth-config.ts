/**
 * Thrown by `getOwnerSecret`/`getSessionSecret` when the corresponding env
 * var is unset. Every call site catches this specifically and fails closed
 * with a clear, user-facing message — never a silent fallback.
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export function getOwnerSecret(): string {
  const secret = process.env.OWNER_SECRET;
  if (!secret) {
    throw new AuthConfigError("OWNER_SECRET is not configured. Refusing to sign in as the owner.");
  }
  return secret;
}

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new AuthConfigError("SESSION_SECRET is not configured. Refusing to create or verify sessions.");
  }
  return secret;
}
