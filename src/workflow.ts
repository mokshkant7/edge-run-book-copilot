import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep, DefaultProgress } from "agents/workflows";
import type { ChatAgent } from "./server";
import { buildProposal, verifyApproval } from "./policy";
import { reserveAiCall } from "./quota";
import { formatRunbooks, summaryMessages, templateSummary } from "./prompts";
import { RUNBOOKS, searchRunbooks } from "./retrieval";
import { mockDiagnostics } from "./scenarios";
import { APPROVAL_TIMEOUT_MINUTES, STEP_ORDER, type ProposedAction, type RunStatus, type StepName, type StepStatus } from "./shared";

export interface DiagnosisParams {
  runId: string;
  incident: string;
  /** Hashed client key, used only for budget accounting. */
  client: string;
}

type Outcome = { runId: string; status: RunStatus };

/** Shape produced by Agent.approveWorkflow()/rejectWorkflow(). */
type ApprovalPayload = { approved: boolean; reason?: string; metadata?: { actionHash?: string } };

/**
 * Durable diagnosis pipeline (one instance per run, id = runId, hosted by the session's ChatAgent):
 *   retrieve -> simulated diagnostics -> summarize -> propose -> WAIT FOR HUMAN -> mock restart -> verify
 *
 * Each step persists its result, so a crash or redeploy resumes where it left off.
 * The restart can only run after `verifyApproval` accepts an approval event whose
 * hash matches the proposal, and the service/action must be on the server allowlist.
 */
export class DiagnosisWorkflow extends AgentWorkflow<ChatAgent, DiagnosisParams, DefaultProgress, Env> {
  async run(event: AgentWorkflowEvent<DiagnosisParams>, step: AgentWorkflowStep): Promise<Outcome> {
    const { runId, incident, client } = event.payload;
    const agent = this.agent;
    const markStep = (name: StepName, status: StepStatus, detail?: string) =>
      agent.patchRun(runId, { step: { name, status, detail } });

    const finish = async (status: RunStatus, note: string, skipFrom: StepName | null) => {
      await step.do(`finish-${status}`, async () => {
        const skipped = skipFrom ? STEP_ORDER.slice(STEP_ORDER.indexOf(skipFrom)) : [];
        for (const name of skipped) await markStep(name, "skipped");
        await agent.patchRun(runId, { status, note });
        await agent.writeAudit(runId, `run_${status}`, note);
      });
      const outcome: Outcome = { runId, status };
      await step.reportComplete(outcome);
      return outcome;
    };

    // 1. Retrieve --------------------------------------------------------------
    const match = await step.do("retrieve-runbook", async () => {
      await markStep("retrieve-runbook", "running");
      const best = searchRunbooks(incident, RUNBOOKS, 1)[0];
      const runbook = best ? { id: best.runbook.id, title: best.runbook.title, service: best.runbook.service } : null;
      await agent.patchRun(runId, {
        runbook: runbook ?? undefined,
        step: { name: "retrieve-runbook", status: "done", detail: runbook ? runbook.title : "no matching runbook" },
      });
      return runbook;
    });
    if (!match) {
      return finish("no_match", "No sample runbook matches this incident. Escalate to a human operator.", "mock-diagnostics");
    }

    // 2. Simulated diagnostics -----------------------------------------------
    const diagnostics = await step.do("mock-diagnostics", async () => {
      await markStep("mock-diagnostics", "running");
      const results = mockDiagnostics(match.id);
      await agent.patchRun(runId, {
        diagnostics: results,
        step: { name: "mock-diagnostics", status: "done", detail: `${results.length} simulated checks` },
      });
      return results;
    });

    // 3. Summarize (Workers AI when budget allows, template otherwise) ---------
    await step.do("summarize", async () => {
      await markStep("summarize", "running");
      const runbook = RUNBOOKS.find((rb) => rb.id === match.id);
      let text = templateSummary(match.title, diagnostics);
      let source: "workers-ai" | "template" = "template";

      if (this.env.LLM_MODE !== "offline" && runbook && (await reserveAiCall(this.env, client))) {
        try {
          const ai = this.env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> };
          const out = await ai.run(this.env.CHAT_MODEL, {
            messages: summaryMessages(incident, formatRunbooks([{ runbook, score: 0, matchedTerms: [] }]), diagnostics),
            max_tokens: 250,
            temperature: 0.2,
          });
          const response = (out as { response?: unknown } | null)?.response;
          if (typeof response === "string" && response.trim()) {
            text = response.trim();
            source = "workers-ai";
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "ai_fallback", runId, error: error instanceof Error ? error.name : "UnknownError" }));
          await agent.writeAudit(runId, "ai_fallback", "Workers AI unavailable; used template summary");
        }
      }
      await agent.patchRun(runId, {
        summary: { text, source },
        step: { name: "summarize", status: "done", detail: source === "workers-ai" ? "Llama 3.3" : "template (no AI call)" },
      });
    });

    // 4. Propose a mock action from the allowlist ----------------------------
    const proposal: ProposedAction | null = await step.do("propose-action", async () => {
      await markStep("propose-action", "running");
      const proposed = await buildProposal(runId, match.service, match.title);
      if (!proposed) {
        await markStep("propose-action", "done", "no allowlisted action");
        return null;
      }
      const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MINUTES * 60_000;
      await agent.patchRun(runId, {
        proposed,
        approvalDeadline,
        status: "awaiting_approval",
        step: { name: "propose-action", status: "done", detail: `${proposed.action} ${proposed.service}` },
      });
      await markStep("wait-for-approval", "running", "waiting for a human");
      await agent.writeAudit(runId, "approval_requested", `${proposed.action} ${proposed.service} (hash ${proposed.hash.slice(0, 12)}…)`);
      return proposed;
    });
    if (!proposal) {
      return finish("completed", "Diagnosis complete. No allowlisted mock action exists for this service.", "wait-for-approval");
    }

    // 5. Human approval checkpoint (durable; survives restarts) ---------------
    let approval: { approved: boolean; hash?: unknown; reason?: string } | { timedOut: true };
    try {
      const approvalEvent = await step.waitForEvent<ApprovalPayload>("wait-for-approval", {
        type: "approval",
        timeout: `${APPROVAL_TIMEOUT_MINUTES} minutes`,
      });
      const payload = approvalEvent.payload;
      approval = { approved: payload.approved === true, hash: payload.metadata?.actionHash, reason: payload.reason };
    } catch (err) {
      // The timeout error is not identifiable from the installed packages, so every error is still treated as a timeout.
      console.error(JSON.stringify({ event: "wait_for_approval_error", runId, error: err instanceof Error ? err.name : "UnknownError" }));
      approval = { timedOut: true };
    }

    if ("timedOut" in approval) {
      await step.do("wait-for-approval-timeout", async () => {
        await markStep("wait-for-approval", "failed", "approval window expired");
      });
      return finish("timed_out", `No decision within ${APPROVAL_TIMEOUT_MINUTES} minutes. Nothing was executed.`, "execute-mock-restart");
    }

    const verdict = await step.do("verify-approval", async () => verifyApproval(runId, proposal, approval));
    if (!verdict.ok) {
      const rejected = verdict.reason === "not-approved";
      await step.do("wait-for-approval-denied", async () => {
        await markStep("wait-for-approval", "failed", rejected ? "rejected by operator" : `blocked: ${verdict.reason}`);
      });
      const note = rejected
        ? `Rejected by operator${approval.reason ? `: ${approval.reason}` : ""}. Nothing was executed.`
        : `Approval blocked by policy (${verdict.reason}). Nothing was executed.`;
      return finish("rejected", note, "execute-mock-restart");
    }
    await step.do("approval-accepted", async () => {
      await markStep("wait-for-approval", "done", "approved by operator");
      await agent.writeAudit(runId, "approved", `${proposal.action} ${proposal.service}`);
    });

    // 6. Mock restart (idempotent by runId) -----------------------------------
    const actionId = await step.do("execute-mock-restart", async () => {
      await markStep("execute-mock-restart", "running");
      const id = await agent.recordSimulatedAction(runId, proposal.service, proposal.action);
      await markStep("execute-mock-restart", "done", "SIMULATED_ONLY");
      return id;
    });

    // 7. Verify (simulated) ----------------------------------------------------
    await step.do("verify", async () => {
      const verification = `Simulated health check for ${proposal.service}: all targets healthy. No real system was contacted.`;
      await agent.patchRun(runId, {
        status: "completed",
        result: { actionId, outcome: "SIMULATED_ONLY", verification },
        step: { name: "verify", status: "done", detail: "simulated" },
        note: "Completed. The restart was simulated; no real service changed.",
      });
      await agent.writeAudit(runId, "run_completed", `actionId ${actionId}`);
    });

    const outcome: Outcome = { runId, status: "completed" };
    await step.reportComplete(outcome);
    return outcome;
  }
}
