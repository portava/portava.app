/**
 * IG-03 capture — the producer the projection/read path were waiting for.
 *
 * Runs entirely in memory against a fake client (mirrors intelPipeline.test.ts).
 * Proves: the flag gates everything; captures are idempotent; the observed-at
 * clamp, claim-type and value validators fail closed; the 0-rows-places blocker
 * surfaces as `unknown_subject` (not an FK 500); confirmations are one-per-actor;
 * a correction supersedes rather than rewrites; and the §6 throttle suppresses a
 * second unsolicited prompt and anything during a safety state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  writeObservation, proposeClaim, approveClaim, confirmClaim, correctClaim,
} from "../services/intel/IntelCaptureService.js";
import { mapQuickSignal, validateClaimValue } from "../lib/quickSignal.js";
import { shouldPrompt } from "../lib/intelThrottle.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();                                    // throttle math uses this explicitly
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString(); // clampObservedAt uses the real clock

/** A fake supabase client sufficient for the capture service's exact chains. */
function makeDb(flags: Record<string, boolean>, opts: { places?: string[] } = {}) {
  const tables: Record<string, any[]> = { intel_observations: [], intel_claims: [], intel_confirmations: [] };
  const places = new Set(opts.places ?? []);
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" | "update" = "select";
    let payload: any = null;
    const filters: [string, any][] = [];
    const match = (row: any) => filters.every(([c, v]) => row[c] === v);

    function run() {
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean(flags[flag]) }, error: null };
      }
      if (table === "places") {
        const id = filters.find(([c]) => c === "id")?.[1];
        return { data: places.has(id) ? { id } : null, error: null };
      }
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: NOW.toISOString(), ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key))
          return { data: null, error: { code: "23505", message: "duplicate observation" } };
        if (table === "intel_confirmations" && store.some((r) => r.claim_id === row.claim_id && r.actor_id === row.actor_id))
          return { data: null, error: { code: "23505", message: "duplicate confirmation" } };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      if (op === "update") {
        for (const r of store) if (match(r)) Object.assign(r, payload);
        return { data: null, error: null };
      }
      return { data: store.filter(match)[0] ?? null, error: null };
    }

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { filters.push([c, v]); return b; },
      maybeSingle() { return Promise.resolve(run()); },
      single() { return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables };
}

const baseInput = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  claimType: "crowd.level",
  value: { level: "busy" as const },
  observedAt: OBSERVED,
  idempotencyKey: "obs-key-1",
  ...over,
});

describe("IG-03 capture — flag gate + validation fail closed", () => {
  it("flag OFF is an inert no-op — nothing stored", async () => {
    const db = makeDb({ intel_capture_quick_signal: false }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("writes a valid observation with defaults (presence P0, visibility private)", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    assert.equal(obs.presence_level, "P0");
    assert.equal(obs.visibility, "private");
    assert.equal(obs.source_class, "firsthand_unverified");
    assert.equal(obs.capture_surface, "quick_signal");
    assert.ok(obs.expires_at, "an expiry is derived from the claim TTL");
  });

  it("is idempotent — a replay returns the stored row, no duplicate", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    await writeObservation(db as any, ACTOR, baseInput() as any);
    const again = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(again.ok, true);
    assert.equal((again as any).deduped, true);
    assert.equal(db._tables.intel_observations.length, 1);
  });

  it("rejects a far-future observed_at (fail-closed against permanent freshness)", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const r = await writeObservation(db as any, ACTOR, baseInput({ observedAt: future }) as any);
    assert.equal((r as any).reason, "invalid_observed_at");
  });

  it("rejects an unknown claim_type and a malformed value", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    assert.equal((await writeObservation(db as any, ACTOR, baseInput({ claimType: "made.up" }) as any) as any).reason, "invalid_claim_type");
    assert.equal((await writeObservation(db as any, ACTOR, baseInput({ value: { level: "nope" } }) as any) as any).reason, "invalid_value");
  });

  it("surfaces the 0-rows-places blocker as unknown_subject, never an FK 500", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [] }); // places empty (prod today)
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal((r as any).reason, "unknown_subject");
    assert.equal(db._tables.intel_observations.length, 0);
  });
});

describe("IG-03 — Quick Signal mapping + specialist safety", () => {
  it("maps §6 options to canonical claims (good energy -> moderate)", () => {
    assert.deepEqual(mapQuickSignal("arrival", "good energy"), { claimType: "crowd.level", value: { level: "moderate" } });
    assert.deepEqual(mapQuickSignal("entrance", "10-20"), { claimType: "queue.wait", value: { minMinutes: 10, maxMinutes: 20 } });
    assert.deepEqual(mapQuickSignal("inside", "peaking"), { claimType: "crowd.trajectory", value: { trajectory: "peaking" } });
  });

  it("never produces or accepts unsafe_density from an ordinary Quick Signal", () => {
    assert.equal(mapQuickSignal("arrival", "unsafe_density"), null);
    assert.equal(validateClaimValue("crowd.level", { level: "unsafe_density" }), false);
  });
});

describe("IG-03 — claim lifecycle", () => {
  it("propose -> approve -> confirm (one per actor) and correct supersedes", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const written = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(written.ok, true);
    const proposed = await proposeClaim(db as any, (written as any).observation);
    assert.equal(proposed.ok, true);
    assert.equal(proposed.claim.status, "candidate");
    const claimId = proposed.claim.id;

    assert.equal((await approveClaim(db as any, claimId)).ok, true);
    assert.equal(db._tables.intel_claims.find((c) => c.id === claimId).status, "active");

    assert.equal((await confirmClaim(db as any, claimId, "33333333-3333-4333-8333-333333333333", "agree", OBSERVED)).ok, true);
    const dup = await confirmClaim(db as any, claimId, "33333333-3333-4333-8333-333333333333", "agree", OBSERVED);
    assert.equal(dup.deduped, true);
    assert.equal(db._tables.intel_confirmations.length, 1);

    const corr = await correctClaim(db as any, ACTOR, claimId, baseInput({ value: { level: "quiet" }, idempotencyKey: "obs-key-2" }) as any);
    assert.equal(corr.ok, true);
    assert.equal((corr as any).supersededPrior, true);
    assert.equal(db._tables.intel_claims.find((c) => c.id === claimId).status, "superseded");
    assert.equal(db._tables.intel_observations.length, 2, "correction appended a new observation, did not rewrite");
  });
});

describe("IG-03 — prompt throttle (§6)", () => {
  const subjectId = PLACE;
  it("allows a prompt when nothing recent and no fresh evidence", () => {
    assert.equal(shouldPrompt({ subjectId, recentObservations: [], hasFreshQualifyingEvidence: false, now: NOW }).prompt, true);
  });
  it("suppresses a second prompt within 45 minutes", () => {
    const recent = [{ subjectId, observedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }];
    assert.equal(shouldPrompt({ subjectId, recentObservations: recent, hasFreshQualifyingEvidence: false, now: NOW }).reason, "throttled");
  });
  it("suppresses during a safety state and while paused", () => {
    assert.equal(shouldPrompt({ subjectId, recentObservations: [], hasFreshQualifyingEvidence: false, now: NOW, state: { safeReturnActive: true } }).reason, "safety_state");
    assert.equal(shouldPrompt({ subjectId, recentObservations: [], hasFreshQualifyingEvidence: false, now: NOW, state: { paused: true } }).reason, "paused");
  });
  it("does not prompt when fresh qualifying evidence already exists", () => {
    assert.equal(shouldPrompt({ subjectId, recentObservations: [], hasFreshQualifyingEvidence: true, now: NOW }).reason, "fresh_evidence_exists");
  });
});
