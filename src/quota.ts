import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./hash";
import { aiLimitRequests, decideQuota, utcDay, type QuotaDecision, type QuotaRequest } from "./quota-logic";

const QUOTA_GATE_NAME = "budget";

/**
 * Tiny global budget gate. Protects the Workers AI free allocation
 * (10,000 Neurons/day) from being drained by anonymous visitors: every model
 * call must first `take()` against a global key and a per-client key.
 * Client keys are SHA-256 hashes, so no raw IP address is stored.
 */
export class QuotaGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, key))",
    );
  }

  /**
   * Atomically checks and, if all keys are under their limits, increments today's counters.
   * @param requests Keys with their daily limits; every key must have headroom.
   * @returns The decision, including the UTC day and the first blocking key.
   */
  take(requests: QuotaRequest[]): QuotaDecision {
    const day = utcDay();
    const sql = this.ctx.storage.sql;
    // Old days are irrelevant; keep storage bounded.
    sql.exec("DELETE FROM usage WHERE day < ?", day);

    const counts: Record<string, number> = {};
    for (const request of requests) {
      const row = sql.exec<{ count: number }>("SELECT count FROM usage WHERE day = ? AND key = ?", day, request.key).toArray()[0];
      counts[request.key] = row?.count ?? 0;
    }
    const decision = decideQuota(counts, requests);
    if (decision.allowed) {
      for (const request of requests) {
        sql.exec(
          "INSERT INTO usage (day, key, count) VALUES (?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET count = count + 1",
          day,
          request.key,
        );
      }
    }
    return { ...decision, day };
  }
}

/**
 * Derives a stable, anonymous per-client budget key.
 * @param request Incoming request (only `CF-Connecting-IP` is read).
 * @returns `client:` plus a truncated SHA-256 hex digest; the raw IP is never stored.
 */
export async function clientKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const hex = await sha256Hex(`edge-runbook-copilot|${ip}`);
  return `client:${hex.slice(0, 24)}`;
}

/**
 * Reserves one Workers AI call against the global and per-client daily budgets.
 * @returns True when the call may proceed (and has been counted).
 */
export async function reserveAiCall(env: Env, client: string): Promise<boolean> {
  const gate = env.QuotaGate.getByName(QUOTA_GATE_NAME);
  const decision = await gate.take(aiLimitRequests(client, env.DAILY_AI_CALL_LIMIT, env.DAILY_PER_CLIENT_LIMIT));
  return decision.allowed;
}

/**
 * Counts non-AI actions (starting workflows) so anonymous traffic is bounded too.
 * @param kind Action category used in the counter keys.
 * @param perClient Daily limit per client.
 * @param global Daily limit across all clients.
 * @returns True when the action may proceed (and has been counted).
 */
export async function reserveAction(
  env: Env,
  client: string,
  kind: string,
  perClient: number,
  global: number,
): Promise<boolean> {
  const gate = env.QuotaGate.getByName(QUOTA_GATE_NAME);
  const decision = await gate.take([
    { key: `global:${kind}`, limit: global },
    { key: `${client}:${kind}`, limit: perClient },
  ]);
  return decision.allowed;
}
