import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

// The inbound proxy key clients present as `Authorization: Bearer <key>` /
// `x-api-key: <key>`. 32 random bytes → 64 hex chars, matching the README's
// `openssl rand -hex 32`.
export function generateProxyKey(): string {
  return randomBytes(32).toString("hex");
}

export function proxyKeyPath(home: string = os.homedir()): string {
  return path.join(home, ".conduit.key");
}
