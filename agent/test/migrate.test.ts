import { describe, it, expect } from "vitest";
import { runMigrationOnce, type MigrateSource } from "../src/migrate.js";
import type { OAuthCredential } from "../src/types.js";

function cred(token: string, exp = 1): OAuthCredential {
  return { accessToken: token, refreshToken: "rt", expiresAt: exp, scopes: [] };
}

// Build a MigrateSource backed by a Map; tracks whether list() was consulted.
function source(entries: Map<string, OAuthCredential | null>): MigrateSource & { listed: () => boolean } {
  let consulted = false;
  return {
    listed: () => consulted,
    list: async () => { consulted = true; return [...entries.keys()]; },
    read: async (id) => entries.get(id) ?? null,
  };
}

describe("runMigrationOnce", () => {
  it("copies every entry of the first source when the new service is empty", async () => {
    const s = source(new Map([["a@x", cred("tA")], ["b@y", cred("tB")]]));
    const written: Array<{ acctId: string; cred: OAuthCredential }> = [];
    const out = await runMigrationOnce({
      listNew: async () => [],
      writeNew: async (id, c) => { written.push({ acctId: id, cred: c }); },
      newServiceName: "conduit-credentials",
      sources: [s],
    });
    expect(out).toEqual({ migrated: 2, skipped: [] });
    expect(written.map(w => w.acctId).sort()).toEqual(["a@x", "b@y"]);
  });

  it("is a no-op when the new service already has at least one entry", async () => {
    const s = source(new Map([["a@x", cred("tA")]]));
    const out = await runMigrationOnce({
      listNew: async () => ["existing@z"],
      writeNew: async () => { throw new Error("should not be called"); },
      newServiceName: "conduit-credentials",
      sources: [s],
    });
    expect(out).toEqual({ migrated: 0, skipped: [] });
    // The new service is already populated → sources are never consulted.
    expect(s.listed()).toBe(false);
  });

  it("skips entries whose read returns null (malformed source)", async () => {
    const s = source(new Map<string, OAuthCredential | null>([
      ["a@x", cred("tA")],
      ["b@y", null],
      ["c@z", cred("tC")],
    ]));
    const written: string[] = [];
    const logs: string[] = [];
    const out = await runMigrationOnce({
      listNew: async () => [],
      writeNew: async (id) => { written.push(id); },
      newServiceName: "conduit-credentials",
      sources: [s],
      log: (m) => { logs.push(m); },
    });
    expect(out.migrated).toBe(2);
    expect(out.skipped).toEqual(["b@y"]);
    expect(written.sort()).toEqual(["a@x", "c@z"]);
    expect(logs.some(l => /migrated 2 credentials into "conduit-credentials"/.test(l))).toBe(true);
  });
});

describe("runMigrationOnce — ordered source chain", () => {
  it("falls through to the first non-empty source", async () => {
    const empty = source(new Map());
    const populated = source(new Map([["x@s", cred("tX")], ["y@s", cred("tY")]]));
    const written: string[] = [];
    const out = await runMigrationOnce({
      listNew: async () => [],
      writeNew: async (id) => { written.push(id); },
      newServiceName: "conduit-credentials",
      sources: [empty, populated],
    });
    expect(out).toEqual({ migrated: 2, skipped: [] });
    expect(written.sort()).toEqual(["x@s", "y@s"]);
    expect(empty.listed()).toBe(true);
  });

  it("does NOT consult later sources once an earlier one has entries", async () => {
    const first = source(new Map([["p@x", cred("tP")]]));
    const later = source(new Map([["q@y", cred("tQ")]]));
    const out = await runMigrationOnce({
      listNew: async () => [],
      writeNew: async () => {},
      newServiceName: "conduit-credentials",
      sources: [first, later],
    });
    expect(out.migrated).toBe(1);
    expect(later.listed()).toBe(false);
  });

  it("walks a 3-source chain (claudette → Claude Code → claude-max-proxy) in order", async () => {
    const claudette = source(new Map());                       // operator already migrated away
    const claudeCode = source(new Map());                      // CLI store empty too
    const maxProxy = source(new Map([["legacy@old", cred("tL")]]));
    const written: string[] = [];
    const out = await runMigrationOnce({
      listNew: async () => [],
      writeNew: async (id) => { written.push(id); },
      newServiceName: "conduit-credentials",
      sources: [claudette, claudeCode, maxProxy],
    });
    expect(out).toEqual({ migrated: 1, skipped: [] });
    expect(written).toEqual(["legacy@old"]);
    // Order respected: every earlier source consulted before the winner.
    expect(claudette.listed()).toBe(true);
    expect(claudeCode.listed()).toBe(true);
    expect(maxProxy.listed()).toBe(true);
  });
});
