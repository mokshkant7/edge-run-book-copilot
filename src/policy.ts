import { sha256Hex } from "./hash";
import type { ProposedAction } from "./shared";

export { sha256Hex };

/**
 * Server-side allowlist. The model never chooses the service or the action:
 * both are derived from the matched runbook and checked against this table.
 * Every entry is a *demo* service; nothing here maps to a real system.
 */
const ALLOWED_ACTIONS = {
  "origin-api": "simulate-restart",
  "authoritative-dns": "simulate-restart",
  "release-pipeline": "simulate-restart",
  "edge-cache": "simulate-restart",
} as const;

export type AllowedService = keyof typeof ALLOWED_ACTIONS;

/**
 * Checks a service/action pair against the server allowlist.
 * @param service Service id taken from the matched runbook.
 * @param action Requested action.
 * @returns True (and narrows `service`) only for an exact allowlisted pair.
 */
export function isAllowedAction(service: string, action: string): service is AllowedService {
  return Object.hasOwn(ALLOWED_ACTIONS, service) && ALLOWED_ACTIONS[service as AllowedService] === action;
}

/**
 * Binds an approval to one exact run, service and action.
 * @returns Hex SHA-256 over `runId|service|action`.
 */
export async function actionHash(runId: string, service: string, action: string): Promise<string> {
  return sha256Hex(`${runId}|${service}|${action}`);
}

/** Constant-time string comparison for the approval hash. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Builds the human-approvable proposal for a service.
 * @param runId Run the proposal belongs to (bound into the hash).
 * @param service Service id from the matched runbook.
 * @param runbookTitle Title used in the human-readable reason.
 * @returns The proposal, or null when the service has no allowlisted action.
 */
export async function buildProposal(
  runId: string,
  service: string,
  runbookTitle: string,
): Promise<ProposedAction | null> {
  const action = "simulate-restart";
  if (!isAllowedAction(service, action)) return null;
  return {
    service,
    action,
    reason: `Simulated restart of ${service} suggested by runbook "${runbookTitle}" after diagnostics.`,
    hash: await actionHash(runId, service, action),
  };
}

type ApprovalVerdict =
  | { ok: true }
  | { ok: false; reason: "not-approved" | "hash-mismatch" | "action-not-allowed" };

/**
 * The only gate between a proposal and the mock restart. Pure, so it is unit tested.
 * @param runId Run being approved.
 * @param proposal The proposal that was shown to the human.
 * @param approval Decision payload from the approval event.
 * @returns `{ ok: true }` only if approved, still allowlisted and the hash matches.
 */
export async function verifyApproval(
  runId: string,
  proposal: ProposedAction,
  approval: { approved: boolean; hash?: unknown },
): Promise<ApprovalVerdict> {
  if (!approval.approved) return { ok: false, reason: "not-approved" };
  if (!isAllowedAction(proposal.service, proposal.action)) return { ok: false, reason: "action-not-allowed" };
  const expected = await actionHash(runId, proposal.service, proposal.action);
  if (typeof approval.hash !== "string" || !safeEqual(approval.hash, expected)) {
    return { ok: false, reason: "hash-mismatch" };
  }
  return { ok: true };
}
