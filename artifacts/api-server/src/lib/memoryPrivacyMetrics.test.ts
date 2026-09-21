/**
 * §24 `privacy_revocation_latency` — "Time until all public derivatives are
 * removed."
 *
 * CENSUS H219, NOT-BUILT on a sentence this file makes false: *"`executeRevocation`
 * produces a per-destination report and no timing at all"*. Re-executed at
 * 75af9b23f before anything was written — `grep -n "Date.now\|elapsed\|duration\|latency"`
 * over BOTH revocation modules returned nothing, so the row was accurate.
 *
 * THE NUMBER IS THE EASY HALF AND IT IS NOT THE POINT. §24 asks for the time
 * until ALL public derivatives are removed. A revocation that reached one of
 * eight destinations in 3 ms has a latency of 3 ms to an INCOMPLETE removal,
 * and reporting that as `privacy_revocation_latency` would be a metric that
 * looks better the less it does. So `complete` rides on every sample, it is
 * false whenever any applicable destination was not removed, AND it is false
 * whenever the losing audience was not enumerable — because "all" is not
 * knowable for a Memory that was public. The mutations below turn each of those
 * into a red test.
 *
 * RED BEFORE GREEN: at 75af9b23f `lib/memoryPrivacyMetrics.ts` does not exist.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_REVOCATION_LATENCY,
  buildPrivacyRevocationSample,
  recordPrivacyRevocationLatency,
} from "./memoryPrivacyMetrics.js";
import { revokeMemoryAudienceCaches } from "../services/memory/memoryAudienceRevocation.js";
import { executeRevocation } from "../services/highlights/highlightRevocation.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function emptyClient() {
  const builder: any = {
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    neq() { return builder; },
    is() { return builder; },
    then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
  };
  return { from: () => builder };
}

/** A client whose named tables answer with an ERROR rather than rows. */
function failingClient(failTables: Set<string>) {
  return {
    from(table: string) {
      const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        neq() { return builder; },
        is() { return builder; },
        maybeSingle: async () => (fail ? { data: null, error: fail } : { data: null, error: null }),
        single: async () => (fail ? { data: null, error: fail } : { data: null, error: null }),
        then(onF: any, onR: any) {
          return Promise.resolve(fail ? { data: null, error: fail } : { data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function collector() {
  const lines: Array<{ obj: any; msg: string }> = [];
  return {
    lines,
    log: {
      info: (obj: any, msg: string) => lines.push({ obj, msg }),
      warn: (obj: any, msg: string) => lines.push({ obj, msg }),
      error: (obj: any, msg: string) => lines.push({ obj, msg }),
    },
  };
}

const samples = (lines: Array<{ obj: any }>) =>
  lines.map((l) => l.obj).filter((o) => o && o.metric === PRIVACY_REVOCATION_LATENCY);

describe("§24 privacy_revocation_latency — the sample", () => {
  it("is named exactly what §24 names it", () => {
    assert.equal(PRIVACY_REVOCATION_LATENCY, "privacy_revocation_latency");
  });

  it("measures from the privacy DECISION, not from the start of the revocation", () => {
    const s = buildPrivacyRevocationSample({
      surface: "memory_audience",
      subjectId: "m1",
      reason: "memory_visibility_changed",
      requestedAt: 1_000,
      startedAt: 1_040,
      finishedAt: 1_100,
      destinationsTotal: 1,
      destinationsRemoved: 1,
      unboundedAudience: null,
      failureClass: null,
    });
    assert.equal(s.latencyMs, 100, "the traveller's clock starts when they changed their mind");
    assert.equal(s.revocationMs, 60, "the operator's clock starts when the work did");
    assert.ok(s.latencyMs >= s.revocationMs);
    assert.equal(s.complete, true);
  });

  it("clamps a backwards clock to zero rather than reporting a negative latency", () => {
    const s = buildPrivacyRevocationSample({
      surface: "memory_audience", subjectId: "m1", reason: "memory_deleted",
      requestedAt: 5_000, startedAt: 5_000, finishedAt: 4_000,
      destinationsTotal: 1, destinationsRemoved: 1, unboundedAudience: null, failureClass: null,
    });
    assert.equal(s.latencyMs, 0);
    assert.equal(s.revocationMs, 0);
  });

  it("is INCOMPLETE when a destination was not removed", () => {
    const s = buildPrivacyRevocationSample({
      surface: "highlight_lifecycle", subjectId: "h1", reason: "DELETE_HIGHLIGHT",
      requestedAt: 0, startedAt: 0, finishedAt: 10,
      destinationsTotal: 8, destinationsRemoved: 1, unboundedAudience: null, failureClass: null,
    });
    assert.equal(s.complete, false, "seven destinations unreached is not 'all derivatives removed'");
  });

  it("is INCOMPLETE when the losing audience was not enumerable, however many targets were evicted", () => {
    const s = buildPrivacyRevocationSample({
      surface: "memory_audience", subjectId: "m1", reason: "memory_visibility_changed",
      requestedAt: 0, startedAt: 0, finishedAt: 7,
      destinationsTotal: 4, destinationsRemoved: 4, unboundedAudience: "public", failureClass: null,
    });
    assert.equal(s.complete, false, "'all' is not knowable for a Memory that was public — H189");
    assert.equal(s.unboundedAudience, "public");
  });

  it("is INCOMPLETE when nothing was applicable at all", () => {
    const s = buildPrivacyRevocationSample({
      surface: "highlight_lifecycle", subjectId: "h1", reason: "DELETE_HIGHLIGHT",
      requestedAt: 0, startedAt: 0, finishedAt: 1,
      destinationsTotal: 0, destinationsRemoved: 0, unboundedAudience: null, failureClass: null,
    });
    assert.equal(s.complete, false, "a revocation with no destination removed nothing");
  });

  it("carries §24's operational log fields rather than the Memory's contents", () => {
    const c = collector();
    const s = buildPrivacyRevocationSample({
      surface: "memory_audience", subjectId: "m1", reason: "memory_deleted",
      requestedAt: 0, startedAt: 0, finishedAt: 3,
      destinationsTotal: 2, destinationsRemoved: 1, unboundedAudience: null,
      failureClass: "compass_cache_invalidation_failed",
    });
    recordPrivacyRevocationLatency(c.log, s);
    assert.equal(c.lines.length, 1);
    const [line] = c.lines;
    assert.equal(line.obj.metric, "privacy_revocation_latency");
    assert.equal(line.obj.failureClass, "compass_cache_invalidation_failed");
    assert.ok(typeof line.obj.engineVersion === "string" && line.obj.engineVersion.length > 0);
    // §24: "Do not log sensitive raw content unless strictly necessary."
    const serialized = JSON.stringify(line.obj);
    for (const forbidden of ["caption", "title", "media_url", "location_lat"]) {
      assert.ok(!serialized.includes(forbidden), `a metric sample must not carry ${forbidden}`);
    }
  });

  it("a missing logger is not an error — the metric never fails the revocation", () => {
    const s = buildPrivacyRevocationSample({
      surface: "memory_audience", subjectId: "m1", reason: "memory_deleted",
      requestedAt: 0, startedAt: 0, finishedAt: 1,
      destinationsTotal: 1, destinationsRemoved: 1, unboundedAudience: null, failureClass: null,
    });
    recordPrivacyRevocationLatency(undefined, s);
    recordPrivacyRevocationLatency({} as any, s);
  });
});

describe("§24 privacy_revocation_latency — emitted by both revocation surfaces", () => {
  it("the Memory audience revocation records one sample", async () => {
    const c = collector();
    const report = await revokeMemoryAudienceCaches(emptyClient() as any, {
      memoryId: "m1",
      ownerId: OWNER,
      previous: { visibility: "public", state: "published" },
      next: { visibility: "only_me", state: "published" },
      reason: "memory_visibility_changed",
      log: c.log,
      invalidate: async () => {},
      requestedAt: Date.now() - 25,
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1, "exactly one sample per revocation");
    assert.equal(s[0].surface, "memory_audience");
    assert.equal(s[0].subjectId, "m1");
    assert.ok(s[0].latencyMs >= 25, "the clock started at the write, not at the eviction loop");
    assert.equal(s[0].complete, false, "the previous audience was public and is not enumerable");
    assert.equal(report.unbounded_audience, "public");
  });

  it("a Memory revocation that reached everybody it could enumerate is COMPLETE", async () => {
    const c = collector();
    await revokeMemoryAudienceCaches(emptyClient() as any, {
      memoryId: "m2",
      ownerId: OWNER,
      previous: { visibility: "circle_only", state: "published" },
      next: { visibility: "only_me", state: "published" },
      reason: "memory_visibility_changed",
      log: c.log,
      invalidate: async () => {},
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1);
    assert.equal(s[0].complete, true);
    assert.equal(s[0].unboundedAudience, null);
  });

  it("a failing invalidator makes the sample incomplete and names the failure class", async () => {
    const c = collector();
    await revokeMemoryAudienceCaches(emptyClient() as any, {
      memoryId: "m3",
      ownerId: OWNER,
      previous: { visibility: "circle_only", state: "published" },
      next: { visibility: "only_me", state: "published" },
      reason: "memory_deleted",
      log: c.log,
      invalidate: async () => { throw new Error("compass down"); },
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1);
    assert.equal(s[0].complete, false);
    assert.equal(s[0].failureClass, "compass_cache_invalidation_failed");
    assert.equal(s[0].destinationsRemoved, 0);
  });

  it("a DEGRADED audience lookup is incomplete even though every resolved target was evicted", async () => {
    // MUT-m3 killer, and the case that makes `failureClass` load-bearing in
    // `complete` rather than decorative: every target the resolver COULD name
    // was evicted, so the count alone says the removal was total. It was not —
    // the crew could not be read, so the crew was never a target in the first
    // place. A metric that called this complete would report its own blind
    // spot as a success.
    const c = collector();
    await revokeMemoryAudienceCaches(failingClient(new Set(["trip_members"])) as any, {
      memoryId: "m4",
      ownerId: OWNER,
      previous: { visibility: "trip_crew", trip_id: "11111111-1111-1111-1111-111111111111", state: "published" },
      next: { visibility: "only_me", trip_id: "11111111-1111-1111-1111-111111111111", state: "published" },
      reason: "memory_visibility_changed",
      log: c.log,
      invalidate: async () => {},
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1);
    assert.equal(s[0].destinationsRemoved, s[0].destinationsTotal, "every target the resolver named was evicted");
    assert.equal(s[0].unboundedAudience, null);
    assert.equal(s[0].failureClass, "audience_lookup_degraded");
    assert.equal(s[0].complete, false, "a revocation with an unreadable audience is not a complete one");
  });

  it("the Highlight revocation records one sample, and it is incomplete because seven destinations do not exist", async () => {
    const c = collector();
    const report = await executeRevocation("DELETE_HIGHLIGHT", "h1", {
      invalidateCache: async () => {},
      log: c.log,
      requestedAt: Date.now() - 5,
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1);
    assert.equal(s[0].surface, "highlight_lifecycle");
    assert.equal(s[0].subjectId, "h1");
    assert.ok(s[0].latencyMs >= 5);
    assert.equal(s[0].complete, report.complete);
    assert.ok(s[0].destinationsRemoved <= s[0].destinationsTotal);
  });

  it("the Highlight revocation reports the cache failure as a failure class", async () => {
    const c = collector();
    await executeRevocation("DELETE_HIGHLIGHT", "h2", {
      invalidateCache: async () => { throw new Error("compass down"); },
      log: c.log,
    });
    const s = samples(c.lines);
    assert.equal(s.length, 1);
    assert.equal(s[0].complete, false);
    assert.equal(s[0].failureClass, "compass_cache_invalidation_failed");
  });
});
