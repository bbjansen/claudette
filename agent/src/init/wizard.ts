// Interactive onboarding runner for `conduit` (agent init). Automates the safe,
// mechanical steps (key generation, Worker secrets, wrangler.jsonc placeholders,
// deploy) and guides the browser-auth steps (tunnel login, Access, per-account
// OAuth). Pure logic lives in ./prereqs, ./providers, ./keyfile, ./plan; this
// file is the thin I/O shell. `--dry-run` prints the full plan without touching
// anything, so it's safe to preview.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

import { checkPrereqs, prereqsSatisfied, type CommandRunner } from "./prereqs.js";
import { CONFIGURABLE_PROVIDERS, secretPlan, parseSelection } from "./providers.js";
import { generateProxyKey, proxyKeyPath } from "./keyfile.js";
import { tunnelCommands, buildSetupSummary, usageSnippet, manualChecklist, type WizardState } from "./plan.js";

const WORKER_NAME = "conduit";

function repoRoot(): string {
  // agent/dist/init/wizard.js → repo root is three levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

const capture: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (d) => { out += d.toString(); });
      p.on("error", () => resolve({ ok: false, stdout: "" }));
      p.on("close", (code) => resolve({ ok: code === 0, stdout: out }));
    } catch { resolve({ ok: false, stdout: "" }); }
  });

function runInherit(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd });
    p.on("error", () => resolve(1));
    p.on("close", (code) => resolve(code ?? 1));
  });
}

function runWithInput(cmd: string, args: string[], input: string, opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "inherit", "inherit"], cwd: opts.cwd });
    p.on("error", () => resolve(1));
    p.stdin?.write(input);
    p.stdin?.end();
    p.on("close", (code) => resolve(code ?? 1));
  });
}

async function confirm(rl: readline.Interface, q: string): Promise<boolean> {
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

function writeWranglerPlaceholders(file: string, host: string, team: string): void {
  if (!fs.existsSync(file)) { console.log(`  (skipped: ${file} not found)`); return; }
  let txt = fs.readFileSync(file, "utf-8");
  let changed = false;
  if (host && txt.includes("conduit-agent.<your-zone>")) { txt = txt.replace("conduit-agent.<your-zone>", host); changed = true; }
  if (team && txt.includes("<your-team>.cloudflareaccess.com")) { txt = txt.replace("<your-team>.cloudflareaccess.com", team); changed = true; }
  if (changed) { fs.writeFileSync(file, txt); console.log(`  Updated ${file}`); }
  else console.log(`  (${file} already customized — leaving as-is)`);
}

function printPrereqs(results: Awaited<ReturnType<typeof checkPrereqs>>): void {
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    const tail = r.ok ? "" : `  → ${r.hint}`;
    console.log(`  ${mark} ${r.name.padEnd(12)} ${r.detail}${tail}`);
  }
}

function dryRun(): void {
  const allIds = CONFIGURABLE_PROVIDERS.map((p) => p.id);
  const state: WizardState = {
    workerName: WORKER_NAME,
    proxyKeyPath: proxyKeyPath(),
    proxyKeySaved: false,
    selectedProviderIds: allIds,
    secretsSet: [],
    deployed: false,
  };

  console.log("\n[dry run] No files written, no commands executed.\n");
  console.log("Proxy key:");
  console.log(`  would generate 64 hex chars → ${state.proxyKeyPath} (mode 0600)`);

  console.log("\nProviders you can enable (Anthropic/Claude Max is always on):");
  for (const p of CONFIGURABLE_PROVIDERS) console.log(`  ${p.id.padEnd(8)} ${p.label}  (${p.note})`);

  console.log("\nWorker secrets that would be set for the cloud providers:");
  console.log(`  PROXY_KEY  (inbound auth)`);
  for (const s of secretPlan(allIds)) console.log(`  ${s.env}  (${s.label})`);

  console.log("\nTunnel commands (browser login required):");
  for (const c of tunnelCommands(state)) console.log(`  $ ${c}`);

  console.log("\nManual steps:");
  for (const s of manualChecklist(state)) console.log(`  • ${s}`);

  console.log("\nUsage once deployed:");
  for (const l of usageSnippet(state).split("\n")) console.log(`  ${l}`);
  console.log("\nRun `agent init` (without --dry-run) to do it for real.");
}

export async function runInit(opts: { dryRun: boolean }): Promise<void> {
  console.log("conduit — onboarding\n");
  console.log("Prerequisites:");
  const results = await checkPrereqs(capture);
  printPrereqs(results);

  if (opts.dryRun) { dryRun(); return; }

  if (!prereqsSatisfied(results)) {
    console.log("\nInstall the missing required prerequisites above, then re-run `agent init`.");
    return;
  }

  const workerDir = path.join(repoRoot(), "worker");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    // Proxy key (reuse if present).
    const keyPath = proxyKeyPath();
    let proxyKey: string;
    if (fs.existsSync(keyPath)) {
      proxyKey = fs.readFileSync(keyPath, "utf-8").trim();
      console.log(`\nReusing existing proxy key at ${keyPath}`);
    } else {
      proxyKey = generateProxyKey();
      fs.writeFileSync(keyPath, proxyKey, { mode: 0o600 });
      console.log(`\nGenerated proxy key → ${keyPath} (mode 0600)`);
    }

    // Tunnel hostname + Access team domain → wrangler.jsonc.
    const host = (await rl.question("\nTunnel hostname (e.g. conduit-agent.your-zone.com), blank to skip: ")).trim();
    const team = (await rl.question("Cloudflare Access team domain (e.g. you.cloudflareaccess.com), blank to skip: ")).trim();
    if (host || team) writeWranglerPlaceholders(path.join(workerDir, "wrangler.jsonc"), host, team);

    // Provider selection.
    console.log("\nOptional providers (Anthropic/Claude Max is always on):");
    for (const p of CONFIGURABLE_PROVIDERS) console.log(`  ${p.id.padEnd(8)} ${p.label}  (${p.note})`);
    const sel = parseSelection(await rl.question("Enable which? (comma-separated ids, blank for none): "));
    if (sel.unknown.length) console.log(`  (ignoring unknown: ${sel.unknown.join(", ")})`);

    const secretsSet: string[] = [];
    if (await confirm(rl, "\nSet the PROXY_KEY secret on the Worker now?")) {
      if ((await runWithInput("npx", ["wrangler", "secret", "put", "PROXY_KEY"], proxyKey, { cwd: workerDir })) === 0) {
        secretsSet.push("PROXY_KEY");
      }
    }
    for (const s of secretPlan(sel.selected)) {
      const key = (await rl.question(`Enter ${s.env} (${s.label}), blank to skip: `)).trim();
      if (!key) continue;
      if ((await runWithInput("npx", ["wrangler", "secret", "put", s.env], key, { cwd: workerDir })) === 0) {
        secretsSet.push(s.env);
      }
    }

    let deployed = false;
    if (await confirm(rl, "\nDeploy the Worker now (npx wrangler deploy)?")) {
      deployed = (await runInherit("npx", ["wrangler", "deploy"], { cwd: workerDir })) === 0;
    }

    console.log("\nTunnel setup — run these (`tunnel login` opens a browser):");
    const state: WizardState = {
      workerName: WORKER_NAME,
      proxyKeyPath: keyPath,
      proxyKeySaved: true,
      tunnelHostname: host || undefined,
      accessTeamDomain: team || undefined,
      selectedProviderIds: sel.selected,
      secretsSet,
      deployed,
    };
    for (const c of tunnelCommands(state)) console.log(`  $ ${c}`);

    console.log("\n" + buildSetupSummary(state));
  } finally {
    rl.close();
  }
}
