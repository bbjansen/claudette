// Pure plan/summary builders for the onboarding wizard — no I/O, fully testable.
// They turn the wizard's collected state into the command lists and the final
// report the operator sees.

import { secretPlan } from "./providers.js";

export interface WizardState {
  workerName: string;            // e.g. "conduit"
  proxyKeyPath: string;          // e.g. ~/.conduit.key
  proxyKeySaved: boolean;
  tunnelHostname?: string;       // e.g. conduit-agent.example.com
  accessTeamDomain?: string;     // e.g. myteam.cloudflareaccess.com
  selectedProviderIds: string[];
  secretsSet: string[];          // Worker secret env names actually set this run
  deployed: boolean;
  workerUrl?: string;            // e.g. https://conduit.acme.workers.dev
}

// The cloudflared commands to stand up the tunnel + DNS route. `tunnel login`
// opens a browser, so these are shown for the operator to run/confirm.
export function tunnelCommands(state: WizardState): string[] {
  const host = state.tunnelHostname ?? "conduit-agent.<your-zone>";
  return [
    "cloudflared tunnel login",
    `cloudflared tunnel create ${state.workerName}`,
    `cloudflared tunnel route dns ${state.workerName} ${host}`,
    "cp cloudflared/config.yml.example ~/.cloudflared/config.yml   # then fill in the UUID + hostname",
  ];
}

// Steps that require a browser / per-account interaction and can't be fully
// automated — surfaced as a checklist.
export function manualChecklist(state: WizardState): string[] {
  const steps: string[] = [];
  if (!state.tunnelHostname) {
    steps.push("Set your tunnel hostname (e.g. conduit-agent.<your-zone>) and re-run, or edit worker/wrangler.jsonc.");
  }
  steps.push("Capture each Claude Max account:  node agent/dist/index.js login --acct you@example.com");
  steps.push("Install the persistent services:  ./scripts/install-launchd.sh  +  the cloudflared launchd plist");
  steps.push("(Optional) Put a Cloudflare Access app in front of the Worker and set ACCESS_AUD.");
  return steps;
}

// curl + key usage, using the resolved Worker URL when known.
export function usageSnippet(state: WizardState): string {
  const url = state.workerUrl ?? `https://${state.workerName}.<your-workers-subdomain>.workers.dev`;
  return [
    `PROXY_KEY=$(cat ${state.proxyKeyPath})`,
    `curl -X POST ${url}/v1/chat/completions \\`,
    `  -H "authorization: Bearer $PROXY_KEY" -H "content-type: application/json" \\`,
    `  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}'`,
  ].join("\n");
}

export function buildSetupSummary(state: WizardState): string {
  const lines: string[] = [];
  lines.push("── conduit setup summary ─────────────────────────────");
  lines.push(`Worker:        ${state.workerName}${state.deployed ? " (deployed)" : " (not deployed yet)"}`);
  if (state.workerUrl) lines.push(`URL:           ${state.workerUrl}`);
  lines.push(`Proxy key:     ${state.proxyKeyPath}${state.proxyKeySaved ? " (saved, mode 0600)" : " (NOT saved)"}`);
  if (state.tunnelHostname) lines.push(`Tunnel host:   ${state.tunnelHostname}`);

  const cloud = secretPlan(state.selectedProviderIds);
  const enabled = state.selectedProviderIds.length > 0 ? state.selectedProviderIds.join(", ") : "anthropic only";
  lines.push(`Providers:     ${enabled}`);
  if (cloud.length > 0) {
    const done = cloud.filter((c) => state.secretsSet.includes(c.env)).map((c) => c.env);
    const pending = cloud.filter((c) => !state.secretsSet.includes(c.env)).map((c) => c.env);
    if (done.length) lines.push(`Secrets set:   ${done.join(", ")}`);
    if (pending.length) lines.push(`Secrets TODO:  ${pending.join(", ")}  (wrangler secret put …)`);
  }

  lines.push("");
  lines.push("Still to do:");
  for (const step of manualChecklist(state)) lines.push(`  • ${step}`);

  lines.push("");
  lines.push("Use it:");
  for (const l of usageSnippet(state).split("\n")) lines.push(`  ${l}`);
  lines.push("──────────────────────────────────────────────────────");
  return lines.join("\n");
}
