import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import "./style.css";
import "./workflow.css";
import { INITIAL_STATE, MAX_INCIDENT_LENGTH, MIN_INCIDENT_LENGTH, SESSION_ID_PATTERN, STEP_LABELS, type AppState, type RunStatus, type RunView, type StepStatus } from "./shared";

const examples = [
  "API requests began returning 502s after a release. What should I check?",
  "Users report intermittent DNS lookup failures for a hostname.",
  "A deployment is stuck and new instances are failing readiness checks.",
  "Users see old page content in one region even after a cache purge.",
];

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "RUNNING",
  awaiting_approval: "AWAITING APPROVAL",
  completed: "COMPLETED",
  rejected: "REJECTED",
  timed_out: "TIMED OUT",
  no_match: "NO RUNBOOK MATCH",
  failed: "FAILED",
};

const STEP_ICON: Record<StepStatus, string> = { pending: "○", running: "◌", done: "●", skipped: "–", failed: "✕" };

let memorySessionId: string | undefined;

function sessionId(): string {
  const key = "edge-runbook-copilot-session";
  try {
    const saved = window.localStorage.getItem(key);
    if (saved && SESSION_ID_PATTERN.test(saved)) return saved;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    memorySessionId ??= crypto.randomUUID();
    return memorySessionId;
  }
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, data: { error: "Network error. Check your connection and try again." } };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

function useCountdown(deadline?: number): { label: string; expired: boolean } | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (deadline - current <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (!deadline) return null;
  const left = Math.max(0, Math.floor((deadline - now) / 1000));
  return { label: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, expired: left === 0 };
}

function RunCard({ run, session, onError }: { run: RunView; session: string; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown(run.status === "awaiting_approval" ? run.approvalDeadline : undefined);

  const decide = async (approved: boolean) => {
    if (!run.proposed) return;
    onError(null);
    setBusy(true);
    try {
      const { ok, data } = await postJson("/api/decision", { session, runId: run.runId, approved, hash: run.proposed.hash });
      if (!ok) onError(String(data.message ?? data.error ?? "Decision failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`run-card status-${run.status}`} data-testid="run-card">
      <header>
        <span className={`run-status ${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <small>{new Date(run.createdAt).toLocaleTimeString()}</small>
      </header>
      <p className="run-incident">{run.incident}</p>
      {run.runbook && <p className="run-runbook">Runbook: <b>{run.runbook.title}</b> <i>({run.runbook.service})</i></p>}

      <ol className="step-list">
        {run.steps.map((step) => (
          <li key={step.name} className={`step ${step.status}`}>
            <span className="step-icon" aria-hidden="true">{STEP_ICON[step.status]}</span>
            <span className="sr-only">{step.status}</span>
            <span className="step-name">{STEP_LABELS[step.name]}</span>
            {step.detail && <small>{step.detail}</small>}
          </li>
        ))}
      </ol>

      {run.diagnostics && run.diagnostics.length > 0 && (
        <details className="run-details">
          <summary>Simulated diagnostics ({run.diagnostics.length})</summary>
          {run.diagnostics.map((d) => (
            <div key={d.label} className="diag">
              <b>{d.label}</b>
              <code>$ {d.command}</code>
              <pre>{d.output}</pre>
              <em>{d.finding}</em>
            </div>
          ))}
        </details>
      )}

      {run.summary && (
        <div className="run-summary">
          <small>SUMMARY · {run.summary.source === "workers-ai" ? "Workers AI (Llama 3.3)" : "template, no model call"}</small>
          <p>{run.summary.text}</p>
        </div>
      )}

      {run.status === "awaiting_approval" && run.proposed && (
        <div className="approval-card" data-testid="approval-card">
          <div className="approval-heading">
            <span className="approval-icon">!</span>
            <div><b>Approval required</b><small>Simulated operation · {countdown?.expired ? "expired" : `expires in ${countdown?.label ?? "…"}`}</small></div>
          </div>
          <div className="approval-detail"><span>Action</span><strong>{run.proposed.action}</strong></div>
          <div className="approval-detail"><span>Service</span><strong>{run.proposed.service}</strong></div>
          <div className="approval-detail"><span>Action hash</span><strong title={run.proposed.hash}>{run.proposed.hash.slice(0, 16)}…</strong></div>
          <p className="approval-reason">{run.proposed.reason}</p>
          <div className="approval-actions">
            <button className="approve" disabled={busy || !!countdown?.expired} onClick={() => decide(true)}>Approve simulation</button>
            <button className="reject" disabled={busy || !!countdown?.expired} onClick={() => decide(false)}>Reject</button>
          </div>
        </div>
      )}

      {run.result && (
        <div className="run-result">
          <b>{run.result.outcome}</b> · action {run.result.actionId.slice(0, 8)}
          <p>{run.result.verification}</p>
        </div>
      )}
      {run.note && <p className="run-note">{run.note}</p>}
    </article>
  );
}

function App() {
  const [session] = useState(sessionId);
  const [appState, setAppState] = useState<AppState>(INITIAL_STATE);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const agent = useAgent<AppState>({
    agent: "ChatAgent",
    name: session,
    onStateUpdate: (next) => setAppState(next),
  });
  const { messages, sendMessage, clearHistory, status, error: chatError } = useAgentChat({ agent });
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const lastUserText = [...messages]
    .reverse()
    .find((m) => m.role === "user")
    ?.parts.map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();

  const responding = status === "streaming" || status === "submitted";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || responding) return;
    sendMessage({ text });
    setDraft("");
  };

  const startDiagnosis = async (text: string | undefined) => {
    setError(null);
    if (!text || text.length < MIN_INCIDENT_LENGTH) {
      setError("Describe the incident first (type it, or send a chat message).");
      return;
    }
    setStarting(true);
    try {
      const { ok, data } = await postJson("/api/diagnose", { session, incident: text });
      if (!ok) setError(String(data.error ?? "Could not start the diagnosis"));
      else setDraft("");
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand-mark">ER</div>
        <div className="rail-label">OPS<br />ASSIST</div>
        <div className="rail-bottom"><span className="pulse" /> DEMO ENVIRONMENT</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb">WORKSPACE <span>/</span> INCIDENT RESPONSE</div>
          <div className="topbar-right"><span className="status-dot" /> CLOUDFLARE WORKERS AI · WORKFLOWS · DURABLE OBJECTS</div>
        </header>

        <div className="content wide">
          <div className="heading-row">
            <div>
              <p className="eyebrow">DURABLE INFRASTRUCTURE ASSISTANT</p>
              <h1>Runbook Copilot<span>.</span></h1>
              <p className="subheading">Investigate incidents with grounded runbooks. Every action is gated by a human.</p>
            </div>
            <button className="clear-button" onClick={clearHistory} disabled={messages.length === 0}>CLEAR CHAT <span>↗</span></button>
          </div>

          <div className="disclaimer"><span className="shield">◇</span><span><b>Sandboxed demo</b> &nbsp;Runbooks and diagnostics are sample data. Remediation is simulated and cannot reach any real system. Do not enter sensitive data.</span></div>

          <div className="layout">
            <section className="chat-card" aria-label="Runbook chat">
              <div className="chat-header">
                <div className="avatar">R</div>
                <div><strong>Incident response</strong><small>Durable session · ID {session.slice(0, 8)} · saved in this browser</small></div>
                <span className="live-pill"><i /> READY</span>
              </div>

              <div className="sr-only" role="status" aria-live="polite">{responding ? "Assistant is responding" : messages.length > 0 ? "Response complete" : ""}</div>
              {chatError && <p className="error-text" role="alert">{chatError.message || "Chat error. Please try again."}</p>}
              <div className="messages">
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="spark">✳</div>
                    <h2>What are you seeing?</h2>
                    <p>Describe symptoms and recent changes. I’ll find a matching runbook and lay out safe checks, then you can run the approval-gated workflow.</p>
                    <div className="example-list">
                      {examples.map((example) => <button key={example} onClick={() => sendMessage({ text: example })}>{example}<span>→</span></button>)}
                    </div>
                  </div>
                ) : messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    <div className="message-label">{message.role === "user" ? "YOU" : "RUNBOOK COPILOT"}</div>
                    {message.parts.map((part, index) =>
                      part.type === "text" ? <p key={index} className="message-text">{part.text}</p> : null,
                    )}
                  </article>
                ))}
                {responding && <div className="thinking"><span /><span /><span /> Reviewing runbooks…</div>}
                <div ref={endRef} />
              </div>

              <form className="composer" onSubmit={submit}>
                <textarea aria-label="Incident description" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Describe the incident, symptoms, and recent changes…" rows={2} maxLength={MAX_INCIDENT_LENGTH} />
                <div className="composer-bottom">
                  <span>Enter to send · Shift + Enter for a new line</span>
                  <div className="composer-buttons">
                    <button type="button" className="secondary" disabled={starting} onClick={() => startDiagnosis(draft.trim() || lastUserText)} data-testid="run-diagnosis">RUN DURABLE DIAGNOSIS</button>
                    <button type="submit" disabled={!draft.trim() || responding}>SEND <span>↗</span></button>
                  </div>
                </div>
              </form>
            </section>

            <aside className="side" aria-label="Workflow and audit">
              <section className="panel">
                <h2>Workflow runs</h2>
                {error && <p className="error-text" role="alert">{error}</p>}
                {appState.runs.length === 0
                  ? <p className="muted">No runs yet. Describe an incident and press <b>Run durable diagnosis</b>. The workflow retrieves a runbook, runs simulated diagnostics, then pauses for your approval.</p>
                  : appState.runs.map((run) => <RunCard key={run.runId} run={run} session={session} onError={setError} />)}
              </section>
              <section className="panel">
                <h2>Audit log</h2>
                {appState.audit.length === 0
                  ? <p className="muted">Decisions and simulated actions are recorded here.</p>
                  : <ul className="audit">{appState.audit.map((a) => (
                      <li key={a.id}><time>{new Date(a.ts).toLocaleTimeString()}</time> <b>{a.event}</b> <span>{a.detail}</span></li>
                    ))}</ul>}
              </section>
            </aside>
          </div>

          <footer><span>EDGE RUNBOOK COPILOT</span><span>WORKERS AI <b>·</b> WORKFLOWS <b>·</b> DURABLE OBJECTS <b>·</b> APPROVAL GATE</span></footer>
        </div>
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);
