# Conduit — rebrand + multi-provider gateway design

**Date:** 2026-06-18
**Status:** Approved (design) — executing Phase 1
**Supersedes branding:** `claude-max-proxy` → `claudette` → **`conduit`**

## Summary

Evolve the self-hosted proxy (currently `claudette`) from a personal,
Claude-Max-only proxy into a **distributable, provider-neutral
multi-provider LLM gateway** named **Conduit**. One public URL, one
inbound key (`PROXY_KEY`), many providers behind it. Shipped in four
phases; each phase is its own spec → plan → build → verify.

## Decisions (locked 2026-06-18)

| Decision | Choice |
|---|---|
| Name | **Conduit** |
| Audience | **Distributable self-host template** (anyone clones + stands up their own instance; keys per-operator, never baked in) |
| Providers | Claude Max (OAuth, default) · OpenAI (chat + embeddings) · Google Gemini · Voyage/Cohere (embeddings) · local Ollama |
| Provider keys | **Operator-stored secrets**; clients only ever send `PROXY_KEY` |
| Routing | **Per-provider transport flag** (`edge` \| `tunnel`), default edge-direct; Claude Max + Ollama default to `tunnel` |
| Sequencing | **Phased, in order** |

## Target architecture (north star)

- **Worker = edge gateway + router.** Inbound auth unchanged
  (`PROXY_KEY` bearer / `x-api-key` / CF Access JWT). A **provider
  registry** maps the requested model → `{provider, transport}` by
  **model-name prefix** (`anthropic/…`, `openai/…`, `gemini/…`,
  `voyage/…`, `cohere/…`, `ollama/…`) with a configurable **default
  provider** for bare names (default `anthropic`, so today's
  `claude-*` clients keep working). Each provider is a small **adapter**
  (`chat()`, `embed()`, plus request/response/stream/error translation
  to a canonical OpenAI-compatible shape). The existing
  `worker/src/openai-shim.ts` becomes the Anthropic adapter's
  translation.
- **Transport dispatch per provider.** `edge` → Worker `fetch()`s the
  provider directly with the operator's Worker-secret key. `tunnel` →
  Worker forwards to the Mac agent over the existing CF Tunnel. The
  tunnel exists solely because Anthropic's WAF blocks OAuth refresh from
  datacenter IPs (`README.md:44,187`); paid API keys carry no detection
  risk, so they default to `edge`.
- **Mac agent = residential egress for tunnel-transport providers.**
  Keeps the Claude Max OAuth multi-account pool/rotation exactly as-is;
  `upstream.ts` generalizes from a hardcoded `ANTHROPIC_URL` to a
  per-provider dispatch (Claude Max → OAuth pool; Ollama → local URL).
- **Endpoints (target):** `/v1/chat/completions` (universal),
  `/v1/messages` (Anthropic-native passthrough; non-Anthropic models
  `400` here), `/v1/embeddings` (real; routed by model),
  `/v1/models` (aggregated), `/v1/admin/accounts*` (unchanged).

### Design calls (reversible)
1. **Prefix routing, bare-name default `anthropic`** — zero changes for
   existing Claude clients.
2. **`/v1/chat/completions` is the universal endpoint;** `/v1/messages`
   stays Anthropic-native (avoids translating arbitrary providers *into*
   Anthropic shape).

## Phase plan

- **P1 — Rename / rebrand / redeploy (this spec).** `claudette → conduit`
  across code, config, scripts, and user-facing docs; de-personalize for
  distribution; generalize the Keychain migration chain; blue/green
  redeploy reusing the proven playbook. **No new providers yet** —
  feature behaviour stays Claude-only.
- **P2 — Provider abstraction + OpenAI + real embeddings.** Registry /
  router + adapter interface + transport; wrap the Anthropic path as an
  adapter; add OpenAI (chat edge + embeddings); implement
  `/v1/embeddings` for real.
- **P3 — Gemini + Voyage/Cohere + Ollama.** Add adapters on the stable
  interface; aggregate `/v1/models`.
- **P4 — Onboarding wizard + docs.** `conduit init` interactive setup;
  templated config; provider-neutral quickstart; verify `conduit`
  GitHub/npm names are free before any publish.

---

# Phase 1 — Rename / rebrand / redeploy

## Scope

Rename the project and its deployment identity from `claudette` to
`conduit`, de-personalize the repo so others can self-host, and
blue/green-redeploy the live stack. Behaviour is otherwise unchanged
(still Claude-Max-only). Two parts:

- **Part A — repo changes (reversible).** String/file renames,
  de-personalization, generalized Keychain migration chain, tests, build.
  Done on `feature/CMP-003-conduit-p1-rename-rebrand`, committed, PR'd.
- **Part B — live infra (outward-facing, gated on explicit go-ahead).**
  Blue/green Cloudflare redeploy, live Keychain migration on agent
  restart, launchd relabel, tear-down of old resources.

## Part A — repo changes

### A1. Package + config identity
- `package.json` `name`: `claudette` → `conduit`.
- `agent/package.json` `name`: `@claudette/agent` → `@conduit/agent`.
- `worker/package.json` `name`: `@claudette/worker` → `@conduit/worker`.
- `worker/wrangler.jsonc` `name`: `claudette` → `conduit`.
- `worker/wrangler.jsonc` `vars.TUNNEL_HOSTNAME`: de-personalize the
  committed value `claudette-agent.bobjansen.dev` → placeholder
  `conduit-agent.<your-zone>` (matches the existing placeholder style of
  `ACCESS_TEAM_DOMAIN`). The operator sets their real hostname at deploy
  time; the committed repo carries no personal domain.

### A2. Keychain service rename + generalized migration chain
The operator's live OAuth credentials currently live in the
`claudette-credentials` Keychain service. Renaming the constant to
`conduit-credentials` requires the first-run migration to copy from
`claudette-credentials`, else the renamed agent starts with an empty
pool.

- `agent/src/tokens.ts` `KEYCHAIN_SERVICE`: `claudette-credentials` →
  `conduit-credentials`.
- `agent/src/index.ts` `NEW_SERVICE`: `claudette-credentials` →
  `conduit-credentials`.
- **Generalize `agent/src/migrate.ts`** from `primary + optional
  secondary` to an **ordered list of sources** tried until one is
  non-empty:
  ```ts
  export interface MigrateSource {
    list(): Promise<AccountId[]>;
    read(acctId: AccountId): Promise<OAuthCredential | null>;
  }
  export interface MigrateDeps {
    listNew(): Promise<AccountId[]>;
    writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>;
    newServiceName: string;          // for the log line (no hardcoded brand)
    sources: MigrateSource[];        // tried in order; first non-empty wins
    log?(msg: string): void;
  }
  ```
  Semantics unchanged otherwise: if `listNew()` ≥ 1 → no-op (idempotent);
  else walk `sources` in order, take the first whose `list()` is
  non-empty, copy each credential into the new service. The log line
  references `newServiceName` (no hardcoded `"claudette-credentials"`).
- **`agent/src/index.ts` `migrateLegacyService()`** wires the ordered
  chain (most-recent first):
  1. `claudette-credentials` — the operator's current live creds.
  2. `Claude Code-credentials` — fresh-install / Claude Code CLI source.
  3. `claude-max-proxy-credentials` — oldest historical agent build.
  Add a `CLAUDETTE_OLD_SERVICE = "claudette-credentials"` constant
  alongside the existing `PRIMARY_OLD_SERVICE` /
  `SECONDARY_OLD_SERVICE`.

### A3. user-agent + brand strings
- `agent/src/upstream.ts:56,99` `user-agent`: `claude-max-proxy/0.1` and
  `/0.2` → `conduit/0.1`, `conduit/0.2`.

### A4. Scripts + launchd
- Rename `scripts/dev.claudette.agent.plist` →
  `scripts/dev.conduit.agent.plist`; label `dev.claudette.agent` →
  `dev.conduit.agent`; log paths `claudette.{out,err}.log` →
  `conduit.{out,err}.log`; `projects/claudette` → `projects/conduit`.
- Rename `scripts/dev.claudette.cloudflared.plist` →
  `scripts/dev.conduit.cloudflared.plist`; label
  `dev.claudette.cloudflared` → `dev.conduit.cloudflared`; tunnel arg
  `claudette` → `conduit`; cloudflared log paths.
- `scripts/install-launchd.sh`: `LABEL=dev.claudette.agent` →
  `dev.conduit.agent`; log path + `projects/claudette` sed pattern +
  plist filename reference.
- `scripts/e2e.sh`: key fallback `~/.claude-max-proxy.key` →
  `~/.conduit.key`; `WORKER_URL` example → `conduit.<…>.workers.dev`.

### A5. cloudflared templates
- `cloudflared/config.yml.example`: header comment, `tunnel: claudette`
  → `conduit`, hostname placeholder `claudette-agent.<your-zone>` →
  `conduit-agent.<your-zone>`.
- `cloudflared/README.md`: `tunnel create/route/run claudette` →
  `conduit`; plist filename reference.

### A6. Docs
- `CLAUDE.md` title line only: `# claude-max-proxy — project guidance` →
  `# conduit — project guidance` (rest is the nram memory snippet —
  unchanged).
- `README.md`: full rebrand — title, prose brand mentions, GitHub URL
  `github.com/bbjansen/claudette` → `github.com/bbjansen/conduit`, clone
  dir, key file `~/.claudette.key` → `~/.conduit.key`, plist filenames,
  Keychain service mention `claudette-credentials` →
  `conduit-credentials`. Feature description stays **Claude-only** and
  honest for Phase 1; add a short **Roadmap** note that multi-provider
  support (OpenAI/Gemini/Voyage/Cohere/Ollama + embeddings) is coming.
- `docs/operations/capturing-multi-account-credentials.md`: rebrand
  prose; Keychain service `claudette-credentials` → `conduit-credentials`;
  update the migration-fallback list to: `claudette-credentials` (newly
  primary fallback), `Claude Code-credentials`, `claude-max-proxy-credentials`.

### A7. Leave as-is (deliberate)
- `LICENSE` `Copyright (c) 2026 bbjansen` — legitimate author/copyright
  holder; kept.
- `docs/superpowers/plans/2026-06-18-claudette-completion.md` and
  `docs/superpowers/specs/2026-06-18-keychain-rename-…-design.md` —
  **dated historical records** of the prior rename; not rewritten
  (rewriting would falsify what was done).
- `agent/dist/**` — build artifacts (`.gitignore`d); regenerated by
  `npm run build`, not edited or committed.

### A8. Tests
- `agent/test/migrate.test.ts`: rewrite against the ordered-`sources`
  interface; keep coverage for (a) no-op when target non-empty,
  (b) first source consumed, (c) fallback to a later source when earlier
  sources are empty, (d) no double-copy when an earlier source has
  entries. Add (e) a 3-source chain test asserting the
  `claudette-credentials` → … → `claude-max-proxy-credentials` order.
- All existing agent + worker tests must stay green. `npm run build`
  in `agent/` and `worker/` must pass with no type errors.

## Part B — live infra (gated; reuses the proven blue/green playbook)

Reuses the playbook from the prior rename
(`…/specs/2026-06-18-keychain-rename-…-design.md` §3). Executed only on
explicit operator go-ahead, in this order, blue stays up until green is
verified (≤10 min overlap):

1. **Build + restart agent locally.** `npm run build` (agent); restart
   the launchd agent. First run migrates `claudette-credentials` →
   `conduit-credentials` (one-time Keychain ACL prompt expected). Verify
   `GET 127.0.0.1:8787/v1/admin/accounts` shows all accounts.
2. **New Tunnel `conduit`** via the Cloudflare API; save credentials
   JSON to `~/.cloudflared/<NEW_UUID>.json`.
3. **New DNS CNAME** `conduit-agent.bobjansen.dev` →
   `<NEW_UUID>.cfargotunnel.com` (proxied, TTL 1).
4. **cloudflared config swap** to the new tunnel; boot out the old
   `dev.claudette.cloudflared` launchd job; install
   `dev.conduit.cloudflared`; bootstrap; verify registration.
5. **New CF Access app** for `conduit-agent.bobjansen.dev` + service
   token; capture AUD, team domain, client id/secret.
6. **New Worker `conduit`.** Generate fresh `PROXY_KEY_v3 =
   openssl rand -hex 32` → `~/.conduit.key` (0600); set
   `TUNNEL_HOSTNAME=conduit-agent.bobjansen.dev`; push secrets
   (`PROXY_KEY`, `ACCESS_AUD`, `TUNNEL_ACCESS_CLIENT_ID`,
   `TUNNEL_ACCESS_CLIENT_SECRET`); `wrangler deploy`. Published at
   `conduit.bobjansen.workers.dev`.
7. **Smoke** the new chain (`scripts/e2e.sh`); verify gate + non-stream +
   stream PASS.
8. **Update consumers** to the new URL + key: `~/.claude/settings.json`
   (Claude Code routing) and nram's proxy config (it caches the old
   `PROXY_KEY`).
9. **Tear down blue:** `wrangler delete --name claudette`; delete old DNS
   CNAME, old Tunnel, old Access app/service token; `rm ~/.claudette.key`,
   old cloudflared creds JSON.

## Error handling

| Failure | Behaviour |
|---|---|
| Renamed agent finds no creds in any source | Pool empty; existing "no Max-account credentials" error + exit(1). Operator runs `agent login`. |
| Migration: target (`conduit-credentials`) already populated | No-op (idempotent), even on repeated restarts. |
| Keychain ACL prompt on first write to `conduit-credentials` | Expected one-time prompt; operator accepts. |
| Green Worker tear-down step fails | Green already serving; blue stays; retry. New chain unaffected. |
| New Access app misconfigured | Worker→Tunnel `403`; `wrangler tail` shows it; fix policy. No data loss. |
| `PROXY_KEY` rotation strands a cached consumer (nram, Claude Code) | Updated in step 8 before blue tear-down. |

## Project layout (Part A delta)

```
package.json                              (name)
agent/package.json                        (name)
worker/package.json                       (name)
worker/wrangler.jsonc                      (name; TUNNEL_HOSTNAME placeholder)
agent/src/tokens.ts                        (KEYCHAIN_SERVICE)
agent/src/index.ts                         (NEW_SERVICE; ordered migration chain)
agent/src/migrate.ts                       (ordered sources interface + log)
agent/src/upstream.ts                      (user-agent ×2)
agent/test/migrate.test.ts                 (rewritten for ordered sources)
scripts/dev.conduit.agent.plist            (renamed from dev.claudette.agent.plist)
scripts/dev.conduit.cloudflared.plist      (renamed from dev.claudette.cloudflared.plist)
scripts/install-launchd.sh                 (label, paths, plist ref)
scripts/e2e.sh                             (key path, WORKER_URL)
cloudflared/config.yml.example             (tunnel name, hostname)
cloudflared/README.md                      (tunnel commands, plist ref)
CLAUDE.md                                  (title line)
README.md                                  (full rebrand + Roadmap note)
docs/operations/capturing-multi-account-credentials.md  (service name + chain)
```

No source files deleted. Two plist files renamed (`git mv`).

## Risks & mitigations

1. **Keychain migration strands live creds.** Mitigated by the ordered
   chain placing `claudette-credentials` first and the idempotent
   target-non-empty no-op; verified locally (Part B step 1) before any
   live redeploy.
2. **Blanket find/replace corrupts the historical fallback name.** The
   string `claude-max-proxy-credentials` must remain a migration source;
   edits are targeted, never a global `claude-max-proxy → conduit` sed.
3. **De-personalized `wrangler.jsonc` deployed with the placeholder
   hostname.** Operator sets the real `TUNNEL_HOSTNAME` at deploy (Part B
   step 6); documented in README.
4. **Old URL bookmarked by a consumer.** Only this Mac (Claude Code) +
   nram; both updated in Part B step 8 before tear-down.

## Open questions

None at design time.
