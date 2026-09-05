/**
 * Presence over the WIRE — unit I3's rungs P3/P4 reached through the real HTTP
 * route, and the confirmation write that trusted the client's number.
 *
 * THE DEFECTS (audit 2026-09-05)
 *
 *  1. services/intel/PresenceVerifier implements P3 (media receipt) and P4
 *     (mission nonce), and both are driven entirely by the ATTESTATION
 *     REFERENCES a capture carries. routes/intel.ts observationSchema had no
 *     `presenceAttestation` field, and zod strips unknown keys, so the route
 *     forwarded none: with intel_presence_verification_enabled ON, P3 and P4
 *     were unreachable over HTTP and only the server-held-location rung (P2)
 *     could ever fire. Every existing proof of P3/P4 called the service
 *     directly, so nothing noticed. THIS suite goes through the router.
 *
 *  2. IntelCaptureService.confirmClaim stored the CLIENT-CLAIMED presence_level
 *     into intel_confirmations verbatim — an unverified client value in a truth
 *     table (a row saying P4 asserts "verified assigned visitor"). It now passes
 *     through the same clamp capture uses.
 *
 * WHAT IS PINNED HERE
 *   reachable      flag ON: a valid receipt reaches P3 and a valid nonce reaches
 *                  P4 over the real route, and the nonce is consumed once
 *   derived        the LEVEL is always server-derived: a claimed level is a
 *                  ceiling, never a grant, and a level asserted INSIDE the
 *                  attestation is a 400 (the object is strict), never a value
 *   unchanged      flag OFF is exactly resolvePresenceAttestation's output, the
 *                  nonce is untouched, and a request that sends no attestation
 *                  is byte-identical to before the field existed
 *   confirmations  a client-claimed live-grade level cannot be persisted
 *
 * Run:
 *   node --import tsx/esm --test src/test/intelPresencePlumbing.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import intelRouter from "../routes/intel.js";
import { confirmClaim, resolvePresenceAttestation } from "../services/intel/IntelCaptureService.js";
import { mintMissionNonce, MISSION_NONCE_TOKEN_HEX_LENGTH } from "../lib/intelMissionNonce.js";

before(() => { if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-presence-plumbing"; });

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PLACE = "22222222-2222-4222-8222-222222222222";
const MEDIA = "44444444-4444-4444-8444-444444444444";
const MISSION = "55555555-5555-4555-8555-555555555555";
const CLAIM = "66666666-6666-4666-8666-666666666666";

const VENUE_LAT = 16.0678;
const VENUE_LNG = 108.2208;
const INSIDE = { lat: VENUE_LAT + 0.0003, lng: VENUE_LNG }; // ~33 m

const NOW = Date.now();
const MIN = 60_000;
const OBSERVED_MS = NOW - 5 * MIN;
const OBSERVED = new Date(OBSERVED_MS).toISOString();
const at = (msBeforeObserved: number) => new Date(OBSERVED_MS - msBeforeObserved).toISOString();

const FLAG = "intel_presence_verification_enabled";

// ── Fake supabase client (verbs these paths issue + bearer auth) ─────────────
type Row = Record<string, any>;

function makeDb(flags: Record<string, boolean>, seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    intel_observations: [], intel_claims: [], intel_confirmations: [], intel_presence_verifications: [],
    location_snapshots: [], saved_places: [], wishlist_places: [], trip_plan_items: [],
    media_assets: [], intel_mission_candidates: [], profiles: [],
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
      if (table === "feature_flags") {
        const row = Object.keys(flags).map((f) => ({ flag: f, enabled: flags[f] })).find((r) => preds.every((p) => p(r)));
        return { data: row ? { enabled: Boolean(row.enabled) } : null, error: null };
      }
      if (table === "intel_contribution_consent") return { data: { enabled: true, withdrawn_at: null }, error: null };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: new Date(NOW).toISOString(), ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate observation" } };
        }
        if (table === "intel_confirmations" && store.some((r) => r.claim_id === row.claim_id && r.actor_id === row.actor_id)) {
          return { data: null, error: { code: "23505", message: "duplicate confirmation" } };
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

  const auth = {
    async getUser(token: string) {
      return token === ACTOR || token === OTHER
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables, _reads: reads };
}

// ── Loopback HTTP over the REAL router ───────────────────────────────────────
const app = express();
app.use(express.json());
app.use(intelRouter);
const server = http.createServer(app);
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); _clearTestClient(); });

let keySeq = 0;
async function post(path: string, body: unknown, as = ACTOR, key = `plumb-${++keySeq}`) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${as}`, "idempotency-key": key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const snapshot = (capturedAt: string, accuracy: number | null = 15): Row => ({
  user_id: ACTOR, lat: INSIDE.lat, lng: INSIDE.lng, accuracy_meters: accuracy, captured_at: capturedAt, source: "gps",
});
const positionNow = () => snapshot(at(0));
const dwellFix = () => snapshot(at(20 * MIN));
const receiptAsset = (over: Row = {}): Row => ({
  id: MEDIA, owner_user_id: ACTOR, source_type: "camera", media_type: "image",
  provenance: { sourceType: "camera", capturedAt: at(2 * MIN), hasLocation: true, editHistory: [] },
  captured_at: at(2 * MIN), moderation_status: "approved", processing_status: "ready", visibility: "inherit",
  ...over,
});
const acceptedMission = (digest: string | null): Row => ({
  id: MISSION, city: "Da Nang", zone_id: null, subject_id: PLACE, claim_family: "crowd.level", trigger: "demand",
  coverage_score: 0.8, question: "How busy?", evidence_contract: {}, budget_units: 1, budget_committed: true,
  cash_amount: 0, status: "accepted", accepted_by: ACTOR, deadline: new Date(NOW + 60 * MIN).toISOString(),
  nonce: digest, nonce_consumed_at: null,
});

const ON = { intel_capture_quick_signal: true, [FLAG]: true };
const OFF = { intel_capture_quick_signal: true, [FLAG]: false };

const observation = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED,
  capturedAt: OBSERVED,
  ...over,
});

function use(db: ReturnType<typeof makeDb>) {
  _setTestClient(db, true);
  return db;
}

// ── The gap: P3 / P4 over HTTP ───────────────────────────────────────────────

describe("POST /v1/intel/observations — a receipt reaches P3 over the wire", () => {
  it("flag ON: geofence + dwell + an eligible receipt ⇒ P3, method receipt, audited", async () => {
    const db = use(makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], media_assets: [receiptAsset()] }));
    const r = await post("/v1/intel/observations", observation({
      presenceLevel: "P3",
      presenceAttestation: { receipt: { mediaAssetId: MEDIA } },
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.observation.presenceLevel, "P3");
    const stored = db._tables.intel_observations[0];
    assert.equal(stored.presence_level, "P3");
    assert.equal(stored.presence_attestation.verifier.method, "receipt");
    assert.equal(stored.presence_attestation.verifier.receipt.mediaAssetId, MEDIA);
    assert.equal(db._tables.intel_presence_verifications[0].level_reached, "P3");
  });

  it("the SAME request without the attestation field stays P2 — the reference is what reaches the rung", async () => {
    const db = use(makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], media_assets: [receiptAsset()] }));
    const r = await post("/v1/intel/observations", observation({ presenceLevel: "P3" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db._tables.intel_observations[0].presence_level, "P2");
    assert.ok(db._tables.intel_observations[0].presence_attestation.verifier.refusals.includes("receipt:no_reference"));
  });

  it("a receipt owned by someone else is refused server-side — the reference is checked, not believed", async () => {
    const db = use(makeDb(ON, {
      location_snapshots: [positionNow(), dwellFix()],
      media_assets: [receiptAsset({ owner_user_id: OTHER })],
    }));
    await post("/v1/intel/observations", observation({
      presenceLevel: "P3",
      presenceAttestation: { receipt: { mediaAssetId: MEDIA } },
    }));
    const stored = db._tables.intel_observations[0];
    assert.equal(stored.presence_level, "P2");
    assert.ok(stored.presence_attestation.verifier.refusals.includes("receipt:not_owner"));
  });
});

describe("POST /v1/intel/observations — a mission nonce reaches P4 over the wire", () => {
  it("flag ON: geofence + dwell + a valid nonce ⇒ P4, and the nonce is consumed once", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = use(makeDb(ON, {
      location_snapshots: [positionNow(), dwellFix()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    }));
    const r = await post("/v1/intel/observations", observation({
      presenceLevel: "P4",
      presenceAttestation: { mission: { missionId: MISSION, nonce: minted.token } },
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.observation.presenceLevel, "P4");
    const stored = db._tables.intel_observations[0];
    assert.equal(stored.presence_attestation.verifier.method, "mission_nonce");
    assert.ok(db._tables.intel_mission_candidates[0].nonce_consumed_at, "single-use nonce consumed");
    assert.equal(db._tables.intel_presence_verifications[0].level_reached, "P4");

    // Replayed over HTTP: same token, new idempotency key ⇒ no second P4.
    const again = await post("/v1/intel/observations", observation({
      presenceLevel: "P4",
      presenceAttestation: { mission: { missionId: MISSION, nonce: minted.token } },
    }));
    assert.equal(again.status, 201);
    const second = db._tables.intel_observations[1];
    assert.equal(second.presence_level, "P2");
    assert.ok(second.presence_attestation.verifier.refusals.includes("mission:replayed"));
  });

  it("a forged (well-formed but wrong) nonce never reaches P4", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const db = use(makeDb(ON, {
      location_snapshots: [positionNow(), dwellFix()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    }));
    await post("/v1/intel/observations", observation({
      presenceLevel: "P4",
      presenceAttestation: { mission: { missionId: MISSION, nonce: "f".repeat(MISSION_NONCE_TOKEN_HEX_LENGTH) } },
    }));
    const stored = db._tables.intel_observations[0];
    assert.equal(stored.presence_level, "P2");
    assert.ok(stored.presence_attestation.verifier.refusals.includes("mission:forged"));
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
  });
});

// ── The level is derived, never accepted ─────────────────────────────────────

describe("the presence LEVEL is always server-derived", () => {
  it("a level asserted INSIDE the attestation is a 400, not a value — nothing is stored", async () => {
    for (const attestation of [
      { level: "P4" },
      { presenceLevel: "P4" },
      { receipt: { mediaAssetId: MEDIA }, level: "P4" },
      { verifier: { geofence: "inside", level: "P4" } },
      { receipt: { mediaAssetId: MEDIA, capturedAt: OBSERVED } },
    ]) {
      const db = use(makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], media_assets: [receiptAsset()] }));
      const r = await post("/v1/intel/observations", observation({ presenceLevel: "P3", presenceAttestation: attestation }));
      assert.equal(r.status, 400, `${JSON.stringify(attestation)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "invalid_payload");
      assert.equal(db._tables.intel_observations.length, 0);
    }
  });

  it("a malformed reference is a 400 — no lookup is attempted", async () => {
    for (const attestation of [
      { receipt: { mediaAssetId: "not-a-uuid" } },
      { mission: { missionId: MISSION, nonce: "short" } },
      { mission: { missionId: "nope", nonce: "a".repeat(MISSION_NONCE_TOKEN_HEX_LENGTH) } },
      { mission: { missionId: MISSION } },
    ]) {
      const db = use(makeDb(ON, { location_snapshots: [positionNow(), dwellFix()], media_assets: [receiptAsset()] }));
      const r = await post("/v1/intel/observations", observation({ presenceLevel: "P4", presenceAttestation: attestation }));
      assert.equal(r.status, 400, `${JSON.stringify(attestation)} → ${JSON.stringify(r.body)}`);
      assert.equal(db._reads.media_assets ?? 0, 0);
      assert.equal(db._reads.intel_mission_candidates ?? 0, 0);
    }
  });

  it("a claimed level with NO evidence behind it stores P1, whatever the client asked for", async () => {
    for (const claimed of ["P2", "P3", "P4"]) {
      const db = use(makeDb(ON));
      const r = await post("/v1/intel/observations", observation({ presenceLevel: claimed }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.observation.presenceLevel, "P1", claimed);
      assert.equal(db._tables.intel_observations[0].presence_attestation.claimed, claimed);
      assert.equal(db._tables.intel_observations[0].presence_attestation.attested, false);
    }
  });

  it("a claimed P4 with only P2 evidence stores P2 — the claim is a ceiling, the evidence is the floor", async () => {
    const db = use(makeDb(ON, { location_snapshots: [positionNow(), dwellFix()] }));
    await post("/v1/intel/observations", observation({ presenceLevel: "P4" }));
    assert.equal(db._tables.intel_observations[0].presence_level, "P2");
  });
});

// ── The OFF path is unchanged ────────────────────────────────────────────────

describe("intel_presence_verification_enabled OFF is unchanged", () => {
  it("a full P4 attestation still stores P1, spends no nonce, reads no evidence table", async () => {
    const minted = mintMissionNonce(MISSION, ACTOR);
    const attestation = { receipt: { mediaAssetId: MEDIA }, mission: { missionId: MISSION, nonce: minted.token } };
    const db = use(makeDb(OFF, {
      location_snapshots: [positionNow(), dwellFix()],
      media_assets: [receiptAsset()],
      intel_mission_candidates: [acceptedMission(minted.digest)],
    }));
    const r = await post("/v1/intel/observations", observation({ presenceLevel: "P4", presenceAttestation: attestation }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const stored = db._tables.intel_observations[0];
    assert.equal(stored.presence_level, "P1");
    // EXACTLY resolvePresenceAttestation's output — the payload is recorded as
    // client provenance and nothing else changes.
    assert.deepEqual(stored.presence_attestation, resolvePresenceAttestation("P4", attestation).attestation);
    assert.equal("verifier" in stored.presence_attestation, false);
    assert.equal(db._tables.intel_mission_candidates[0].nonce_consumed_at, null);
    assert.equal(db._reads.media_assets ?? 0, 0);
    assert.equal(db._reads.location_snapshots ?? 0, 0);
    assert.equal(db._tables.intel_presence_verifications.length, 0);
  });

  it("a request that sends no attestation at all is byte-identical to before the field existed", async () => {
    const db = use(makeDb(OFF, { location_snapshots: [positionNow(), dwellFix()] }));
    await post("/v1/intel/observations", observation({ presenceLevel: "P2" }));
    assert.deepEqual(
      db._tables.intel_observations[0].presence_attestation,
      resolvePresenceAttestation("P2", undefined).attestation,
    );
  });
});

// ── Confirmations: the client's number is not the stored number ──────────────

describe("confirmClaim clamps the presence level it persists", () => {
  const seedClaim = (db: ReturnType<typeof makeDb>) => { db._tables.intel_claims.push({ id: CLAIM, status: "active" }); return db; };

  it("a client-claimed live-grade level cannot be persisted — P2/P3/P4 all store P1", async () => {
    for (const claimed of ["P2", "P3", "P4"]) {
      const db = seedClaim(makeDb(OFF));
      const out = await confirmClaim(db as any, CLAIM, ACTOR, "agree", OBSERVED, claimed);
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(db._tables.intel_confirmations[0].presence_level, "P1", claimed);
      assert.equal(db._tables.intel_confirmations[0].stance, "agree");
    }
  });

  it("over HTTP too: POST /v1/intel/claims/:id/confirm with presenceLevel P4 stores P1", async () => {
    const db = use(seedClaim(makeDb(OFF)));
    const r = await post(`/v1/intel/claims/${CLAIM}/confirm`, { stance: "agree", observedAt: OBSERVED, presenceLevel: "P4" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db._tables.intel_confirmations.length, 1);
    assert.equal(db._tables.intel_confirmations[0].presence_level, "P1");
    assert.equal(db._tables.intel_confirmations[0].actor_id, ACTOR, "actor comes from the session, never the body");
  });

  it("below-floor levels pass through unchanged, and a malformed one fails closed to P0", async () => {
    const db = seedClaim(makeDb(OFF));
    await confirmClaim(db as any, CLAIM, ACTOR, "agree", OBSERVED, "P1");
    assert.equal(db._tables.intel_confirmations[0].presence_level, "P1");

    const p0 = seedClaim(makeDb(OFF));
    await confirmClaim(p0 as any, CLAIM, ACTOR, "unsure", OBSERVED);
    assert.equal(p0._tables.intel_confirmations[0].presence_level, "P0");

    const junk = seedClaim(makeDb(OFF));
    await confirmClaim(junk as any, CLAIM, ACTOR, "disagree", OBSERVED, "P9" as any);
    assert.equal(junk._tables.intel_confirmations[0].presence_level, "P0");
  });
});
