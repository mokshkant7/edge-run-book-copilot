import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName, routeAgentRequest } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, streamText } from "ai";
import { chatSystemPrompt, offlineAnswer } from "./prompts";
import { clientKey, reserveAiCall, reserveAction } from "./quota";
import { searchRunbooks } from "./retrieval";
import {
  INITIAL_STATE,
  MAX_INCIDENT_LENGTH,
  MIN_INCIDENT_LENGTH,
  SESSION_ID_PATTERN,
  STEP_ORDER,
  type AppState,
  type AuditEntry,
  type RunView,
  type StepName,
  type StepStatus,
  UUID_PATTERN,
} from "./shared";

export { DiagnosisWorkflow } from "./workflow";
export { QuotaGate } from "./quota";

const MAX_RUNS = 10;
const MAX_AUDIT = 30;
const MAX_PERSISTED_MESSAGES = 50;
/** Daily workflow starts allowed per client / across all clients (see reserveAction). */
const WORKFLOW_DAILY_LIMIT_PER_CLIENT = 10;
const WORKFLOW_DAILY_LIMIT_GLOBAL = 60;

/** Structured, content-free error log line: event, run id and error name only. */
function logError(event: string, fields: Record<string, string>, err: unknown): void {
  console.error(JSON.stringify({ event, ...fields, error: err instanceof Error ? err.name : "UnknownError" }));
}

export interface RunPatch extends Partial<Omit<RunView, "steps" | "runId" | "incident" | "createdAt">> {
  step?: { name: StepName; status: StepStatus; detail?: string };
}

function textOf(message: { parts?: Array<{ type: string; text?: string }> }): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

/** Returns copies of the messages with every text part capped at MAX_INCIDENT_LENGTH characters. */
function clampMessages<M extends { parts?: Array<{ type: string; text?: string }> }>(messages: M[]): M[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts?.map((part) =>
      part.type === "text" && typeof part.text === "string" ? { ...part, text: part.text.slice(0, MAX_INCIDENT_LENGTH) } : part,
    ),
  }));
}

/**
 * One Durable Object per browser session: chat, run state, audit log and the workflow-facing RPC surface.
 */
export class ChatAgent extends AIChatAgent<Env, AppState> {
  initialState: AppState = INITIAL_STATE;
  maxPersistedMessages = MAX_PERSISTED_MESSAGES;

  async onStart(props?: Parameters<AIChatAgent<Env, AppState>["onStart"]>[0]) {
    await super.onStart(props);
    this.sql`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, run_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS simulated_actions (
      run_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, service TEXT NOT NULL, action TEXT NOT NULL,
      outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    )`;
  }

  // --- connection bookkeeping ---------------------------------------------------

  async onConnect(connection: Parameters<AIChatAgent<Env, AppState>["onConnect"]>[0], ctx: { request: Request }) {
    // Remember a hashed client key (never the raw IP) so chat turns count against a per-client budget.
    this.ctx.storage.kv.put("client", await clientKey(ctx.request));
    return super.onConnect(connection, ctx);
  }

  private client(): string {
    return this.ctx.storage.kv.get<string>("client") ?? "client:unknown";
  }

  // --- chat ----------------------------------------------------------------------

  /**
   * Answers a chat turn: deterministic retrieval first, then Workers AI unless offline or over budget.
   * Text is capped per message so model cost stays bounded.
   * @returns A UI message stream response.
   */
  async onChatMessage() {
    const recent = clampMessages(this.messages.slice(-6));
    const userTexts = recent.filter((m) => m.role === "user").map(textOf);
    // Retrieval is deterministic and runs on the server *before* the model call,
    // so grounding never depends on the model deciding to call a tool.
    const matches = searchRunbooks(userTexts.slice(-2).join(" "));

    let fallbackReason: string | null = null;
    if (this.env.LLM_MODE === "offline") {
      fallbackReason = "Runbook-only mode (LLM_MODE=offline): no model call was made.";
    } else if (!(await reserveAiCall(this.env, this.client()))) {
      fallbackReason = "Daily free-tier AI budget reached, so this is a runbook-only answer (no model call).";
    }

    if (fallbackReason) {
      const answer = offlineAnswer(matches, fallbackReason);
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          const id = crypto.randomUUID();
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: answer });
          writer.write({ type: "text-end", id });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }

    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      // CHAT_MODEL must be a Workers AI text-generation model id (see wrangler.jsonc vars).
      model: ai(this.env.CHAT_MODEL as "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: chatSystemPrompt(matches),
      messages: await convertToModelMessages(recent),
      maxOutputTokens: 400,
      temperature: 0.2,
      onError: ({ error }) => logError("chat_stream_error", {}, error),
    });
    return result.toUIMessageStreamResponse();
  }

  // --- workflow-facing RPC (called by the Worker API and by DiagnosisWorkflow) ----

  /**
   * Start a durable diagnosis. The caller has already applied rate limits.
   * @param incident Incident description (trimmed and capped here).
   * @param client Hashed client key, used only for budget accounting.
   * @returns The new run id.
   * @throws If the incident is too short or the workflow cannot be started.
   */
  async startDiagnosis(incident: string, client: string): Promise<{ runId: string }> {
    const text = incident.trim().slice(0, MAX_INCIDENT_LENGTH);
    if (text.length < MIN_INCIDENT_LENGTH) throw new Error("Describe the incident in at least a few words.");

    const runId = crypto.randomUUID();
    const run: RunView = {
      runId,
      incident: text,
      createdAt: Date.now(),
      status: "running",
      steps: STEP_ORDER.map((name) => ({ name, status: "pending" })),
    };
    this.setState({ ...this.state, runs: [run, ...this.state.runs].slice(0, MAX_RUNS) });
    this.writeAudit(runId, "run_started", text.slice(0, 120));

    try {
      await this.runWorkflow("DIAGNOSIS_WORKFLOW", { runId, incident: text, client }, { id: runId, metadata: { runId } });
    } catch (err) {
      this.patchRun(runId, { status: "failed", note: "Could not start the workflow." });
      this.writeAudit(runId, "run_failed", "Workflow could not be started");
      logError("run_failed", { runId }, err);
      throw new Error("Could not start the workflow.");
    }
    return { runId };
  }

  /**
   * Merge a patch into a run. Idempotent: safe to repeat on workflow retry.
   * @param runId Run to update; unknown ids are ignored.
   * @param patch Run fields and/or one step update.
   */
  patchRun(runId: string, patch: RunPatch): void {
    const { step, ...fields } = patch;
    const runs = this.state.runs.map((run) => {
      if (run.runId !== runId) return run;
      const steps = step
        ? run.steps.map((s) => (s.name === step.name ? { name: s.name, status: step.status, detail: step.detail ?? s.detail } : s))
        : run.steps;
      return { ...run, ...fields, steps };
    });
    this.setState({ ...this.state, runs });
  }

  /** Appends an audit row and refreshes the audit slice of client state (latest MAX_AUDIT entries). */
  writeAudit(runId: string, event: string, detail: string): void {
    this.sql`INSERT INTO audit_log (ts, run_id, event, detail) VALUES (${Date.now()}, ${runId}, ${event}, ${detail})`;
    const audit = this.sql<{ id: number; ts: number; run_id: string; event: string; detail: string }>`
      SELECT id, ts, run_id, event, detail FROM audit_log ORDER BY id DESC LIMIT ${MAX_AUDIT}`.map(
      (row): AuditEntry => ({ id: row.id, ts: row.ts, runId: row.run_id, event: row.event, detail: row.detail }),
    );
    this.setState({ ...this.state, audit });
  }

  /**
   * Records the (simulated) restart. Keyed by run id so retries cannot double-record.
   * @returns The action id (the existing one on a retry).
   */
  recordSimulatedAction(runId: string, service: string, action: string): string {
    const existing = this.sql<{ action_id: string }>`SELECT action_id FROM simulated_actions WHERE run_id = ${runId}`[0];
    if (existing) return existing.action_id;
    const actionId = crypto.randomUUID();
    this.sql`INSERT INTO simulated_actions (run_id, action_id, service, action, outcome, created_at)
      VALUES (${runId}, ${actionId}, ${service}, ${action}, 'SIMULATED_ONLY', ${Date.now()})`;
    this.writeAudit(runId, "simulated_restart", `${action} ${service} -> SIMULATED_ONLY (${actionId.slice(0, 8)})`);
    return actionId;
  }

  /**
   * Human decision. Forwards to the waiting workflow only if the run is genuinely awaiting approval.
   * @param runId Run being decided.
   * @param approved True to approve, false to reject.
   * @param hash Proposal hash echoed back by the client (checked on approval).
   * @returns `ok` plus a user-facing message; failures are returned, not thrown.
   */
  async decide(runId: string, approved: boolean, hash: string): Promise<{ ok: boolean; message: string }> {
    const run = this.state.runs.find((r) => r.runId === runId);
    if (!run) return { ok: false, message: "Unknown run." };
    if (run.status !== "awaiting_approval" || !run.proposed) return { ok: false, message: "This run is not waiting for approval." };
    if (run.approvalDeadline && Date.now() > run.approvalDeadline) return { ok: false, message: "The approval window has expired." };
    if (approved && hash !== run.proposed.hash) return { ok: false, message: "Approval does not match the proposed action." };

    // Block double submission while the workflow resumes.
    this.patchRun(runId, { status: "running", step: { name: "wait-for-approval", status: "running", detail: "decision submitted" } });
    try {
      if (approved) {
        await this.approveWorkflow(runId, { reason: "Approved in UI", metadata: { actionHash: hash } });
      } else {
        await this.rejectWorkflow(runId, { reason: "Rejected in UI" });
      }
    } catch (err) {
      this.patchRun(runId, { status: "awaiting_approval", step: { name: "wait-for-approval", status: "running", detail: "waiting for a human" } });
      this.writeAudit(runId, "decision_failed", "Decision could not be delivered");
      logError("decision_failed", { runId }, err);
      return { ok: false, message: "Could not deliver the decision, please try again." };
    }
    this.writeAudit(runId, approved ? "approval_submitted" : "rejection_submitted", `${run.proposed.action} ${run.proposed.service}`);
    return { ok: true, message: approved ? "Approval sent." : "Rejection sent." };
  }

  /** Marks the run failed. The raw workflow error stays in server logs and is never shown to clients. */
  async onWorkflowError(_workflowName: string, instanceId: string, error: string) {
    console.error(JSON.stringify({ event: "workflow_error", runId: instanceId, error: error.match(/^\w*Error\b/)?.[0] ?? "Error" }));
    const run = this.state.runs.find((r) => r.runId === instanceId);
    for (const s of run?.steps ?? []) {
      if (s.status === "running") this.patchRun(instanceId, { step: { name: s.name, status: "failed" } });
      else if (s.status === "pending") this.patchRun(instanceId, { step: { name: s.name, status: "skipped" } });
    }
    this.patchRun(instanceId, { status: "failed", note: "The workflow failed. See server logs." });
    this.writeAudit(instanceId, "run_failed", "Workflow failed");
  }
}

// --- HTTP surface ---------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Browsers always send Origin on WebSocket upgrades and cross-site POSTs; require same-origin. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return request.method === "GET";
  return origin === new URL(request.url).origin;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) return null;
  const raw = await request.text();
  if (raw.length > 4_000) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Cross-origin requests are not allowed" }, 403);

  const body = await readJson(request);
  const session = typeof body?.session === "string" ? body.session : "";
  if (!body || !SESSION_ID_PATTERN.test(session)) return json({ error: "Invalid request" }, 400);

  const client = await clientKey(request);

  if (url.pathname === "/api/diagnose") {
    const incident = typeof body.incident === "string" ? body.incident : "";
    if (incident.trim().length < MIN_INCIDENT_LENGTH || incident.length > MAX_INCIDENT_LENGTH) {
      return json({ error: `Describe the incident in ${MIN_INCIDENT_LENGTH}-${MAX_INCIDENT_LENGTH} characters.` }, 400);
    }
    if (!(await reserveAction(env, client, "workflow", WORKFLOW_DAILY_LIMIT_PER_CLIENT, WORKFLOW_DAILY_LIMIT_GLOBAL))) {
      return json({ error: "Daily demo limit reached. Try again tomorrow (UTC)." }, 429);
    }
    const agent = await getAgentByName(env.ChatAgent, session);
    return json(await agent.startDiagnosis(incident, client), 202);
  }

  if (url.pathname === "/api/decision") {
    const runId = typeof body.runId === "string" ? body.runId : "";
    const hash = typeof body.hash === "string" ? body.hash : "";
    if (!UUID_PATTERN.test(runId) || typeof body.approved !== "boolean" || hash.length > 128) {
      return json({ error: "Invalid request" }, 400);
    }
    const agent = await getAgentByName(env.ChatAgent, session);
    const result = await agent.decide(runId, body.approved, hash);
    return json(result, result.ok ? 200 : 409);
  }

  return json({ error: "Not found" }, 404);
}

/** Wraps routeApi so unexpected failures become a generic 500 with a content-free log line. */
async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    return await routeApi(request, env, url);
  } catch (err) {
    console.error(JSON.stringify({ event: "api_error", route: url.pathname, error: err instanceof Error ? err.name : "UnknownError" }));
    return json({ error: "Internal error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);

    const guard = (req: Request, route: { className: string; name: string }) => {
      // Only ChatAgent is reachable via /agents/*; QuotaGate and other bindings are internal.
      if (route.className.replace(/-/g, "").toLowerCase() !== "chatagent") return new Response("Not found", { status: 404 });
      if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
      if (!SESSION_ID_PATTERN.test(route.name)) return new Response("Invalid session", { status: 400 });
    };
    const response = await routeAgentRequest(request, env, { onBeforeConnect: guard, onBeforeRequest: guard });
    return response ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
