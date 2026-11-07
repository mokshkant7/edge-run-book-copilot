import { describe, expect, it } from "vitest";
import { actionHash, buildProposal, isAllowedAction, safeEqual, verifyApproval } from "../src/policy";

const RUN = "11111111-1111-4111-8111-111111111111";

describe("allowlist", () => {
  it("accepts only the known demo services with the single mock action", () => {
    expect(isAllowedAction("origin-api", "simulate-restart")).toBe(true);
    expect(isAllowedAction("origin-api", "rm -rf /")).toBe(false);
    expect(isAllowedAction("prod-database", "simulate-restart")).toBe(false);
    expect(isAllowedAction("__proto__", "simulate-restart")).toBe(false);
    expect(isAllowedAction("constructor", "simulate-restart")).toBe(false);
  });

  it("refuses to build a proposal for a service that is not allowlisted", async () => {
    expect(await buildProposal(RUN, "prod-database", "x")).toBeNull();
    expect(await buildProposal(RUN, "toString", "x")).toBeNull();
  });
});

describe("approval gate", () => {
  it("allows the restart only for an approved event carrying the matching hash", async () => {
    const proposal = (await buildProposal(RUN, "origin-api", "Origin 5xx"))!;
    expect(proposal.hash).toBe(await actionHash(RUN, "origin-api", "simulate-restart"));
    expect(await verifyApproval(RUN, proposal, { approved: true, hash: proposal.hash })).toEqual({ ok: true });
  });

  it("blocks rejection, missing hash, wrong hash, and a hash from another run", async () => {
    const proposal = (await buildProposal(RUN, "origin-api", "Origin 5xx"))!;
    expect(await verifyApproval(RUN, proposal, { approved: false, hash: proposal.hash })).toEqual({ ok: false, reason: "not-approved" });
    expect(await verifyApproval(RUN, proposal, { approved: true })).toEqual({ ok: false, reason: "hash-mismatch" });
    expect(await verifyApproval(RUN, proposal, { approved: true, hash: "deadbeef" })).toEqual({ ok: false, reason: "hash-mismatch" });
    const other = await actionHash("22222222-2222-4222-8222-222222222222", "origin-api", "simulate-restart");
    expect(await verifyApproval(RUN, proposal, { approved: true, hash: other })).toEqual({ ok: false, reason: "hash-mismatch" });
  });

  it("blocks a tampered proposal even with a self-consistent hash", async () => {
    const forged = { service: "prod-database", action: "simulate-restart" as const, reason: "x", hash: await actionHash(RUN, "prod-database", "simulate-restart") };
    expect(await verifyApproval(RUN, forged, { approved: true, hash: forged.hash })).toEqual({ ok: false, reason: "action-not-allowed" });
  });

  it("safeEqual compares strings of equal content only", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
