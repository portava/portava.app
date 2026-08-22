/**
 * liveClaimRead (IG-05) — three fail-closed gates before anything is shown live.
 *
 * The property under test is that "unknown" is the only fallback. A surface may
 * never render a stale, ineligible or low-confidence claim as current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readLiveClaims, readLiveCrowdLevel } from "../lib/liveClaimRead.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();
const PAST = new Date(NOW.getTime() - 30 * 60_000).toISOString();

/** Records the filters applied so we can assert the query itself is safe. */
function client(opts: { flag: boolean | null; rows?: any[]; error?: boolean }) {
  const filters: Record<string, unknown> = {};
  const api: any = {
    filters,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === null ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      if (table === "intel_state_snapshots") {
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { filters[k] = v; return q; },
          gt: (k: string, v: unknown) => { filters[`gt:${k}`] = v; return q; },
          in: (k: string, v: unknown) => { filters[`in:${k}`] = v; return q; },
          then: undefined,
        };
        // make it awaitable
        return Object.assign(q, {
          then: (res: any) => res(opts.error
            ? { data: null, error: { message: "boom" } }
            : { data: opts.rows ?? [], error: null }),
        });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return api;
}

const liveRow = {
  claim_type: "crowd.level", value: { level: "busy" }, confidence: 0.8,
  source_count: 20, observed_at: PAST, expires_at: FUTURE, privacy_eligible: true,
};

describe("liveClaimRead — gate 1: the flag", () => {
  it("returns nothing when the flag is off", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: false, rows: [liveRow] }), "p1", { now: NOW }), []);
  });
  it("returns nothing when the flag row is absent", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: null, rows: [liveRow] }), "p1", { now: NOW }), []);
  });
  it("returns nothing without a subject id", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: true, rows: [liveRow] }), null, { now: NOW }), []);
  });
});

describe("liveClaimRead — gate 2 and 3 are applied in the query itself", () => {
  it("filters on privacy_eligible and unexpired, not just in memory", async () => {
    const c = client({ flag: true, rows: [liveRow] });
    await readLiveClaims(c, "p1", { now: NOW });
    assert.equal(c.filters["privacy_eligible"], true, "an ineligible row must never leave the database");
    assert.equal(c.filters["subject_id"], "p1");
    assert.equal(c.filters["gt:expires_at"], NOW.toISOString(), "expired snapshots must be excluded by the query");
  });

  it("scopes to requested claim types when given", async () => {
    const c = client({ flag: true, rows: [liveRow] });
    await readLiveClaims(c, "p1", { claimTypes: ["crowd.level"], now: NOW });
    assert.deepEqual(c.filters["in:claim_type"], ["crowd.level"]);
  });
});

describe("liveClaimRead — confidence floor", () => {
  it("returns a claim at or above the live floor", async () => {
    const r = await readLiveClaims(client({ flag: true, rows: [liveRow] }), "p1", { now: NOW });
    assert.equal(r.length, 1);
    assert.equal(r[0].band, "live");
  });

  it("drops a claim below the live floor rather than showing it weakly", async () => {
    const weak = { ...liveRow, confidence: 0.2 };
    assert.deepEqual(await readLiveClaims(client({ flag: true, rows: [weak] }), "p1", { now: NOW }), []);
  });

  it("drops a claim with no confidence at all", async () => {
    const none = { ...liveRow, confidence: null };
    assert.deepEqual(await readLiveClaims(client({ flag: true, rows: [none] }), "p1", { now: NOW }), []);
  });
});

describe("liveClaimRead — failure is 'unknown', never 'last known'", () => {
  it("returns nothing when the projection read errors", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: true, error: true }), "p1", { now: NOW }), []);
  });

  it("readLiveCrowdLevel returns null in every suppressed case", async () => {
    assert.equal(await readLiveCrowdLevel(client({ flag: false, rows: [liveRow] }), "p1", { now: NOW }), null);
    assert.equal(await readLiveCrowdLevel(client({ flag: true, error: true }), "p1", { now: NOW }), null);
    assert.equal(await readLiveCrowdLevel(client({ flag: true, rows: [] }), "p1", { now: NOW }), null);
  });

  it("readLiveCrowdLevel returns the level when everything passes", async () => {
    assert.equal(await readLiveCrowdLevel(client({ flag: true, rows: [liveRow] }), "p1", { now: NOW }), "busy");
  });
});
