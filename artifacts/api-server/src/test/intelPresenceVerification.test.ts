/**
 * IG unit I3 — presence verification P2/P3/P4 behind intel_presence_verification_enabled.
 *
 * Runs entirely in memory against a fake client (mirrors intelCapture.test.ts).
 * Proves, in the order the unit brief lists them:
 *   flag OFF  → a live-grade claim is clamped to P1 EXACTLY as before (same
 *               attestation shape, no verifier read, no audit row);
 *   flag ON   → geofence + dwell ⇒ P2; geofence + interaction ⇒ P2;
 *               geofence alone ⇒ P1; outside / no / imprecise position ⇒ P1;
 *               P2 + eligible receipt ⇒ P3 (ineligible variants stay P2);
 *               P2 + valid mission nonce ⇒ P4, replayed / forged / wrong-actor /
 *               wrong-subject nonce ⇒ no P4; a verifier throw ⇒ P1;
 *               a rung above the CLAIM is never attempted (a P2 claim does not
 *               spend a nonce); coordinates never reach the audit row or the
 *               stored attestation.
 *   Plus: the nonce module's HMAC properties, acceptMission storing only the
 *   digest, and text pins on migration 2276 (flag OFF postcondition, RLS,
 *   REVOKE-first, own-row policy, append-only triggers, nonce columns).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeObservation, resolvePresenceAttestation, resolvePresenceForCapture } from "../services/intel/IntelCaptureService.js";
import { acceptMission } from "../services/intel/CoverageService.js";
import { verifyPresence, distanceBucket, dwellBucket, claimMatchesFamily, GEOFENCE_RADIUS_M } from "../services/intel/PresenceVerifier.js";
import {
  mintMissionNonce, verifyMissionNonce, deriveMissionNonceDigest, isWellFormedMissionNonceToken,
  MISSION_NONCE_TOKEN_HEX_LENGTH,
} from "../lib/intelMissionNonce.js";

// The nonce HMAC (like the group key) needs a server secret; the test sets one
// explicitly so the P4 path is exercised rather than fail-closed by absence.
before(() => { if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-presence-verification"; });

const ACTOR   = "11111111-1111-4111-8111-111111111111";
const OTHER   = "33333333-3333-4333-8333-333333333333";
const PLACE   = "22222222-2222-4222-8222-222222222222";
const MEDIA   = "44444444-4444-4444-8444-444444444444";
const MISSION = "55555555-5555-4555-8555-555555555555";

// Venue coordinates (fixture only). ~111 m per 0.001° latitude.
const VENUE_LAT = 16.0678;
const VENUE_LNG = 108.2208;
const INSIDE  = { lat: VENUE_LAT + 0.0003, lng: VENUE_LNG };           // ~33 m
const OUTSIDE = { lat: VENUE_LAT + 0.02,   lng: VENUE_LNG };           // ~2.2 km

const NOW = Date.now();
const MIN = 60_000;
const OBSERVED_MS = NOW - 5 * MIN;             // clampObservedAt uses the real clock
const OBSERVED = new Date(OBSERVED_MS).toISOString();
const at = (msBeforeObserved: number) => new Date(OBSERVED_MS - msBeforeObserved).toISOString();

const FLAG = "intel_presence_verification_enabled";

// ── Fake supabase client ──────────────────────────────────────────────────────
type Row = Record<string, any>;
interface DbOpts { throwOn?: string; errorOn?: string }

function makeDb(flags: Record<string, boolean>, seed: Record<string, Row[]> = {}, opts: DbOpts = {}) {
  const tables: Record<string, Row[]> = {
    intel_observations: [], intel_claims: [], intel_confirmations: [], intel_presence_verifications: [],
    location_snapshots: [], saved_places: [], wishlist_places: [], trip_plan_items: [],
    media_assets: [], intel_mission_candidates: [],
    places: [{ id: PLACE, latitude: VENUE_LAT, longitude: VENUE_LNG }],
  };
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const reads: Record<string, number> = {};
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let wantRows = false;
    let single: "maybe" | "one" | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const preds: Array<(r: Row) => boolean> = [];
    const match = (r: Row) => preds.every((p) => p(r));

    function run(): { data: any; error: any } {
      reads[table] = (reads[table] ?? 0) + 1;
      if (opts.throwOn === table) throw new Error(`boom:${table}`);
      if (opts.errorOn === table) return { data: null, error: { message: `err:${table}` } };
      if (table === "feature_flags") {
        const flagPred = preds.length ? preds : [];
        const row = Object.keys(flags).map((f) => ({ flag: f, enabled: flags[f] })).find((r) => flagPred.every((p) => p(r)));
        return { data: row ? { enabled: Boolean(row.enabled) } : null, error: null };
      }
      if (table === "intel_contribution_consent") return { data: { enabled: true, withdrawn_at: null }, error: null };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: new Date(NOW).toISOString(), ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate observation" } };
        }
        store.push(row);
        return { data: wantRows ? (single ? row : [row]) : null, error: null };
      }
      if (op === "update") {
        const updated: Row[] = [];
        for (const r of store) if (match(r)) { Object.assign(r, payload); updated.push(r); }
        return { data: wantRows ? (single ? (updated[0] ?? null) : updated) : null, error: null };
      }
      let rows = store.filter(match);
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    const b: any = {
      select() { wantRows = true; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      gte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] >= v); return b; },
      lte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] <= v); return b; },
      gt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] > v); return b; },
      lt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] < v); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      filter(c: string, opName: string, v: any) { if (opName === "eq") preds.push((r) => r[c] === v); return b; },
      or(expr: string) {
        const clauses = expr.split(",").map((s) => s.split("."));
        preds.push((r) => clauses.some(([c, o, v]) => o === "eq" && String(r[c]) === v));
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) { orderBy = { col: c, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { single = "maybe"; return Promise.resolve(run()); },
      single() { single = "one"; return Promise.resolve(run()); },
      then(resolve: (r: any) => any, reject?: (e: any) => any) {
        let out: any;
        try { out = run(); } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
        return Promise.resolve(out).then(resolve);
      },
    };
    return b;
  }
  return { from, _tables: tables, _reads: reads };
}

// ── Fixture builders ──────────────────────────────────────────────────────────
const snapshot = (pos: { lat: number; lng: number }, capturedAt: string, accuracy: number | null = 15): Row => ({
  user_id: ACTOR, lat: pos.lat, lng: pos.lng, accuracy_meters: accuracy, captured_at: capturedAt, source: "gps",
});
const positionNow = () => snapshot(INSIDE, at(0));                 // at the capture instant
const dwellFix = () => snapshot(INSIDE, at(20 * MIN));             // 20 min earlier, inside
const saveRecent = (): Row => ({ user_id: ACTOR, place_id: PLACE, saved_at: at(60 * MIN) });
const receiptAsset = (over: Row = {}): Row => ({
  id: MEDIA, owner_user_id: ACTOR, source_type: "camera", media_type: "image",
  provenance: { sourceType: "camera", capturedAt: at(2 * MIN), hasLocation: true, editHistory: [] },
  captured_at: at(2 * MIN), moderation_status: "approved", processing_status: "ready", visibility: "inherit",
  ...over,
});
const acceptedMission = (digest: string | null, over: Row = {}): Row => ({
  id: MISSION, city: "Da Nang", zone_id: null, subject_id: PLACE, claim_family: "crowd.level", trigger: "demand",
  coverage_score: 0.8, question: "How busy?", evidence_contract: {}, budget_units: 1, budget_committed: true,
  cash_amount: 0, status: "accepted", accepted_by: ACTOR, deadline: new Date(NOW + 60 * MIN).toISOString(),
  nonce: digest, nonce_consumed_at: null, ...over,
});

const baseInput = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  claimType: "crowd.level",
  value: { level: "busy" as const },
  observedAt: OBSERVED,
  capturedAt: OBSERVED,
  idempotencyKey: `obs-${Math.random().toString(36).slice(2)}`,
  presenceLevel: "P2",
  ...over,
});

const ON  = { intel_capture_quick_signal: true, [FLAG]: true };
const OFF = { intel_capture_quick_signal: true, [FLAG]: false };

async function capture(db: any, over: Record<string, unknown> = {}) {
  const r = await writeObservation(db as any, ACTOR, baseInput(over) as any);
  assert.equal(r.ok, true, `capture should succeed: ${JSON.stringify(r)}`);
  return (r as any).observation;
}

// ── Flag OFF: byte-identical to before ───────────────────────────────────────
describe("I3 presence — flag OFF is the pre-2276 clamp, byte for byte", () => {
  it("a live-grade claim is clamped to P1 with today's attestation shape and no verifier read or audit row", async () => {
    const db = makeDb(OFF, { location_snapshots: [positionNow(), dwellFix()] });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P1");
    // EXACTLY what resolvePresenceAttestation produces today — same keys, same values.
    assert.deepEqual(obs.presence_attestation, resolvePresenceAttestation("P2", undefined).attestation);
    assert.equal(obs.presence_attestation.reason, "clamped_unattested");
    assert.equal("verifier" in obs.presence_attestation, false);
    assert.equal(db._reads.location_snapshots ?? 0, 0, "no position read with the flag off");
    assert.equal(db._tables.intel_presence_verifications.length, 0, "no audit row with the flag off");
  });

  it("a P4 claim with a valid nonce and receipt is still clamped to P1 when OFF, and the nonce is untouched", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = makeDb(OFF, {
      location_snapshots: [positionNow(), dwellFix()],
      media_assets: [receiptAsset()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    });
    const obs = await capture(db, { presenceLevel: "P4", presenceAttestation: { receipt: { mediaAssetId: MEDIA }, mission: { missionId: MISSION, nonce: minted.token } } });
    assert.equal(obs.presence_level, "P1");
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
  });

  it("a below-floor claim (P0/P1) never reads the flag at all", async () => {
    const db = makeDb(ON);
    const obs = await capture(db, { presenceLevel: "P1" });
    assert.equal(obs.presence_level, "P1");
    assert.equal(db._reads.feature_flags, 1, "only the capture-surface flag read");
    assert.equal(db._tables.intel_presence_verifications.length, 0);
  });
});

// ── Flag ON: the P2 rung ──────────────────────────────────────────────────────
describe("I3 presence — flag ON, rung P2 (geofence + dwell/interaction)", () => {
  it("geofence + dwell (earlier in-geofence snapshot) ⇒ P2, method dwell, audit row written", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow(), dwellFix()] });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P2");
    assert.equal(obs.presence_attestation.attested, true);
    assert.equal(obs.presence_attestation.clamped, false);
    assert.equal(obs.presence_attestation.reason, "attested");
    const v = obs.presence_attestation.verifier;
    assert.equal(v.geofence, "inside");
    assert.equal(v.method, "dwell");
    assert.deepEqual(v.methods, ["geofence", "dwell"]);
    assert.equal(v.dwell.bucket, "10_to_30m");
    assert.equal(v.dwell.source, "location_snapshots");
    assert.equal(v.positionSource, "location_snapshot");
    const rec = db._tables.intel_presence_verifications;
    assert.equal(rec.length, 1);
    assert.equal(rec[0].observation_id, obs.id);
    assert.equal(rec[0].actor_id, ACTOR);
    assert.equal(rec[0].method, "dwell");
    assert.equal(rec[0].level_reached, "P2");
    assert.ok(rec[0].verified_at);
  });

  it("geofence + interaction (a recent save at the subject) without dwell ⇒ P2, method interaction", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [saveRecent()] });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P2");
    assert.equal(obs.presence_attestation.verifier.method, "interaction");
    assert.equal(obs.presence_attestation.verifier.interaction.kind, "save");
    assert.equal(obs.presence_attestation.verifier.dwell.held, false);
  });

  it("interaction via wishlist and via a plan stop at the subject both count", async () => {
    const wish = makeDb(ON, { location_snapshots: [positionNow()], wishlist_places: [{ user_id: ACTOR, place_id: PLACE, saved_at: at(3 * 60 * MIN) }] });
    assert.equal((await capture(wish)).presence_attestation.verifier.interaction.kind, "wishlist");
    const plan = makeDb(ON, { location_snapshots: [positionNow()], trip_plan_items: [
      { source_type: "place", source_id: PLACE, creator_id: ACTOR, added_by: null, removed_at: null, starts_at: at(-30 * MIN), created_at: at(48 * 60 * MIN) },
    ] });
    assert.equal((await capture(plan)).presence_attestation.verifier.interaction.kind, "plan_stop");
  });

  it("a save at ANOTHER place, or by ANOTHER user, or too old, is not an interaction", async () => {
    const other = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [{ ...saveRecent(), place_id: OTHER }] });
    assert.equal((await capture(other)).presence_level, "P1");
    const someoneElse = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [{ ...saveRecent(), user_id: OTHER }] });
    assert.equal((await capture(someoneElse)).presence_level, "P1");
    const stale = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [{ ...saveRecent(), saved_at: at(3 * 24 * 60 * MIN) }] });
    assert.equal((await capture(stale)).presence_level, "P1");
  });

  it("geofence WITHOUT dwell or interaction ⇒ P1 (Table 13: geofence alone is not P2); attempt still audited", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow()] });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P1");
    assert.equal(obs.presence_attestation.reason, "clamped_unverified");
    assert.equal(obs.presence_attestation.verifier.geofence, "inside");
    assert.ok(obs.presence_attestation.verifier.refusals.includes("no_dwell_or_interaction"));
    const rec = db._tables.intel_presence_verifications;
    assert.equal(rec.length, 1);
    assert.equal(rec[0].method, null);
    assert.equal(rec[0].level_reached, "P1");
  });

  it("outside the geofence ⇒ P1 even with dwell evidence; only a distance BUCKET is recorded", async () => {
    const db = makeDb(ON, { location_snapshots: [snapshot(OUTSIDE, at(0)), snapshot(OUTSIDE, at(20 * MIN))] });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P1");
    assert.equal(obs.presence_attestation.verifier.geofence, "outside");
    assert.equal(obs.presence_attestation.verifier.distanceBucket, "beyond_1km");
  });

  it("no snapshot within ±2 min of capture ⇒ P1 (no_position); an imprecise one ⇒ P1 (imprecise)", async () => {
    const stale = makeDb(ON, { location_snapshots: [snapshot(INSIDE, at(10 * MIN)), dwellFix()] });
    const o1 = await capture(stale);
    assert.equal(o1.presence_level, "P1");
    assert.equal(o1.presence_attestation.verifier.geofence, "no_position");
    const blurry = makeDb(ON, { location_snapshots: [snapshot(INSIDE, at(0), 900), dwellFix()] });
    const o2 = await capture(blurry);
    assert.equal(o2.presence_level, "P1");
    assert.equal(o2.presence_attestation.verifier.geofence, "imprecise");
  });

  it("a subject without coordinates ⇒ P1 (no_subject_coordinates)", async () => {
    const db = makeDb(ON, { places: [{ id: PLACE, latitude: null, longitude: null }], location_snapshots: [positionNow(), dwellFix()] });
    const obs = await capture(db);
    assert.equal(obs.presence_level, "P1");
    assert.equal(obs.presence_attestation.verifier.geofence, "no_subject_coordinates");
  });

  it("dwell via a PRIOR observation counts only when the SERVER wrote geofence:inside — a client-shaped copy does not", async () => {
    const serverVerified = { actor_id: ACTOR, subject_id: PLACE, observed_at: at(15 * MIN), idempotency_key: "old-1", presence_attestation: { verifier: { geofence: "inside" } } };
    const clientForged   = { actor_id: ACTOR, subject_id: PLACE, observed_at: at(15 * MIN), idempotency_key: "old-2", presence_attestation: { client: { verifier: { geofence: "inside" } } } };
    const good = makeDb(ON, { location_snapshots: [positionNow()], intel_observations: [serverVerified] });
    const o1 = await capture(good);
    assert.equal(o1.presence_level, "P2");
    assert.equal(o1.presence_attestation.verifier.dwell.source, "prior_observation");
    const bad = makeDb(ON, { location_snapshots: [positionNow()], intel_observations: [clientForged] });
    assert.equal((await capture(bad)).presence_level, "P1");
  });

  it("a claimed P2 is never RAISED: full P4 evidence stores P2 and does not spend the nonce", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = makeDb(ON, {
      location_snapshots: [positionNow(), dwellFix()],
      media_assets: [receiptAsset()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    });
    const obs = await capture(db, { presenceLevel: "P2", presenceAttestation: { receipt: { mediaAssetId: MEDIA }, mission: { missionId: MISSION, nonce: minted.token } } });
    assert.equal(obs.presence_level, "P2");
    assert.equal(obs.presence_attestation.verifier.receipt, undefined, "receipt rung not attempted for a P2 claim");
    assert.equal(obs.presence_attestation.verifier.mission, undefined, "mission rung not attempted for a P2 claim");
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
    assert.equal(db._reads.media_assets ?? 0, 0);
  });
});

// ── Flag ON: rung P3 (receipt) ────────────────────────────────────────────────
describe("I3 presence — flag ON, rung P3 (receipt media)", () => {
  const withReceipt = (assetOver: Row = {}) => makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], media_assets: [receiptAsset(assetOver)] });
  const claimP3 = { presenceLevel: "P3", presenceAttestation: { receipt: { mediaAssetId: MEDIA } } };

  it("P2 + an owned, ready, eligible receipt captured inside the window ⇒ P3, method receipt", async () => {
    const db = withReceipt();
    const obs = await capture(db, claimP3);
    assert.equal(obs.presence_level, "P3");
    const v = obs.presence_attestation.verifier;
    assert.equal(v.method, "receipt");
    assert.deepEqual(v.methods, ["geofence", "dwell", "receipt"]);
    assert.equal(v.receipt.mediaAssetId, MEDIA);
    assert.equal(db._tables.intel_presence_verifications[0].level_reached, "P3");
  });

  it("refusals keep P2: not owner / outside window / evidence-breaking edit / private / not ready / moderation-blocked / no reference", async () => {
    const cases: Array<[string, Row | null, string]> = [
      ["not_owner", { owner_user_id: OTHER }, "receipt:not_owner"],
      ["outside_window", { provenance: { sourceType: "camera", capturedAt: at(5 * 60 * MIN), editHistory: [] }, captured_at: at(5 * 60 * MIN) }, "receipt:outside_window"],
      ["ineligible", { provenance: { sourceType: "camera", capturedAt: at(2 * MIN), editHistory: [{ op: "generative_fill", at: at(MIN) }] } }, "receipt:ineligible"],
      ["media_private", { visibility: "private" }, "receipt:media_private"],
      ["not_ready", { processing_status: "processing" }, "receipt:not_ready"],
      ["moderation_blocked", { moderation_status: "rejected" }, "receipt:moderation_blocked"],
    ];
    for (const [label, over, refusal] of cases) {
      const db = withReceipt(over ?? {});
      const obs = await capture(db, claimP3);
      assert.equal(obs.presence_level, "P2", label);
      assert.ok(obs.presence_attestation.verifier.refusals.includes(refusal), `${label}: ${JSON.stringify(obs.presence_attestation.verifier.refusals)}`);
    }
    const noRef = await capture(withReceipt(), { presenceLevel: "P3" });
    assert.equal(noRef.presence_level, "P2");
    assert.ok(noRef.presence_attestation.verifier.refusals.includes("receipt:no_reference"));
  });

  it("a receipt without P2 (no dwell/interaction) is still P1 — rungs are cumulative", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow()], media_assets: [receiptAsset()] });
    const obs = await capture(db, claimP3);
    assert.equal(obs.presence_level, "P1");
    assert.equal(db._reads.media_assets ?? 0, 0, "receipt never examined without P2");
  });
});

// ── Flag ON: rung P4 (mission nonce) ──────────────────────────────────────────
describe("I3 presence — flag ON, rung P4 (mission nonce)", () => {
  const withMission = (digest: string | null, missionOver: Row = {}, extra: Record<string, Row[]> = {}) =>
    makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], intel_mission_candidates: [acceptedMission(digest, missionOver)], ...extra });
  const claimP4 = (nonce: string) => ({ presenceLevel: "P4", presenceAttestation: { mission: { missionId: MISSION, nonce } } });

  it("P2 + a valid nonce ⇒ P4, method mission_nonce, and the nonce is consumed (single-use)", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = withMission(minted.digest);
    const obs = await capture(db, claimP4(minted.token));
    assert.equal(obs.presence_level, "P4");
    const v = obs.presence_attestation.verifier;
    assert.equal(v.method, "mission_nonce");
    assert.deepEqual(v.methods, ["geofence", "dwell", "mission_nonce"]);
    assert.equal(v.mission.missionId, MISSION);
    assert.ok(db._tables.intel_mission_candidates[0].nonce_consumed_at, "nonce marked consumed");
    assert.equal(db._tables.intel_presence_verifications[0].level_reached, "P4");
    assert.equal(db._tables.intel_presence_verifications[0].method, "mission_nonce");
  });

  it("a REPLAYED nonce (second capture) is refused ⇒ P2, refusal mission:replayed", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = withMission(minted.digest);
    assert.equal((await capture(db, claimP4(minted.token))).presence_level, "P4");
    const again = await capture(db, claimP4(minted.token));
    assert.equal(again.presence_level, "P2");
    assert.ok(again.presence_attestation.verifier.refusals.includes("mission:replayed"));
  });

  it("a FORGED nonce (well-formed but wrong) ⇒ P2, refusal mission:forged; nonce not consumed", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = withMission(minted.digest);
    const forged = "f".repeat(MISSION_NONCE_TOKEN_HEX_LENGTH);
    const obs = await capture(db, claimP4(forged));
    assert.equal(obs.presence_level, "P2");
    assert.ok(obs.presence_attestation.verifier.refusals.includes("mission:forged"));
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
  });

  it("a malformed nonce reference is dropped before any lookup ⇒ P2, mission:no_reference", async () => {
    const db = withMission(mintMissionNonce(MISSION, ACTOR).digest);
    const obs = await capture(db, claimP4("not-hex"));
    assert.equal(obs.presence_level, "P2");
    assert.ok(obs.presence_attestation.verifier.refusals.includes("mission:no_reference"));
    assert.equal(db._reads.intel_mission_candidates ?? 0, 0);
  });

  it("a nonce minted for ANOTHER actor, an unaccepted mission, another subject, a wrong contract, or a past deadline ⇒ no P4", async () => {
    const mine = mintMissionNonce(MISSION, ACTOR);
    const theirs = mintMissionNonce(MISSION, OTHER);
    const cases: Array<[string, string | null, Row, string]> = [
      ["not_assignee", theirs.digest, { accepted_by: OTHER }, "mission:not_assignee"],
      ["passed_on", theirs.digest, { accepted_by: ACTOR }, "mission:forged"],           // token folded over OTHER, presented by ACTOR
      ["not_accepted", mine.digest, { status: "dispatched" }, "mission:not_accepted"],
      ["subject_mismatch", mine.digest, { subject_id: OTHER }, "mission:subject_mismatch"],
      ["subject_null", mine.digest, { subject_id: null }, "mission:subject_mismatch"],
      ["contract_mismatch", mine.digest, { claim_family: "queue.wait" }, "mission:contract_mismatch"],
      ["expired", mine.digest, { deadline: at(60 * MIN) }, "mission:expired"],
      ["no_nonce", null, {}, "mission:no_nonce"],
    ];
    for (const [label, digest, over, refusal] of cases) {
      const db = withMission(digest, over);
      const token = label === "not_assignee" || label === "passed_on" ? theirs.token : mine.token;
      const obs = await capture(db, claimP4(token));
      assert.equal(obs.presence_level, "P2", label);
      assert.ok(obs.presence_attestation.verifier.refusals.includes(refusal), `${label}: ${JSON.stringify(obs.presence_attestation.verifier.refusals)}`);
      assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null, `${label}: nonce untouched`);
    }
  });

  it("a nonce without P2 is never examined and never spent ⇒ P1", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = makeDb(ON, { location_snapshots: [positionNow()], intel_mission_candidates: [acceptedMission(minted.digest)] });
    const obs = await capture(db, claimP4(minted.token));
    assert.equal(obs.presence_level, "P1");
    assert.equal(db._reads.intel_mission_candidates ?? 0, 0);
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
  });

  it("P4 stacks on P3: receipt + nonce ⇒ P4 with all five methods recorded", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = withMission(minted.digest, {}, { media_assets: [receiptAsset()] });
    const obs = await capture(db, { presenceLevel: "P4", presenceAttestation: { receipt: { mediaAssetId: MEDIA }, mission: { missionId: MISSION, nonce: minted.token } } });
    assert.equal(obs.presence_level, "P4");
    assert.deepEqual(obs.presence_attestation.verifier.methods, ["geofence", "dwell", "receipt", "mission_nonce"]);
  });
});

// ── Fail-closed + privacy ─────────────────────────────────────────────────────
describe("I3 presence — fail-closed and coordinate hygiene", () => {
  it("a verifier THROW ⇒ P1, error named, methods emptied, audit row says verifier_error", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow(), dwellFix()] }, { throwOn: "location_snapshots" });
    const obs = await capture(db, { presenceLevel: "P2" });
    assert.equal(obs.presence_level, "P1");
    const v = obs.presence_attestation.verifier;
    assert.equal(v.geofence, "error");
    assert.match(String(v.error), /boom:location_snapshots/);
    assert.deepEqual(v.methods, []);
    assert.ok(v.refusals.includes("verifier_error"));
    const rec = db._tables.intel_presence_verifications[0];
    assert.equal(rec.level_reached, "P1");
    assert.equal(rec.method, null);
  });

  it("a DB ERROR (resolved, not thrown) on any evidence read ⇒ P1, never partial", async () => {
    for (const table of ["location_snapshots", "saved_places"]) {
      const db = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [saveRecent()] }, { errorOn: table });
      const obs = await capture(db);
      assert.equal(obs.presence_level, "P1", table);
      assert.ok(obs.presence_attestation.verifier.refusals.includes("verifier_error"), table);
    }
    // A `places` error is caught EARLIER by the capture service's own subject
    // check (db_error "subject lookup") — the verifier is never reached. Pin the
    // verifier's own posture for that read directly.
    const db = makeDb(ON, { location_snapshots: [positionNow()], saved_places: [saveRecent()] }, { errorOn: "places" });
    const out = await verifyPresence(db, { actorId: ACTOR, subjectId: PLACE, subjectKind: "experience", claimType: "crowd.level", observedAt: OBSERVED, capturedAt: OBSERVED, claimedLevel: "P2", attestation: null });
    assert.equal(out.level, "P1");
    assert.ok(out.evidence.refusals.includes("verifier_error"));
  });

  it("a mission-read DB error after P2 held ⇒ full clamp to P1 (not P2)", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], intel_mission_candidates: [acceptedMission(minted.digest)] }, { errorOn: "intel_mission_candidates" });
    const obs = await capture(db, { presenceLevel: "P4", presenceAttestation: { mission: { missionId: MISSION, nonce: minted.token } } });
    assert.equal(obs.presence_level, "P1");
    assert.deepEqual(obs.presence_attestation.verifier.methods, []);
  });

  it("coordinates NEVER reach the audit row or the stored verifier verdict — only buckets and references", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = makeDb(ON, {
      location_snapshots: [positionNow(), dwellFix()],
      media_assets: [receiptAsset()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    });
    const obs = await capture(db, { presenceLevel: "P4", presenceAttestation: { receipt: { mediaAssetId: MEDIA }, mission: { missionId: MISSION, nonce: minted.token } } });
    const rec = db._tables.intel_presence_verifications[0];
    for (const [label, blob] of [["audit evidence", rec.evidence], ["stored verifier", obs.presence_attestation.verifier]] as const) {
      const text = JSON.stringify(blob);
      for (const key of ["lat", "lng", "latitude", "longitude", "geog", "accuracy_meters"]) {
        assert.equal(new RegExp(`"${key}"`).test(text), false, `${label} carries key ${key}`);
      }
      for (const num of [VENUE_LAT, VENUE_LNG, INSIDE.lat]) {
        assert.equal(text.includes(String(num)), false, `${label} carries coordinate ${num}`);
        assert.equal(text.includes(num.toFixed(3)), false, `${label} carries rounded coordinate ${num.toFixed(3)}`);
      }
    }
    assert.equal(rec.evidence.distanceBucket, "within_50m");
    assert.equal(typeof rec.evidence.radiusMeters, "number");
  });

  it("a failed audit write does not undo the capture (observable, not silent)", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow(), dwellFix()] }, { errorOn: "intel_presence_verifications" });
    const obs = await capture(db);
    assert.equal(obs.presence_level, "P2");
    assert.equal(db._tables.intel_presence_verifications.length, 0);
  });

  it("resolvePresenceForCapture with the flag OFF returns exactly resolvePresenceAttestation's object", async () => {
    const db = makeDb(OFF);
    const ctx = { actorId: ACTOR, subjectId: PLACE, subjectKind: "experience", claimType: "crowd.level", observedAt: OBSERVED, capturedAt: OBSERVED };
    const client = { anything: "the client said" };
    const viaFlag = await resolvePresenceForCapture(db, "P3", client, ctx);
    assert.deepEqual(viaFlag, resolvePresenceAttestation("P3", client));
    assert.equal("verification" in viaFlag, false);
  });
});

// ── Verifier unit helpers ─────────────────────────────────────────────────────
describe("I3 presence — verifier helpers", () => {
  it("distance and dwell buckets are coarse and monotonic", () => {
    assert.equal(distanceBucket(10), "within_50m");
    assert.equal(distanceBucket(149), "within_150m");
    assert.equal(distanceBucket(399), "within_400m");
    assert.equal(distanceBucket(999), "within_1km");
    assert.equal(distanceBucket(5000), "beyond_1km");
    assert.equal(dwellBucket(11 * MIN), "10_to_30m");
    assert.equal(dwellBucket(45 * MIN), "30_to_90m");
    assert.equal(dwellBucket(200 * MIN), "over_90m");
  });

  it("claim/contract matching is exact-or-family-prefix and fail-closed on empty", () => {
    assert.equal(claimMatchesFamily("crowd.level", "crowd.level"), true);
    assert.equal(claimMatchesFamily("crowd.level", "crowd"), true);
    assert.equal(claimMatchesFamily("crowd.level", "crowdsource"), false);
    assert.equal(claimMatchesFamily("crowd.level", "queue.wait"), false);
    assert.equal(claimMatchesFamily("crowd.level", ""), false);
    assert.equal(claimMatchesFamily("crowd.level", null), false);
  });

  it("verifyPresence itself never throws — a throwing client yields P1 with the error named", async () => {
    const boom = { from() { throw new Error("client exploded"); } };
    const out = await verifyPresence(boom, { actorId: ACTOR, subjectId: PLACE, subjectKind: "experience", claimType: "crowd.level", observedAt: OBSERVED, capturedAt: null, claimedLevel: "P2", attestation: null });
    assert.equal(out.level, "P1");
    assert.equal(out.method, null);
    assert.match(String(out.evidence.error), /client exploded/);
  });

  it("an invalid capture time ⇒ P1 before any read", async () => {
    const db = makeDb(ON, { location_snapshots: [positionNow(), dwellFix()] });
    const out = await verifyPresence(db, { actorId: ACTOR, subjectId: PLACE, subjectKind: "experience", claimType: "crowd.level", observedAt: "not-a-date", capturedAt: null, claimedLevel: "P2", attestation: null });
    assert.equal(out.level, "P1");
    assert.equal(out.evidence.geofence, "invalid_capture_time");
    assert.equal(db._reads.places ?? 0, 0);
  });

  it("every Phase-1 subject kind has a bounded geofence radius", () => {
    for (const kind of ["experience", "zone", "neighborhood", "route", "event", "service"]) {
      assert.ok(GEOFENCE_RADIUS_M[kind] > 0 && GEOFENCE_RADIUS_M[kind] <= 1000, kind);
    }
  });
});

// ── Nonce module + accept path ────────────────────────────────────────────────
describe("I3 presence — mission nonce (HMAC) and acceptMission", () => {
  it("mints a 32-hex token whose digest is HMAC over mission + actor + token; verification is exact", () => {
    const m = mintMissionNonce(MISSION, ACTOR);
    assert.ok(isWellFormedMissionNonceToken(m.token));
    assert.notEqual(m.token, m.digest);
    assert.equal(m.digest, deriveMissionNonceDigest(MISSION, ACTOR, m.token));
    assert.equal(verifyMissionNonce(MISSION, ACTOR, m.token, m.digest), true);
    assert.equal(verifyMissionNonce(MISSION.toUpperCase(), ACTOR.toUpperCase(), m.token, m.digest), true, "uuid case variants collapse");
    assert.equal(verifyMissionNonce(MISSION, OTHER, m.token, m.digest), false, "actor is folded in");
    assert.equal(verifyMissionNonce(OTHER, ACTOR, m.token, m.digest), false, "mission is folded in");
    assert.equal(verifyMissionNonce(MISSION, ACTOR, mintMissionNonce(MISSION, ACTOR).token, m.digest), false, "a different token");
    assert.equal(verifyMissionNonce(MISSION, ACTOR, "zz", m.digest), false, "malformed token");
    assert.equal(verifyMissionNonce(MISSION, ACTOR, m.token, null), false, "no stored digest");
    assert.equal(verifyMissionNonce(MISSION, ACTOR, m.token, ""), false);
  });

  it("two mints for the same mission/actor differ (random), and mint fails closed without a secret", () => {
    assert.notEqual(mintMissionNonce(MISSION, ACTOR).token, mintMissionNonce(MISSION, ACTOR).token);
    const saved = { g: process.env.INTEL_GROUP_KEY_SECRET, s: process.env.SESSION_SECRET };
    delete process.env.INTEL_GROUP_KEY_SECRET; delete process.env.SESSION_SECRET;
    try { assert.throws(() => mintMissionNonce(MISSION, ACTOR), /SESSION_SECRET/); }
    finally { if (saved.g) process.env.INTEL_GROUP_KEY_SECRET = saved.g; if (saved.s) process.env.SESSION_SECRET = saved.s; }
  });

  it("acceptMission stores ONLY the digest, returns the plaintext once, and the pair verifies", async () => {
    const db = makeDb({}, { intel_mission_candidates: [acceptedMission(null, { status: "dispatched", accepted_by: null })] });
    const out = await acceptMission(db, MISSION, ACTOR);
    assert.equal(out.ok, true);
    assert.ok(isWellFormedMissionNonceToken(out.nonce));
    const row = db._tables.intel_mission_candidates[0];
    assert.equal(row.status, "accepted");
    assert.equal(row.accepted_by, ACTOR);
    assert.notEqual(row.nonce, out.nonce, "plaintext never stored");
    assert.equal(verifyMissionNonce(MISSION, ACTOR, out.nonce, row.nonce), true);
    assert.equal(JSON.stringify(row).includes(out.nonce!), false);
  });

  it("acceptMission still honours the commitment without a secret — no nonce, mission cannot reach P4", async () => {
    const saved = { g: process.env.INTEL_GROUP_KEY_SECRET, s: process.env.SESSION_SECRET };
    delete process.env.INTEL_GROUP_KEY_SECRET; delete process.env.SESSION_SECRET;
    try {
      const db = makeDb({}, { intel_mission_candidates: [acceptedMission(null, { status: "dispatched", accepted_by: null })] });
      const out = await acceptMission(db, MISSION, ACTOR);
      assert.equal(out.ok, true);
      assert.equal(out.nonce, undefined);
      assert.equal(db._tables.intel_mission_candidates[0].status, "accepted");
      assert.equal(db._tables.intel_mission_candidates[0].nonce, null);
    } finally { if (saved.g) process.env.INTEL_GROUP_KEY_SECRET = saved.g; if (saved.s) process.env.SESSION_SECRET = saved.s; }
  });
});

// ── Migration 2276 text pins ──────────────────────────────────────────────────
describe("I3 presence — migration 2276 contract", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "2276_intel_presence_verification.sql"), "utf8");

  it("seeds the flag OFF and asserts on_count = 0 as a postcondition", () => {
    assert.match(sql, /'intel_presence_verification_enabled',\s*\n\s*false,/);
    assert.match(sql, /IF on_count <> 0 THEN/);
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.equal(/UPDATE public\.feature_flags SET enabled = true/i.test(sql), false, "never enables a flag");
  });

  it("adds the nonce columns additively and idempotently", () => {
    assert.match(sql, /ALTER TABLE public\.intel_mission_candidates\s+ADD COLUMN IF NOT EXISTS nonce text,\s+ADD COLUMN IF NOT EXISTS nonce_consumed_at timestamptz;/);
  });

  it("creates the append-only audit table with deny-default RLS, REVOKE-first grants and an own-row SELECT policy only", () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.intel_presence_verifications/);
    assert.match(sql, /observation_id\s+uuid NOT NULL REFERENCES public\.intel_observations\(id\) ON DELETE CASCADE/);
    assert.match(sql, /actor_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    assert.match(sql, /method IS NULL OR method IN \('geofence','dwell','interaction','receipt','mission_nonce'\)/);
    assert.match(sql, /ALTER TABLE public\.intel_presence_verifications ENABLE ROW LEVEL SECURITY/);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.match(sql, new RegExp(`REVOKE ALL ON public\\.intel_presence_verifications FROM ${role};`), role);
    }
    assert.match(sql, /GRANT INSERT, SELECT ON public\.intel_presence_verifications TO service_role;/);
    assert.match(sql, /GRANT SELECT ON public\.intel_presence_verifications TO authenticated;/);
    assert.match(sql, /CREATE POLICY intel_presence_verifications_select_own ON public\.intel_presence_verifications\s+FOR SELECT TO authenticated USING \(actor_id = auth\.uid\(\)\);/);
    assert.equal((sql.match(/CREATE POLICY/g) ?? []).length, 1, "exactly one policy (own-row SELECT)");
    assert.equal(/GRANT .*ON public\.intel_presence_verifications TO anon/.test(sql), false);
    assert.match(sql, /public\.intel_append_only\(\)/);
    assert.match(sql, /public\.intel_append_only_stmt\(\)/);
    assert.match(sql, /_no_truncate/);
  });

  it("postconditions RAISE on every contract (table, RLS, single policy, trigger, anon/authenticated privileges)", () => {
    for (const needle of [
      "intel_presence_verifications not created",
      "RLS not enabled on intel_presence_verifications",
      "expected exactly 1 policy on intel_presence_verifications",
      "append-only trigger missing on intel_presence_verifications",
      "anon can SELECT intel_presence_verifications",
      "authenticated holds a write privilege on intel_presence_verifications",
      "intel_mission_candidates.nonce missing",
    ]) assert.ok(sql.includes(needle), needle);
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
});
