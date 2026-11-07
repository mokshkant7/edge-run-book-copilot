# Architecture

## Components

```mermaid
flowchart LR
  B[Browser<br/>React chat + workflow panel]
  W[Worker<br/>routing, origin guard, /api]
  A[ChatAgent<br/>Durable Object, SQLite<br/>chat, run state, audit log]
  Q[QuotaGate<br/>Durable Object<br/>daily budgets]
  F[DiagnosisWorkflow<br/>Cloudflare Workflows]
  L[Workers AI<br/>Llama 3.3 70B]
  R[(runbooks.json<br/>bundled)]

  B <-- WebSocket: chat + state sync --> A
  B -- POST /api/diagnose, /api/decision --> W
  W --> A
  W -- reserve workflow start --> Q
  A -- retrieval before model call --> R
  A -- reserve call --> Q
  A -- chat answer --> L
  A -- runWorkflow --> F
  F -- patchRun / writeAudit RPC --> A
  F -- reserve call --> Q
  F -- summary --> L
```

## Diagnosis workflow with the approval gate

```mermaid
sequenceDiagram
  actor Eng as Engineer
  participant UI as Browser
  participant Ag as ChatAgent (DO)
  participant Wf as DiagnosisWorkflow
  participant AI as Workers AI

  Eng->>UI: Run durable diagnosis
  UI->>Ag: POST /api/diagnose
  Ag->>Wf: runWorkflow(runId)
  Wf->>Wf: 1 retrieve runbook
  Wf->>Wf: 2 simulated diagnostics
  Wf->>AI: 3 summarize (if budget allows, else template)
  Wf->>Wf: 4 propose action (server allowlist + SHA-256 hash)
  Wf->>Ag: status = awaiting_approval (state sync to UI)
  Note over Wf: 5 waitForEvent("approval", 15 min). Nothing executes while paused
  Eng->>UI: Approve / Reject
  UI->>Ag: POST /api/decision (runId, hash)
  Ag->>Ag: run awaiting? not expired? hash matches?
  Ag->>Wf: approveWorkflow / rejectWorkflow
  Wf->>Wf: re-verify event + allowlist
  alt approved and verified
    Wf->>Ag: 6 record SIMULATED_ONLY action (idempotent)
    Wf->>Wf: 7 verify (simulated)
  else rejected, invalid, or timed out
    Wf->>Ag: status = rejected / timed_out, restart skipped
  end
```

## State and where it lives

| Data | Location | Notes |
|---|---|---|
| Chat transcript | `ChatAgent` SQLite | restored on reconnect |
| Workflow run view | `ChatAgent` state (SQLite, synced to clients) | last 10 runs |
| Audit log | `ChatAgent` SQLite `audit_log` | mirrored to state (last 30) |
| Simulated actions | `ChatAgent` SQLite `simulated_actions` | primary key = run id |
| Workflow step results | Cloudflare Workflows durable storage | resumes after restart |
| Daily usage counters | `QuotaGate` SQLite | hashed client keys (pseudonymous, no raw IPs stored) |
