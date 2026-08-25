/**
 * liveClaimRead (IG-05) — three fail-closed gates before anything is shown live.
 *
 * The property under test is that "unknown" is the only fallback. A surface may
 * never render a stale, ineligible or low-confidence claim as current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readLiveClaims,
  readLiveCrowdLevel,
  readLiveClaimEnvelopes,
  toLiveClaimEnvelope,
  type LiveClaim,
} from "../lib/liveClaimRead.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();
const PAST = new Date(NOW.getTime() - 30 * 60_000).toISOString();

/**
 * Records the filters applied so we can assert the query itself is safe.
 * Flag-aware: `flag` drives intel_live_label_crowd; the IG-09 gates default to
 * the live-allowed state (kill off, pilot on) so the downstream-logic cases keep
 * exercising the snapshot/confidence/expiry path. `kill`/`pilot` override them.
 */
function client(opts: { flag: boolean | null; rows?: any[]; error?: boolean; kill?: boolean; pilot?: boolean }) {
  const filters: Record<string, unknown> = {};
  const api: any = {
    filters,
    from(table: string) {
      if (table === "feature_flags") {
        let flagName = "";
        const fq: any = {
          select: () => fq,
          eq: (k: string, v: unknown) => { if (k === "flag") flagName = String(v); return fq; },
          maybeSingle: async () => {
            if (flagName === "disable_intel_live_labels") return { data: { enabled: opts.kill ?? false }, error: null };
            if (flagName === "intel_limited_live") return { data: { enabled: opts.pilot ?? true }, error: null };
            // intel_live_label_crowd (and anything else) tracks `flag`
            return { data: opts.flag === null ? null : { enabled: opts.flag }, error: null };
          },
        };
        return fq;
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

describe("liveClaimRead — IG-09 limited-live gates (kill switch + pilot)", () => {
  it("suppresses every Live label when the emergency stop is engaged", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: true, kill: true, rows: [liveRow] }), "p1", { now: NOW }), []);
  });
  it("shows nothing until a pilot scope is promoted (intel_limited_live off)", async () => {
    assert.deepEqual(await readLiveClaims(client({ flag: true, pilot: false, rows: [liveRow] }), "p1", { now: NOW }), []);
  });
  it("flows through when the label flag is on, the stop is clear and the pilot is enabled", async () => {
    const r = await readLiveClaims(client({ flag: true, kill: false, pilot: true, rows: [liveRow] }), "p1", { now: NOW });
    assert.equal(r.length, 1);
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

// ── liveClaims read path (placeLiving.liveClaims) ─────────────────────────────

const idRow = { ...liveRow, id: "snap-crowd-1" };

describe("readLiveClaimEnvelopes — rich decision-exposure response", () => {
  it("returns a full envelope: value, confidence/band, source class, times, live state, provenance id", async () => {
    const [env] = await readLiveClaimEnvelopes(client({ flag: true, rows: [idRow] }), "p1", { now: NOW });
    assert.ok(env, "expected one envelope");
    assert.equal(env.id, "snap-crowd-1");
    assert.equal(env.claimType, "crowd.level");
    assert.deepEqual(env.value, { level: "busy" });
    assert.equal(env.confidence, 0.8);
    assert.equal(env.band, "live");
    assert.equal(env.sourceClass, "firsthand_unverified"); // Phase-1 derived, never fabricated
    assert.equal(env.sourceCount, 20);
    assert.equal(env.observedAt, PAST);
    assert.equal(env.validUntil, FUTURE); // expires_at surfaced as freshness horizon
    assert.equal(env.state, "live");
  });

  it("returns [] when there is no qualifying live intelligence", async () => {
    assert.deepEqual(await readLiveClaimEnvelopes(client({ flag: true, rows: [] }), "p1", { now: NOW }), []);
  });

  it("returns [] when the flag is off (inert, additive to crowdLevel)", async () => {
    assert.deepEqual(await readLiveClaimEnvelopes(client({ flag: false, rows: [idRow] }), "p1", { now: NOW }), []);
  });

  it("excludes stale and non-exposable claims IN THE QUERY, not in memory", async () => {
    // The eligibility + freshness gates are the query's job; a private or expired
    // row must never leave the database. (Stale rows are dropped by gt:expires_at;
    // ineligible rows by privacy_eligible.)
    const c = client({ flag: true, rows: [idRow] });
    await readLiveClaimEnvelopes(c, "p1", { now: NOW });
    assert.equal(c.filters["privacy_eligible"], true);
    assert.equal(c.filters["gt:expires_at"], NOW.toISOString());
  });

  it("emits only derived intelligence — no contributor id, coordinates or k-anon internals", async () => {
    // Even when the projection row carries private evidence, the envelope must not.
    const leaky = {
      ...idRow,
      actor_id: "user-123",
      lat: 51.5,
      lng: -0.12,
      distinct_actors: 3,
      visibility: "private",
      presence_attestation: { nonce: "x" },
    };
    const [env] = await readLiveClaimEnvelopes(client({ flag: true, rows: [leaky] }), "p1", { now: NOW });
    assert.deepEqual(
      Object.keys(env).sort(),
      ["band", "claimType", "confidence", "id", "observedAt", "sourceClass", "sourceCount", "state", "validUntil", "value"],
    );
  });
});

describe("readLiveClaimEnvelopes — deterministic ordering (best/current first)", () => {
  it("orders by confidence desc, then recency", async () => {
    const older = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    const newer = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const rows = [
      { id: "a", claim_type: "crowd.level", value: { level: "busy" }, confidence: 0.78, source_count: 5, observed_at: older, expires_at: FUTURE, privacy_eligible: true },
      { id: "b", claim_type: "queue.wait", value: { minMinutes: 10, maxMinutes: 20 }, confidence: 0.92, source_count: 9, observed_at: older, expires_at: FUTURE, privacy_eligible: true },
      { id: "c", claim_type: "crowd.trajectory", value: { trajectory: "peaking" }, confidence: 0.78, source_count: 4, observed_at: newer, expires_at: FUTURE, privacy_eligible: true },
    ];
    const envs = await readLiveClaimEnvelopes(client({ flag: true, rows }), "p1", { now: NOW });
    // b (0.92) first; then the two 0.78s, newer (c) before older (a).
    assert.deepEqual(envs.map((e) => e.id), ["b", "c", "a"]);
  });
});

describe("toLiveClaimEnvelope — pure mapping", () => {
  it("maps expiresAt → validUntil and stamps live state, dropping nothing else", () => {
    const claim: LiveClaim = {
      id: "s1", claimType: "queue.wait", value: { minMinutes: 0, maxMinutes: 10 },
      confidence: 0.9, band: "strong", sourceClass: "firsthand_unverified",
      sourceCount: 7, observedAt: PAST, expiresAt: FUTURE,
    };
    assert.deepEqual(toLiveClaimEnvelope(claim), {
      id: "s1", claimType: "queue.wait", value: { minMinutes: 0, maxMinutes: 10 },
      confidence: 0.9, band: "strong", sourceClass: "firsthand_unverified",
      sourceCount: 7, observedAt: PAST, validUntil: FUTURE, state: "live",
    });
  });
});

describe("liveClaims ↔ crowdLevel compatibility (one projection, two reads)", () => {
  it("crowdLevel and liveClaims agree, and both come from the same snapshot", async () => {
    const c1 = client({ flag: true, rows: [idRow] });
    const level = await readLiveCrowdLevel(c1, "p1", { now: NOW });
    const c2 = client({ flag: true, rows: [idRow] });
    const [env] = await readLiveClaimEnvelopes(c2, "p1", { now: NOW });
    assert.equal(level, "busy");
    assert.equal((env.value as any).level, level);
    assert.equal(env.claimType, "crowd.level");
  });

  it("with the flag off, crowdLevel is null AND liveClaims is [] (backward-compatible)", async () => {
    assert.equal(await readLiveCrowdLevel(client({ flag: false, rows: [idRow] }), "p1", { now: NOW }), null);
    assert.deepEqual(await readLiveClaimEnvelopes(client({ flag: false, rows: [idRow] }), "p1", { now: NOW }), []);
  });
});
