import type { DiagnosticResult } from "./shared";

/**
 * Canned, clearly fictional diagnostic output. Nothing here is collected from
 * a real system; it exists so the workflow has something realistic to reason over.
 */
const SCENARIOS: Record<string, DiagnosticResult[]> = {
  "origin-5xx-after-deploy": [
    {
      label: "Error rate by release",
      command: "metrics query --service origin-api --group-by release",
      output: "release=2026.11.05-b  5xx=14.2%  p95=2.8s\nrelease=2026.11.04-a  5xx=0.3%   p95=210ms",
      finding: "Errors are concentrated in the newest release.",
    },
    {
      label: "Origin health endpoint",
      command: "curl -s -o /dev/null -w '%{http_code}' https://origin.demo.invalid/healthz",
      output: "503 (3 of 8 targets unhealthy)",
      finding: "A subset of targets fail health checks.",
    },
    {
      label: "Application logs",
      command: "logs tail --service origin-api --level error --since 15m",
      output: "connection pool exhausted: db-primary (max=20)\nconnection pool exhausted: db-primary (max=20)",
      finding: "Connection-pool exhaustion started right after the release.",
    },
  ],
  "dns-resolution-intermittent": [
    {
      label: "Resolver comparison",
      command: "dig demo.invalid @resolver-a @resolver-b @auth-ns1",
      output: "resolver-a: NOERROR 192.0.2.10 ttl=300\nresolver-b: SERVFAIL\nauth-ns1:   NOERROR 192.0.2.10 ttl=300",
      finding: "Authoritative answers are fine; one recursive resolver fails.",
    },
    {
      label: "DNSSEC validation",
      command: "delv demo.invalid +vtrace",
      output: "validation failure: RRSIG expired for demo.invalid (resolver-b)",
      finding: "An expired signature is seen by the failing resolver.",
    },
  ],
  "deployment-stall": [
    {
      label: "Last completed pipeline step",
      command: "pipeline status --run 4821",
      output: "step 5/8 'wait-for-readiness' running for 22m\nsteps 1-4 succeeded",
      finding: "Rollout is blocked waiting for readiness.",
    },
    {
      label: "Readiness by version",
      command: "metrics query --service app --group-by version --metric ready_ratio",
      output: "v1.18 ready=100%\nv1.19 ready=0% (0/4 instances)",
      finding: "No new-version instance passes readiness.",
    },
  ],
  "edge-cache-stale-content": [
    {
      label: "Header comparison",
      command: "curl -sI https://www.demo.invalid/ (region-a, region-b)",
      output: "region-a: age=86012 cache-control=max-age=86400\nregion-b: age=12    cache-control=max-age=86400",
      finding: "Region A holds an entry that is a day old.",
    },
    {
      label: "Purge status",
      command: "cache purge-status --id demo-9921",
      output: "accepted 41m ago; propagated to 6/9 locations",
      finding: "Purge is only partially propagated.",
    },
  ],
};

/** @returns Canned diagnostics for a runbook id, or an empty list when none are defined. */
export function mockDiagnostics(runbookId: string): DiagnosticResult[] {
  return SCENARIOS[runbookId] ?? [];
}
