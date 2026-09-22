import { httpBasic, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Route auth for eve's /eve/v1 session API (mode A: `eve start` on
// 127.0.0.1:3210). The only client is our own bridge, server-side through
// eve/client, with this per-install secret; the extension never talks to eve.
//
// - httpBasic authenticates as principalType "user" (eve-spike.md), so
//   user-scoped connections stay possible later. `npm run setup` generates the
//   password and writes it to runner/.env.local, which `eve start` loads. eve
//   never compiles route secrets into the build (auth-and-route-protection.md).
// - A missing or short password leaves httpBasic out, so every request falls
//   through and is refused: the walk fails closed.
// - localDev() is last. It authenticates only inside `eve dev` (the eval
//   fixture's dev server) and nothing under `eve start`.
// - Never none(). CORS stays untouched: no browser calls eve directly.
const password = process.env.ROUTE_AUTH_BASIC_PASSWORD;
const MIN_PASSWORD_LENGTH = 32;

export default eveChannel({
  auth: [
    ...(password !== undefined && password.length >= MIN_PASSWORD_LENGTH
      ? [httpBasic({ username: "runner", password })]
      : []),
    localDev(),
  ],
});
