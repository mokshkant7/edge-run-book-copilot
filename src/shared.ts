// Types shared by the Worker (server) and the React client.

export const STEP_ORDER = [
  "retrieve-runbook",
  "mock-diagnostics",
  "summarize",
  "propose-action",
  "wait-for-approval",
  "execute-mock-restart",
  "verify",
] as const;

export type StepName = (typeof STEP_ORDER)[number];
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export const STEP_LABELS: Record<StepName, string> = {
  "retrieve-runbook": "Retrieve runbook",
  "mock-diagnostics": "Run simulated diagnostics",
  summarize: "Summarize findings",
  "propose-action": "Propose mock action",
  "wait-for-approval": "Human approval",
  "execute-mock-restart": "Execute mock restart",
  verify: "Verify (simulated)",
};

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "timed_out"
  | "no_match"
  | "failed";

export interface DiagnosticResult {
  label: string;
  command: string;
  output: string;
  finding: string;
}

export interface ProposedAction {
  service: string;
  action: "simulate-restart";
  reason: string;
  /** SHA-256 over runId|service|action. The approval must echo it back. */
  hash: string;
}

export interface RunView {
  runId: string;
  incident: string;
  createdAt: number;
  status: RunStatus;
  steps: Array<{ name: StepName; status: StepStatus; detail?: string }>;
  runbook?: { id: string; title: string; service: string };
  diagnostics?: DiagnosticResult[];
  summary?: { text: string; source: "workers-ai" | "template" };
  proposed?: ProposedAction;
  approvalDeadline?: number;
  result?: { actionId: string; outcome: "SIMULATED_ONLY"; verification: string };
  note?: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  runId: string;
  event: string;
  detail: string;
}

export interface AppState {
  runs: RunView[];
  audit: AuditEntry[];
}

export const INITIAL_STATE: AppState = { runs: [], audit: [] };

/** Shortest incident description (after trimming) that the server accepts. */
export const MIN_INCIDENT_LENGTH = 8;
export const MAX_INCIDENT_LENGTH = 600;
export const APPROVAL_TIMEOUT_MINUTES = 15;
/** Canonical lowercase UUID, as produced by `crypto.randomUUID()`. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SESSION_ID_PATTERN = UUID_PATTERN;
