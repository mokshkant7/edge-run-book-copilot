export interface QuotaRequest {
  key: string;
  limit: number;
}

export interface QuotaDecision {
  allowed: boolean;
  /** The first key that was over its limit, if any. */
  blockedBy?: string;
  day: string;
}

/**
 * Pure decision function so the policy can be unit tested without a Durable Object.
 * @param counts Current usage per key.
 * @param requests Keys with limits to check.
 * @returns Allowed, or the first key at or over its limit.
 */
export function decideQuota(
  counts: Record<string, number>,
  requests: QuotaRequest[],
): { allowed: boolean; blockedBy?: string } {
  for (const request of requests) {
    if ((counts[request.key] ?? 0) >= request.limit) return { allowed: false, blockedBy: request.key };
  }
  return { allowed: true };
}

/** @returns The UTC calendar day (YYYY-MM-DD) for a timestamp (default: now). */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** @returns The parsed non-negative integer limit, or `fallback` when missing or invalid. */
export function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Builds the quota keys for one Workers AI call.
 * @param globalLimit Raw env value for the global daily limit.
 * @param clientLimit Raw env value for the per-client daily limit.
 * @returns Global and per-client requests with parsed limits.
 */
export function aiLimitRequests(
  client: string,
  globalLimit: string | undefined,
  clientLimit: string | undefined,
): QuotaRequest[] {
  return [
    { key: "global:ai", limit: parseLimit(globalLimit, 60) },
    { key: `${client}:ai`, limit: parseLimit(clientLimit, 15) },
  ];
}
