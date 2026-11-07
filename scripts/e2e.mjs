// End-to-end checks against a running Worker (local `wrangler dev` or a deployed URL).
//   BASE_URL=http://127.0.0.1:8787 node scripts/e2e.mjs
// Requires Node 22+ (global fetch and WebSocket). Uses only the public HTTP/WebSocket surface.
import { randomUUID } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
let failures = 0;

const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function watch(session) {
  const state = { runs: [], audit: [], socketError: null };
  const socket = new WebSocket(`${WS_BASE}/agents/chat-agent/${session}`);
  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "cf_agent_state" && msg.state) Object.assign(state, msg.state);
    } catch (error) {
      // Ignore only non-JSON frames (e.g. chat stream chunks); anything else is a real bug.
      if (!(error instanceof SyntaxError)) throw error;
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  // After open, a socket error must fail pending waitFor() calls instead of timing out silently.
  socket.addEventListener("error", () => { state.socketError = "websocket error after connect"; });
  return { state, socket, ready };
}

let socketState = null;
async function waitFor(fn, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (socketState?.socketError) throw new Error(`${socketState.socketError} while waiting for ${label}`);
    const value = fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const run = (state, id) => state.runs?.find((r) => r.runId === id);

// Every diagnosis start must be 202; 429 means the hardcoded daily workflow limit was hit.
async function diagnose(body) {
  const res = await post("/api/diagnose", body);
  if (res.status === 429) throw new Error("Daily workflow limit reached for this client; wait for UTC midnight or restart wrangler dev with a fresh state");
  if (res.status !== 202) throw new Error(`POST /api/diagnose expected 202, got ${res.status}`);
  return res;
}
const step = (r, name) => r?.steps?.find((s) => s.name === name)?.status;

async function main() {
  const session = randomUUID();
  const { state, socket, ready } = watch(session);
  socketState = state;
  await ready;
  check("websocket connects to the agent", true);

  // --- request hardening ---------------------------------------------------------
  let r = await post("/api/diagnose", { session, incident: "API requests returning 502 after a release" }, { origin: "https://evil.example" });
  check("cross-origin POST is rejected", r.status === 403, `status ${r.status}`);
  r = await post("/api/diagnose", { session: "not-a-uuid", incident: "API requests returning 502 after a release" });
  check("invalid session id is rejected", r.status === 400, `status ${r.status}`);
  r = await post("/api/diagnose", { session, incident: "hi" });
  check("too-short incident is rejected", r.status === 400, `status ${r.status}`);
  const getRes = await fetch(`${BASE}/api/diagnose`, { signal: AbortSignal.timeout(10000) });
  check("GET on API is rejected", getRes.status === 405, `status ${getRes.status}`);

  // --- approve path -------------------------------------------------------------
  r = await diagnose({ session, incident: "API requests began returning 502s after a release. What should I check?" });
  check("diagnosis starts (202)", r.status === 202 && typeof r.data.runId === "string", `status ${r.status}`);
  const approveRun = r.data.runId;

  const waiting = await waitFor(() => run(state, approveRun)?.status === "awaiting_approval" && run(state, approveRun), "awaiting_approval");
  check("workflow retrieved the right runbook", waiting.runbook?.id === "origin-5xx-after-deploy", waiting.runbook?.id);
  check("simulated diagnostics were produced", (waiting.diagnostics?.length ?? 0) >= 2);
  check("summary exists", Boolean(waiting.summary?.text), waiting.summary?.source);
  check("workflow paused at the approval step", step(waiting, "wait-for-approval") === "running" && step(waiting, "execute-mock-restart") === "pending");
  check("no restart happened before approval", !waiting.result && !state.audit.some((a) => a.runId === approveRun && a.event === "simulated_restart"));

  r = await post("/api/decision", { session, runId: approveRun, approved: true, hash: "0".repeat(64) });
  check("approval with a wrong hash is refused", r.status === 409, `status ${r.status}`);
  await sleep(500);
  check("run is still waiting after the bad approval", run(state, approveRun).status === "awaiting_approval");

  r = await post("/api/decision", { session, runId: approveRun, approved: true, hash: waiting.proposed.hash });
  check("approval with the proposal hash is accepted", r.status === 200, `status ${r.status}`);
  const done = await waitFor(() => ["completed", "failed", "rejected"].includes(run(state, approveRun)?.status) && run(state, approveRun), "completion");
  check("run completed after approval", done.status === "completed", done.status);
  check("result is SIMULATED_ONLY", done.result?.outcome === "SIMULATED_ONLY");
  check("every step is done", done.steps.every((s) => s.status === "done"), done.steps.map((s) => `${s.name}:${s.status}`).join(" "));
  check("audit log records approval and simulated restart", ["approval_requested", "approved", "simulated_restart"].every((e) => state.audit.some((a) => a.runId === approveRun && a.event === e)));

  r = await post("/api/decision", { session, runId: approveRun, approved: true, hash: waiting.proposed.hash });
  check("replaying the approval on a finished run is refused", r.status === 409, `status ${r.status}`);

  // --- reject path --------------------------------------------------------------
  r = await diagnose({ session, incident: "Users report intermittent DNS lookup failures for a hostname." });
  const rejectRun = r.data.runId;
  const w2 = await waitFor(() => run(state, rejectRun)?.status === "awaiting_approval" && run(state, rejectRun), "awaiting_approval (dns)");
  check("dns incident maps to the dns runbook", w2.runbook?.id === "dns-resolution-intermittent");
  r = await post("/api/decision", { session, runId: rejectRun, approved: false, hash: w2.proposed.hash });
  check("rejection is accepted", r.status === 200, `status ${r.status}`);
  const rej = await waitFor(() => ["rejected", "completed", "failed"].includes(run(state, rejectRun)?.status) && run(state, rejectRun), "rejection");
  check("rejected run ends rejected", rej.status === "rejected", rej.status);
  check("rejected run never executed the restart", !rej.result && step(rej, "execute-mock-restart") === "skipped" && !state.audit.some((a) => a.runId === rejectRun && a.event === "simulated_restart"));

  // --- no match -----------------------------------------------------------------
  r = await diagnose({ session, incident: "what is the weather like in paris today" });
  const nm = await waitFor(() => run(state, r.data.runId)?.status && ["no_match", "failed", "completed"].includes(run(state, r.data.runId).status) && run(state, r.data.runId), "no_match");
  check("unrelated text yields no_match and no approval request", nm.status === "no_match" && !nm.proposed, nm.status);

  // --- poisoned runbook text must not bypass approval ----------------------------
  r = await diagnose({ session, incident: "Users see old page content in one region even after a cache purge." });
  const poisonRun = r.data.runId;
  const w3 = await waitFor(() => run(state, poisonRun)?.status === "awaiting_approval" && run(state, poisonRun), "awaiting_approval (poisoned)");
  check("poisoned runbook still stops at the approval gate", w3.runbook?.id === "edge-cache-stale-content" && !w3.result);
  r = await post("/api/decision", { session, runId: poisonRun, approved: false, hash: w3.proposed.hash });
  check("poisoned run rejection is accepted", r.status === 200, `status ${r.status}`);
  const poisonDone = await waitFor(() => ["rejected", "completed", "failed"].includes(run(state, poisonRun)?.status) && run(state, poisonRun), "poisoned run rejection");
  check("poisoned run ends rejected", poisonDone.status === "rejected", poisonDone.status);

  // --- durable memory: a fresh connection to the same session sees prior runs ----
  socket.close();
  const again = watch(session);
  await again.ready;
  await waitFor(() => again.state.runs.length >= 4, "state replay on reconnect");
  check("a new connection to the same session restores runs and audit log", again.state.runs.length >= 4 && again.state.audit.length > 0, `${again.state.runs.length} runs`);
  again.socket.close();

  console.log(failures === 0 ? "\nAll end-to-end checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E aborted:", error.message);
  process.exit(1);
});
