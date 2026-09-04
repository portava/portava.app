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
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  writeObservation, proposeClaim, approveClaim, confirmClaim, correctClaim,
  resolvePresenceAttestation,
} from "../services/intel/IntelCaptureService.js";
import { logger } from "../lib/logger.js";
import { mapQuickSignal, validateClaimValue } from "../lib/quickSignal.js";
import { shouldPrompt } from "../lib/intelThrottle.js";
import { PRESENCE_LEVELS, MIN_PRESENCE_FOR_LIVE_CLAIM } from "../lib/intelContracts.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();                                    // throttle math uses this explicitly
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString(); // clampObservedAt uses the real clock

/** A fake supabase client sufficient for the capture service's exact chains. */
function makeDb(flags: Record<string, boolean>, opts: { places?: string[]; consent?: boolean | "withdrawn" } = {}) {
  const tables: Record<string, any[]> = { intel_observations: [], intel_claims: [], intel_confirmations: [], intel_state_snapshots: [] };
  const places = new Set(opts.places ?? []);
  // Consent defaults to granted so the D4 gate is satisfied for the capture-focused
  // cases; the consent gate itself is exercised explicitly below and in intelConsent.test.
  const consent = opts.consent ?? true;
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" | "update" | "update_select" = "select";
    let payload: any = null;
    let single = false;
    const filters: [string, any, string?][] = [];
    const match = (row: any) =>
      filters.every(([c, v, kind]) => (kind === "in" ? (v as any[]).includes(row[c]) : row[c] === v));

    function run() {
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean(flags[flag]) }, error: null };
      }
      if (table === "places") {
        const id = filters.find(([c]) => c === "id")?.[1];
        return { data: places.has(id) ? { id } : null, error: null };
      }
      if (table === "intel_contribution_consent") {
        if (consent === false) return { data: null, error: null };            // no consent row
        if (consent === "withdrawn") return { data: { enabled: false, withdrawn_at: NOW.toISOString() }, error: null };
        return { data: { enabled: true, withdrawn_at: null }, error: null };  // granted
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
      if (op === "update" || op === "update_select") {
        const updated: any[] = [];
        for (const r of store) if (match(r)) { Object.assign(r, payload); updated.push(r); }
        return { data: op === "update_select" ? updated : null, error: null };
      }
      // A plain awaited select is a LIST (PostgREST shape); maybeSingle/single narrow it.
      return { data: single ? (store.filter(match)[0] ?? null) : store.filter(match), error: null };
    }

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : op === "update" ? "update_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { filters.push([c, v]); return b; },
      in(c: string, v: any[]) { filters.push([c, v, "in"]); return b; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
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

describe("IG-03 capture — presence attestation gate (H2)", () => {
  const rank = (lvl: string) => PRESENCE_LEVELS.indexOf(lvl as (typeof PRESENCE_LEVELS)[number]);
  const liveFloor = rank(MIN_PRESENCE_FOR_LIVE_CLAIM);

  it("a forged live-grade presence (P4) with no attestation is NOT stored/weighted as live-grade", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput({ presenceLevel: "P4" }) as any);
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    // The stored level is the one the projection layer WEIGHTS (PRESENCE_STRENGTH).
    // It must sit below the live floor, so a forged P4 can never buy live-grade
    // confidence. (Removing the gate stores P4 and this assertion fails — the mutant.)
    assert.ok(rank(obs.presence_level) < liveFloor,
      `forged P4 must be clamped below ${MIN_PRESENCE_FOR_LIVE_CLAIM}, got ${obs.presence_level}`);
    // Nothing is silently dropped: the attestation record keeps claimed vs stored.
    assert.equal(obs.presence_attestation.claimed, "P4");
    assert.equal(obs.presence_attestation.stored, obs.presence_level);
    assert.equal(obs.presence_attestation.attested, false);
    assert.equal(obs.presence_attestation.clamped, true);
    assert.equal(obs.presence_attestation.reason, "clamped_unattested");
  });

  it("also clamps a transaction-grade (P3) presence when unattested", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput({ presenceLevel: "P3", idempotencyKey: "obs-p3" }) as any);
    assert.equal(r.ok, true);
    assert.ok(rank((r as any).observation.presence_level) < liveFloor);
  });

  it("a below-floor presence (P1 coarse) passes through unchanged, recorded as unattested", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput({ presenceLevel: "P1", idempotencyKey: "obs-p1" }) as any);
    const obs = (r as any).observation;
    assert.equal(obs.presence_level, "P1");
    assert.equal(obs.presence_attestation.clamped, false);
    assert.equal(obs.presence_attestation.reason, "below_live_floor");
  });

  it("honours a live-grade claim ONLY when a server verifier attests it (extension seam)", () => {
    // Default path: no verifier is wired, so the live floor itself is clamped.
    const clamped = resolvePresenceAttestation(MIN_PRESENCE_FOR_LIVE_CLAIM, null);
    assert.ok(rank(clamped.presenceLevel) < liveFloor);
    assert.equal(clamped.attestation.attested, false);
    assert.equal(clamped.attestation.reason, "clamped_unattested");
    // With a real attestation verifier returning true, the claimed level stands.
    const attested = resolvePresenceAttestation(MIN_PRESENCE_FOR_LIVE_CLAIM, { geofence: true }, () => true);
    assert.equal(attested.presenceLevel, MIN_PRESENCE_FOR_LIVE_CLAIM);
    assert.equal(attested.attestation.attested, true);
    assert.equal(attested.attestation.clamped, false);
  });

  it("normalises a malformed/forged presence string to P0 (fail-closed)", () => {
    const res = resolvePresenceAttestation("P9-forged", null);
    assert.equal(res.presenceLevel, "P0");
    assert.equal(res.attestation.claimed, "P0");
  });
});

describe("IG-03 capture — D4 consent gate (server-authoritative, fail-closed)", () => {
  it("refuses capture when the actor has NO consent row", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE], consent: false });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "consent_required");
    assert.equal(db._tables.intel_observations.length, 0, "no observation written without consent");
  });
  it("refuses capture when consent was withdrawn", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE], consent: "withdrawn" });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal((r as any).reason, "consent_required");
    assert.equal(db._tables.intel_observations.length, 0);
  });
  it("enforces consent BEFORE payload validation — no consent beats a malformed payload", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE], consent: false });
    const r = await writeObservation(db as any, ACTOR, baseInput({ claimType: "made.up" }) as any);
    assert.equal((r as any).reason, "consent_required"); // not invalid_claim_type
  });
  it("allows capture once consent is granted", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE], consent: true });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(r.ok, true);
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
    assert.equal(db._tables.intel_claims.find((c) => c.id === claimId).promotion_source, "admin",
      "admin approval records provenance='admin', distinct from system promotion");

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

  it("correctClaim REFUSES to supersede a claim for a different subject (ownership guard)", async () => {
    const PLACE2 = "99999999-9999-4999-8999-999999999999";
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE, PLACE2] });
    // An active claim owned by PLACE2 — the victim whose live label an attacker
    // would try to blank by pointing priorClaimId at it.
    db._tables.intel_claims = [{ id: "victim-claim", subject_id: PLACE2, claim_type: "crowd.level", status: "active" }];
    const corr = await correctClaim(db as any, ACTOR, "victim-claim", baseInput({ idempotencyKey: "obs-key-x" }) as any);
    assert.equal(corr.ok, true, "the correction observation for PLACE still writes");
    assert.equal((corr as any).supersededPrior, false, "must NOT supersede a claim for another subject");
    assert.equal(db._tables.intel_claims.find((c: any) => c.id === "victim-claim").status, "active",
      "the victim claim for PLACE2 is untouched");
  });

  it("confirmClaim REFUSES when the actor withdrew consent (D4 parity with capture)", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE], consent: "withdrawn" });
    const r = await confirmClaim(db as any, "some-claim", ACTOR, "agree", OBSERVED);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "consent_required");
    assert.equal(db._tables.intel_confirmations?.length ?? 0, 0, "no confirmation written without consent");
  });

  it("propose REFUSES an observation whose content was moderation-invalidated", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const written = await writeObservation(db as any, ACTOR, baseInput() as any);
    for (const state of ["blocked", "removed", "restricted"]) {
      const out = await proposeClaim(db as any, { ...(written as any).observation, moderation_state: state });
      assert.equal(out.ok, false, `${state} must not back a claim`);
      assert.equal(out.reason, "not_moderated");
    }
    // 'pending' (unpromoted) still flows in the pilot.
    assert.equal((await proposeClaim(db as any, { ...(written as any).observation, moderation_state: "pending" })).ok, true);
  });
});

// ── I1 / §24: correction invalidation targets + completion status ─────────────
describe("IG-03 correction — §24 invalidation targets are named and logged", () => {
  /** Capture every logger.info record while `fn` runs; restore afterwards. */
  async function withInfoLog<T>(fn: () => Promise<T>): Promise<{ result: T; records: any[] }> {
    const records: any[] = [];
    const m = mock.method(logger, "info", (obj: unknown) => { records.push(obj); });
    try { return { result: await fn(), records }; } finally { m.mock.restore(); }
  }

  it("names the prior claim and every current-state snapshot of the corrected (subject, claim_type), and reports completion as pending projection", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const written = await writeObservation(db as any, ACTOR, baseInput() as any);
    const proposed = await proposeClaim(db as any, (written as any).observation);
    const claimId = proposed.claim.id;
    assert.equal((await approveClaim(db as any, claimId)).ok, true);
    // Two dependent read models: the zone-less snapshot and a zoned one. A
    // snapshot for a DIFFERENT claim type of the same place is not a target.
    db._tables.intel_state_snapshots.push(
      { id: "snap-a", subject_id: PLACE, zone_id: "", claim_type: "crowd.level", privacy_eligible: true },
      { id: "snap-b", subject_id: PLACE, zone_id: "bar", claim_type: "crowd.level", privacy_eligible: false },
      { id: "snap-other", subject_id: PLACE, zone_id: "", claim_type: "queue.wait", privacy_eligible: true },
    );

    const { result: corr, records } = await withInfoLog(() =>
      correctClaim(db as any, ACTOR, claimId, baseInput({ value: { level: "quiet" }, idempotencyKey: "obs-key-2" }) as any));
    assert.equal(corr.ok, true);
    const inv = (corr as any).invalidation;
    assert.equal(inv.prior_claim_id, claimId);
    assert.equal(inv.superseded, true);
    assert.equal(inv.observation_id, db._tables.intel_observations[1].id, "the correcting observation is the lineage root of the replacement claim");
    assert.deepEqual(
      inv.snapshot_targets.map((t: any) => t.id).sort(),
      ["snap-a", "snap-b"],
      "both snapshots of the corrected key are targets; the other claim type is not",
    );
    assert.equal(inv.completion, "superseded_pending_projection");

    const line = records.find((r) => r?.event === "intel.correction.invalidation");
    assert.ok(line, "one structured intel.correction.invalidation record is emitted");
    assert.equal(line.target_count, 2);
    assert.equal(line.prior_claim_id, claimId);
    assert.ok(!("actor_id" in line) && !JSON.stringify(line).includes(ACTOR), "no actor id in the lineage log (§24: no private data in logs)");
  });

  it("a correction that supersedes nothing (wrong subject) reports prior_not_supersedable with zero targets", async () => {
    const PLACE2 = "99999999-9999-4999-8999-999999999999";
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE, PLACE2] });
    db._tables.intel_claims.push({ id: "victim", subject_id: PLACE2, claim_type: "crowd.level", status: "active" });
    db._tables.intel_state_snapshots.push({ id: "snap-victim", subject_id: PLACE2, zone_id: "", claim_type: "crowd.level", privacy_eligible: true });
    const { result: corr, records } = await withInfoLog(() =>
      correctClaim(db as any, ACTOR, "victim", baseInput({ idempotencyKey: "obs-key-x" }) as any));
    assert.equal(corr.ok, true);
    const inv = (corr as any).invalidation;
    assert.equal(inv.superseded, false);
    assert.equal(inv.completion, "prior_not_supersedable");
    assert.deepEqual(inv.snapshot_targets, [], "no target may be named for a claim this correction did not supersede");
    assert.equal(db._tables.intel_state_snapshots[0].privacy_eligible, true, "the victim snapshot is untouched");
    assert.ok(records.some((r) => r?.event === "intel.correction.invalidation" && r.target_count === 0));
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
