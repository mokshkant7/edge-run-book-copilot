import { describe, expect, it } from "vitest";
import { aiLimitRequests, decideQuota, parseLimit, utcDay } from "../src/quota-logic";

describe("quota policy", () => {
  it("allows until any key reaches its limit, and reports which key blocked", () => {
    const requests = [
      { key: "global:ai", limit: 3 },
      { key: "client:a:ai", limit: 2 },
    ];
    expect(decideQuota({}, requests)).toEqual({ allowed: true });
    expect(decideQuota({ "global:ai": 2, "client:a:ai": 1 }, requests)).toEqual({ allowed: true });
    expect(decideQuota({ "global:ai": 2, "client:a:ai": 2 }, requests)).toEqual({ allowed: false, blockedBy: "client:a:ai" });
    expect(decideQuota({ "global:ai": 3, "client:a:ai": 0 }, requests)).toEqual({ allowed: false, blockedBy: "global:ai" });
  });

  it("parses configured limits with safe fallbacks", () => {
    expect(parseLimit("25", 60)).toBe(25);
    expect(parseLimit("0", 60)).toBe(0);
    expect(parseLimit(undefined, 60)).toBe(60);
    expect(parseLimit("abc", 60)).toBe(60);
    expect(parseLimit("-5", 60)).toBe(60);
    expect(aiLimitRequests("client:x", "10", undefined)).toEqual([
      { key: "global:ai", limit: 10 },
      { key: "client:x:ai", limit: 15 },
    ]);
  });

  it("rolls the budget over on the UTC day boundary", () => {
    expect(utcDay(Date.UTC(2026, 10, 6, 23, 59, 59))).toBe("2026-11-06");
    expect(utcDay(Date.UTC(2026, 10, 7, 0, 0, 0))).toBe("2026-11-07");
  });
});
