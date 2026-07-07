import type { AccountId, ModelTier } from "./types.js";
import type { TokenManager } from "./tokens.js";

const TIERS: ModelTier[] = ["opus", "sonnet", "haiku", "other"];

// A failed token fetch (e.g. `invalid_grant` on a revoked refresh token) is
// account-wide, not tier-specific: cool every tier so rotation skips the
// account, long enough to absorb traffic bursts but short enough that an
// operator re-login becomes visible without a restart.
const TOKEN_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

interface PoolEntry {
  acctId: AccountId;
  manager: TokenManager;
}

interface PoolOpts {
  clock?: () => number;
}

export interface AccountSnapshot {
  acctId: AccountId;
  manuallyDisabled: boolean;
  cooldown: Record<ModelTier, { untilMs: number; remainingS: number } | null>;
  lastUsedMs: number | null;
}

export interface PoolSnapshot {
  nowMs: number;
  accounts: AccountSnapshot[];
}

export class AccountPool {
  protected readonly managers = new Map<AccountId, TokenManager>();
  protected readonly cooldown = new Map<AccountId, Map<ModelTier, number>>();
  protected readonly disabled = new Set<AccountId>();
  protected readonly lastUsed = new Map<AccountId, number>();
  protected nextIdx = 0;
  protected readonly clock: () => number;

  constructor(entries: PoolEntry[], opts: PoolOpts = {}) {
    for (const e of entries) this.managers.set(e.acctId, e.manager);
    this.clock = opts.clock ?? Date.now;
  }

  accounts(): AccountId[] {
    return [...this.managers.keys()];
  }

  getManager(acctId: AccountId): TokenManager | undefined {
    return this.managers.get(acctId);
  }

  markCooldown(acctId: AccountId, tier: ModelTier, untilMs: number): void {
    let m = this.cooldown.get(acctId);
    if (!m) { m = new Map(); this.cooldown.set(acctId, m); }
    m.set(tier, untilMs);
  }

  setManuallyDisabled(acctId: AccountId, disabled: boolean): void {
    if (disabled) this.disabled.add(acctId); else this.disabled.delete(acctId);
  }

  isManuallyDisabled(acctId: AccountId): boolean {
    return this.disabled.has(acctId);
  }

  upsertAccount(acctId: AccountId, manager: TokenManager): void {
    this.managers.set(acctId, manager);
  }

  removeAccount(acctId: AccountId): void {
    this.managers.delete(acctId);
    this.cooldown.delete(acctId);
    this.disabled.delete(acctId);
    this.lastUsed.delete(acctId);
    const size = this.managers.size;
    if (size > 0) this.nextIdx = this.nextIdx % size;
    else this.nextIdx = 0;
  }

  async pickToken(tier: ModelTier, exclude: AccountId[] = [], hint: AccountId | null = null): Promise<{ acctId: AccountId; token: string }> {
    const order = this.accounts();
    if (order.length === 0) throw new Error("AccountPool is empty");

    const excludeSet = new Set(exclude);
    const eligible = order.filter(id => !excludeSet.has(id) && !this.disabled.has(id));
    if (eligible.length === 0) throw new Error("no eligible account after applying exclude list / disabled flags");

    const now = this.clock();

    // Honor a valid hint as a non-rotating preference (doesn't advance nextIdx).
    if (hint !== null
        && this.managers.has(hint)
        && !excludeSet.has(hint)
        && !this.disabled.has(hint)) {
      const hintUntil = this.cooldown.get(hint)?.get(tier) ?? 0;
      if (hintUntil <= now) {
        const picked = await this.tryUse(hint, now);
        if (picked) return picked;
      }
    }

    const start = this.nextIdx;
    for (let i = 0; i < order.length; i++) {
      const idx = (start + i) % order.length;
      const acctId = order[idx]!;
      if (excludeSet.has(acctId) || this.disabled.has(acctId)) continue;
      const until = this.cooldown.get(acctId)?.get(tier) ?? 0;
      if (until <= now) {
        const picked = await this.tryUse(acctId, now);
        if (picked === null) continue;
        this.nextIdx = (idx + 1) % order.length;
        return picked;
      }
    }

    const byUntil = [...eligible].sort((a, b) =>
      (this.cooldown.get(a)?.get(tier) ?? Number.POSITIVE_INFINITY)
      - (this.cooldown.get(b)?.get(tier) ?? Number.POSITIVE_INFINITY));
    for (const acctId of byUntil) {
      const picked = await this.tryUse(acctId, now);
      if (picked) return picked;
    }
    throw new Error("AccountPool: token fetch failed for every eligible account");
  }

  snapshot(): PoolSnapshot {
    const now = this.clock();
    const accounts: AccountSnapshot[] = [];
    for (const acctId of this.managers.keys()) {
      const cooldownMap = this.cooldown.get(acctId);
      const cooldown = TIERS.reduce((acc, tier) => {
        const until = cooldownMap?.get(tier);
        if (until != null && until > now) {
          acc[tier] = { untilMs: until, remainingS: Math.round((until - now) / 1000) };
        } else {
          acc[tier] = null;
        }
        return acc;
      }, {} as AccountSnapshot["cooldown"]);
      accounts.push({
        acctId,
        manuallyDisabled: this.disabled.has(acctId),
        cooldown,
        lastUsedMs: this.lastUsed.get(acctId) ?? null,
      });
    }
    return { nowMs: now, accounts };
  }

  private async use(acctId: AccountId, nowMs: number): Promise<{ acctId: AccountId; token: string }> {
    this.lastUsed.set(acctId, nowMs);
    const token = await this.managers.get(acctId)!.getAccessToken();
    return { acctId, token };
  }

  private async tryUse(acctId: AccountId, nowMs: number): Promise<{ acctId: AccountId; token: string } | null> {
    try {
      return await this.use(acctId, nowMs);
    } catch (err) {
      const until = nowMs + TOKEN_FAILURE_COOLDOWN_MS;
      for (const tier of TIERS) this.markCooldown(acctId, tier, until);
      console.warn(`[agent] token fetch failed; cooled ${TOKEN_FAILURE_COOLDOWN_MS / 60_000}min`,
        { acctId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

export const ALL_TIERS = TIERS;
