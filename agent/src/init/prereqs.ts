// Prerequisite checks for the onboarding wizard. The runner is injected so the
// pure parsing/decision logic is unit-testable without spawning processes.

export interface Prereq {
  name: string;
  cmd: string;
  args: string[];
  required: boolean;
  hint: string;
}

export interface PrereqResult {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
  hint: string;
}

export const PREREQS: Prereq[] = [
  { name: "node", cmd: "node", args: ["--version"], required: true, hint: "Install Node 20+ (https://nodejs.org)" },
  { name: "cloudflared", cmd: "cloudflared", args: ["--version"], required: true, hint: "brew install cloudflared" },
  { name: "git", cmd: "git", args: ["--version"], required: true, hint: "Install git" },
  { name: "jq", cmd: "jq", args: ["--version"], required: false, hint: "brew install jq (optional, for the verify step)" },
];

// Parse the major version from a `node --version` style string ("v20.11.1").
export function parseNodeMajor(versionStr: string): number | null {
  const m = /v?(\d+)\./.exec(versionStr.trim());
  return m ? Number(m[1]) : null;
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export async function checkPrereqs(run: CommandRunner, prereqs: Prereq[] = PREREQS): Promise<PrereqResult[]> {
  const results: PrereqResult[] = [];
  for (const p of prereqs) {
    const r = await run(p.cmd, p.args);
    let ok = r.ok;
    let detail = r.ok ? (r.stdout.trim().split("\n")[0] ?? "") : "not found";
    if (p.name === "node" && r.ok) {
      const major = parseNodeMajor(r.stdout);
      if (major == null || major < 20) {
        ok = false;
        detail = `${detail} (need >= 20)`;
      }
    }
    results.push({ name: p.name, ok, detail, required: p.required, hint: p.hint });
  }
  return results;
}

// True when every REQUIRED prerequisite passed.
export function prereqsSatisfied(results: PrereqResult[]): boolean {
  return results.every((r) => r.ok || !r.required);
}
