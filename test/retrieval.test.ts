import { describe, expect, it } from "vitest";
import { RUNBOOKS, searchRunbooks, tokenize } from "../src/retrieval";

const top = (query: string) => searchRunbooks(query)[0]?.runbook.id;

describe("tokenize", () => {
  it("drops stopwords and one/two letter tokens that used to match everything", () => {
    expect(tokenize("What should I check? a is to")).toEqual([]);
  });

  it("normalises plurals, 502s and the 5xx class", () => {
    expect(tokenize("502s")).toContain("502");
    expect(tokenize("502")).toContain("5xx");
    expect(tokenize("requests")).toEqual(tokenize("request"));
  });
});

describe("searchRunbooks", () => {
  it("routes the four sample incidents to the right runbook", () => {
    expect(top("API requests began returning 502s after a release. What should I check?")).toBe("origin-5xx-after-deploy");
    expect(top("Users report intermittent DNS lookup failures for a hostname.")).toBe("dns-resolution-intermittent");
    expect(top("A deployment is stuck and new instances are failing readiness checks.")).toBe("deployment-stall");
    expect(top("Users see old page content in one region even after a cache purge.")).toBe("edge-cache-stale-content");
  });

  it("does not return every runbook for generic text (previously always returned all)", () => {
    const hits = searchRunbooks("API requests began returning 502s after a release. What should I check?");
    expect(hits[0]?.runbook.id).toBe("origin-5xx-after-deploy");
    expect(hits.length).toBeLessThan(RUNBOOKS.length);
    if (hits.length > 1) expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("returns nothing for unrelated or stopword-only queries", () => {
    expect(searchRunbooks("what is the weather like in paris")).toEqual([]);
    expect(searchRunbooks("a i is to the")).toEqual([]);
    expect(searchRunbooks("")).toEqual([]);
  });

  it("is case and punctuation insensitive", () => {
    expect(top("SERVFAIL!!! from resolver, NXDOMAIN sometimes")).toBe("dns-resolution-intermittent");
  });

  it("matches a trailing-dot token like 'release.' (old regex kept the dot)", () => {
    expect(top("errors started after the release.")).toBe("origin-5xx-after-deploy");
  });
});
