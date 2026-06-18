import type { OAuthCredential, AccountId } from "./types.js";

export interface MigrateSource {
  list(): Promise<AccountId[]>;
  read(acctId: AccountId): Promise<OAuthCredential | null>;
}

export interface MigrateDeps {
  listNew(): Promise<AccountId[]>;
  writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>;
  // Name of the destination Keychain service, used only for the log line so
  // the migrator carries no hardcoded brand.
  newServiceName: string;
  // Historical credential sources, tried in order. The first whose `list()`
  // returns a non-empty set is migrated into the new service; the rest are
  // fallbacks, not extenders.
  sources: MigrateSource[];
  log?(msg: string): void;
}

export async function runMigrationOnce(deps: MigrateDeps): Promise<{ migrated: number; skipped: string[] }> {
  const log = deps.log ?? (() => {});
  const existing = await deps.listNew();
  if (existing.length > 0) {
    return { migrated: 0, skipped: [] };
  }

  let oldIds: AccountId[] = [];
  let read: MigrateSource["read"] | null = null;
  for (const source of deps.sources) {
    const ids = await source.list();
    if (ids.length > 0) {
      oldIds = ids;
      read = source.read;
      break;
    }
  }
  if (!read) {
    return { migrated: 0, skipped: [] };
  }

  let migrated = 0;
  const skipped: string[] = [];
  for (const acctId of oldIds) {
    let cred: OAuthCredential | null = null;
    try { cred = await read(acctId); }
    catch { cred = null; }
    if (!cred) { skipped.push(acctId); continue; }
    await deps.writeNew(acctId, cred);
    migrated++;
  }
  log(`[agent] migrated ${migrated} credentials into "${deps.newServiceName}"` +
    (skipped.length > 0 ? `; skipped ${skipped.join(", ")}` : ""));
  return { migrated, skipped };
}
