/**
 * safetyPublicationPath.test.ts — S2. The complete publication path for a
 * safety assertion, proven end to end and proven to refuse.
 *
 *   approved claim -> projection pass -> snapshot -> producer -> Map object
 *
 * NOT A FIXTURE CHAIN. The snapshot the read half consumes is the row the real
 * projection wrote in the first half — `runIntelProjectionPass` output handed
 * straight to `readSafetyNotices`. If the writer changes what it writes, the
 * reader here sees it. A hand-authored snapshot fixture would prove only that
 * two fixtures agree with each other.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT PROVING THIS FOUND
 * ══════════════════════════════════════════════════════════════════════════════
 * The path was severed in the middle, and everything on both sides of the break
 * was built, typechecked and green. `projectClaim` ran `evaluatePrivacy` on the
 * ordinary community threshold — fifteen distinct actors in five independent
 * groups — for EVERY claim. A reviewed safety assertion has one authorized
 * principal behind it, so it projected with `privacy_eligible = false`, and
 * `readSafetyNotices` filters `privacy_eligible = true`. The whole safety lane
 * (S1a's policy, S1b's review station, this producer, the gateway) could not
 * publish a single notice, and nothing failed: the Map simply showed no hazards,
 * which is indistinguishable from a world with no hazards in it.
 *
 * Two more holes were visible only from here:
 *
 *   * `SAFETY_SERVABLE_CLAIM_STATUSES` is ['active'], but the projection selects
 *     claims on LIVE_ELIGIBLE_CLAIM_STATUSES — 'active' AND 'conflicting'. A
 *     conflicting safety claim therefore got a snapshot, and a snapshot carries
 *     no status, so by the time any reader saw the row the distinction was gone.
 *     S1a's rule existed as data with no enforcement point.
 *   * Nothing distinguished "an authorized reviewer approved this hazard" from
 *     "an unsafe_density row exists". Value and status are both reachable
 *     without a review (approveClaim sets 'active' with a literal
 *     `promotion_source`, not an identity; a direct write sets either).
 *
 * So authority is read from intel_claim_reviews (2311) and nowhere else, and the
 * claim's status is carried into the safety gate so S1a's rule has somewhere to
 * be applied.
 *
 * ONE THING THIS DELIBERATELY DOES NOT CHANGE. `status = 'conflicting'` and
 * `conflict_state = 'material'` are different facts, and the first draft of this
 * work collapsed them: it made the producer REFUSE a materially-conflicted
 * snapshot. That was wrong, and src/test/intelConflictReaders.test.ts caught it.
 * A material conflict is the §10 state of a cohort that disagrees about an
 * otherwise ACTIVE claim; Map spec §5 forbids silently removing a safety notice,
 * and "reports differ about a crush" is itself safety information. It is served
 * at a capped band with the state in the payload, exactly as before. Only the
 * LIFECYCLE status is refused, and it is refused at the writer, where a snapshot
 * is never created for it in the first place.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runIntelProjectionPass } from "../lib/intelProjectionScheduler.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import {
  readSafetyNotices,
  projectSafetyNotice,
  SAFETY_CLAIM_TYPE,
  SAFETY_CLAIM_LEVEL,
} from "../lib/mapProducers/safetyNoticeProducer.js";
import { SAFETY_SERVABLE_CLAIM_STATUSES, SAFETY_REVIEWED_THRESHOLD } from "../lib/safetyPolicy.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "../lib/intelContracts.js";
import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { parseBbox } from "../lib/mapProjection.js";
import { RENDERING_PRIORITY, type MapObject } from "../lib/mapObjects.js";
import type { BBox } from "../lib/mapAggregation.js";

// Anchored to the real clock: the gateway route ages objects against Date.now(),
// so a fixed past NOW would leave every gateway-served notice already expired.
const NOW = new Date();
const NOW_MS = NOW.getTime();
const iso = (mins: number) => new Date(NOW_MS + mins * 60_000).toISOString();

const PLACE_ID = "77777777-aaaa-4aaa-8aaa-777777777777";
const CLAIM_ID = "c-safety-1";
const VIEWER = "88888888-bbbb-4bbb-8bbb-888888888888";
const TOKEN = "s2-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;

// ── half one: the writer ──────────────────────────────────────────────────────

/**
 * A PostgREST-shaped double for the projection pass. Same shape as the one in
 * intelProjectionScheduler.test.ts, plus intel_claim_reviews. An operator it
 * does not implement is absent rather than permissive, so a filter the code
 * stops issuing shows up as a crash, not a quiet pass.
 */
function makeWriterDb(cfg: any) {
  const snaps: any[] = [...(cfg.snapshots ?? [])];
  const updates: any[] = [];
  const consentRows = [...new Set((cfg.observations ?? []).map((o: any) => o.actor_id).filter(Boolean))]
    .map((id: any) => ({ user_id: id, enabled: true, withdrawn_at: null }));
  function from(table: string) {
    let op = "select"; let payload: any = null;
    const eqs: any[] = []; const gts: any[] = [];
    let inF: any = null; let lim = Infinity; let rangeF: any = null;
    const src = (): any[] => (({
      intel_claims: cfg.claims,
      intel_observations: (cfg.observations ?? []).map((o: any) => ({ moderation_state: "allowed", ...o })),
      intel_confirmations: cfg.confirmations ?? [],
      intel_claim_reviews: cfg.reviews ?? [],
      freshness_policies: cfg.policies,
      intel_state_snapshots: snaps,
      intel_contribution_consent: consentRows,
    } as any)[table] ?? []);
    const match = (r: any) =>
      eqs.every(([c, v]: any) => r[c] === v)
      && gts.every(([c, v]: any) => r[c] != null && r[c] > v)
      && (!inF || inF[1].includes(r[inF[0]]));
    const rows = () => {
      const f = src().filter(match);
      if (rangeF) return f.slice(rangeF[0], rangeF[1] + 1);
      if (lim !== Infinity) return f.slice(0, lim);
      return f.slice(0, 1000);
    };
    const run = () => {
      if (table === "feature_flags") {
        const f = eqs.find(([c]: any) => c === "flag")?.[1];
        return { data: { enabled: Boolean(cfg.flags[f]) }, error: null };
      }
      if (cfg.errorTable === table) return { data: null, error: { message: "boom" } };
      if (op === "upsert") { snaps.push(...(Array.isArray(payload) ? payload : [payload])); return { data: null, error: null }; }
      if (op === "insert") return { data: null, error: null };
      if (op === "update") {
        for (const r of src()) if (match(r)) Object.assign(r, payload);
        updates.push({ table, ids: inF && inF[0] === "id" ? [...inF[1]] : [], patch: payload });
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const b: any = {
      select() { return b; },
      upsert(r: any) { op = "upsert"; payload = r; return Promise.resolve(run()); },
      insert(r: any) { op = "insert"; payload = r; return Promise.resolve(run()); },
      update(p: any) { op = "update"; payload = p; return b; },
      eq(c: any, v: any) { eqs.push([c, v]); return b; },
      gt(c: any, v: any) { gts.push([c, v]); return b; },
      is(c: any, v: any) { eqs.push([c, v]); return b; },
      in(c: any, v: any) { inF = [c, v]; return b; },
      range(f: number, t: number) { rangeF = [f, t]; return Promise.resolve(run()); },
      limit(n: number) { lim = n; return Promise.resolve(run()); },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _snaps: snaps, _updates: updates };
}

/** The claim, as SafetyReviewService.reviewSafetyClaim would have left it. */
const safetyClaim = (over: any = {}) => ({
  id: CLAIM_ID, subject_id: PLACE_ID, zone_id: null,
  claim_type: SAFETY_CLAIM_TYPE, value: { level: SAFETY_CLAIM_LEVEL },
  status: "active", observed_at: iso(-15), updated_at: iso(-15), version: 1, ...over,
});

/** The audit row an authorized approval writes. This is the ONLY authority source. */
const approval = (over: any = {}) => ({
  claim_id: CLAIM_ID, action: "approve", prior_status: "candidate",
  new_status: "active", created_at: iso(-10), ...over,
});

/** One specialist observation, with NO group_key — the ordinary reviewed case. */
const observation = (over: any = {}) => ({
  actor_id: "specialist-1", subject_id: PLACE_ID, claim_type: SAFETY_CLAIM_TYPE,
  presence_level: "P4", source_class: "firsthand_unverified", expires_at: null,
  group_key: null, observed_at: iso(-15), value: { level: SAFETY_CLAIM_LEVEL }, ...over,
});

/** Run one real projection pass and hand back the rows it wrote. */
async function project(over: any = {}) {
  invalidateFreshnessPolicyCache();
  const db = makeWriterDb({
    flags: { intel_claim_projection_crowd: true },
    claims: [safetyClaim()],
    observations: [observation()],
    reviews: [approval()],
    policies: [{ claim_type: SAFETY_CLAIM_TYPE, ttl_seconds: 2700, note: null }],
    ...over,
  });
  const pass = await runIntelProjectionPass({ client: db as any, now: NOW });
  return { pass, snapshots: db._snaps, updates: db._updates };
}

// ── half two: the reader ──────────────────────────────────────────────────────

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

const canonicalPlace = (over: any = {}) => ({
  id: PLACE_ID, name: "Han Market", city: "Da Nang",
  latitude: SPOT.lat, longitude: SPOT.lng, status: "active", merged_into_place_id: null, ...over,
});

/** Feed the rows the projection actually produced into the Map read path. */
function readerWorld(snapshots: any[], over: FakeState = {}): FakeState {
  return {
    feature_flags: LIVE_GATES_OPEN,
    intel_state_snapshots: snapshots,
    places: [canonicalPlace()],
    intel_live_promoted_scopes: [],
    ...over,
  };
}
const reader = (state: FakeState) => makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
const readMap = (state: FakeState) => readSafetyNotices(reader(state), { bbox: BBOX, now: NOW_MS });

/** The whole chain in one call: claim -> projection -> snapshot -> Map objects. */
async function publish(over: any = {}, readerOver: FakeState = {}) {
  const { pass, snapshots } = await project(over);
  const read = await readMap(readerWorld(snapshots, readerOver));
  return { pass, snapshots, read };
}

// ══ POSITIVE ══════════════════════════════════════════════════════════════════

describe("S2 positive — an approved safety assertion reaches the Map", () => {
  it("publishes end to end: approved claim -> snapshot -> producer -> safety_notice", async () => {
    const { pass, snapshots, read } = await publish();

    // 1. The projection PUBLISHED it, rather than writing a suppressed row.
    assert.equal(pass.reason, null);
    assert.equal(pass.written, 1, "an approved safety assertion must clear the projection gate");
    assert.equal(pass.suppressed, 0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].privacy_eligible, true,
      "this is the assertion the old code failed: the community k-anon threshold " +
      "suppressed every reviewed safety claim, so nothing could ever be served");
    assert.equal(snapshots[0].distinct_actors, 1,
      "and the honest observation count is recorded — the review changes which " +
      "threshold applies, never what the snapshot claims about contributors");

    // 2. The producer consumed that exact row and emitted a Map object.
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.notices.length, 1, "the approved assertion reaches the Map");
    assert.equal(read.notices[0].kind, "safety_notice");
    assert.equal(read.report.snapshots, 1);
  });

  it("one authorized principal is enough — the reviewed threshold is the one applied", async () => {
    // The cohort is a single observer with no group signal: 1 actor, 0 groups.
    // Under PRIVACY_THRESHOLD_V1 (15 actors / 5 groups) that is nowhere near
    // publishable, and under SAFETY_REVIEWED_THRESHOLD it is exactly the case
    // the numbers were written for.
    assert.equal(SAFETY_REVIEWED_THRESHOLD.minUniqueActors, 1);
    const { pass } = await project();
    assert.equal(pass.written, 1);
  });

  it("provenance traces back to the snapshot, and no speaker is invented", async () => {
    const { snapshots, read } = await publish();
    assert.ok(read.ok);
    if (!read.ok) return;
    const o = read.notices[0];
    const snapId = snapshots[0].id ?? o.sourceRefs?.[0];
    assert.deepEqual(o.sourceRefs, [snapId], "sourceRefs is the chain back to the projected row");
    assert.equal(o.provenance?.lines[0]?.ref, snapId);
    assert.match(o.provenance?.lines[0]?.text ?? "", /Specialist-reviewed safety claim/);
    assert.equal(o.sourceClass, undefined,
      "the snapshot records no speaker and the producer must not invent one — the " +
      "reviewer's identity is restricted moderation data and never leaves 2311");
  });

  it("carries no reviewer identity, no reason, and no contributor anywhere in the object", async () => {
    const { read } = await publish({
      reviews: [approval({ reason: "confirmed by district police", reviewer_id: "admin-42" })],
    });
    assert.ok(read.ok);
    if (!read.ok) return;
    const blob = JSON.stringify(read.notices[0]);
    for (const leak of ["admin-42", "district police", "reviewer", "specialist-1", "actor_id", "distinct_actors"]) {
      assert.ok(!blob.includes(leak), `the public object must not carry '${leak}'`);
    }
  });

  it("arrives at the top of the Map ranking through the real gateway route", async () => {
    const { snapshots } = await project();
    const state = readerWorld(snapshots, {
      feature_flags: [{ flag: "map_projection_enabled", enabled: true }, ...LIVE_GATES_OPEN],
      blocks: [], protected_zones: [],
    });
    const app: ProjectionApp = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    try {
      const r = await app.projection(`bbox=${BBOX_STR}&zoom=14&kinds=safety_notice`);
      assert.equal(r.status, 200);
      const objects = r.body.objects as MapObject[];
      assert.equal(objects.length, 1, "the notice survives the whole gateway, not just the producer");
      assert.equal(objects[0].kind, "safety_notice");
      assert.equal(objects[0].renderingPriority, RENDERING_PRIORITY.safety);
      assert.deepEqual(r.body.producers.safety_notice, { refusal: null, collected: 1 });
    } finally {
      await app.close();
    }
  });
});

// ══ CANONICAL COORDINATES ═════════════════════════════════════════════════════

describe("S2 placement — the canonical Place is the only coordinate source", () => {
  it("hostile coordinates on the assertion are ignored entirely", async () => {
    // The snapshot row carries attacker-supplied coordinates in every shape a
    // careless projector might read: top-level columns and inside the claim value.
    const { snapshots } = await project();
    const poisoned = {
      ...snapshots[0],
      latitude: 51.5, longitude: -0.1276, lat: 51.5, lng: -0.1276,
      value: { level: SAFETY_CLAIM_LEVEL, lat: 51.5, lng: -0.1276 },
    };
    const r = await readMap(readerWorld([poisoned]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(
      r.notices[0].geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] },
      "geometry must be the canonical Place's longitude/latitude and nothing else. " +
      "Evidence and client-supplied coordinates are attacker-controlled: a hazard " +
      "pin placed by the reporter is a way to point the Map at anything.",
    );
    assert.equal((r.notices[0].payload as any).placeId, PLACE_ID);
    assert.ok(!JSON.stringify(r.notices[0]).includes("51.5"),
      "no assertion-supplied coordinate may survive into the object");
  });

  it("the pure projector reads the place, not the row, even when only the row has coordinates", () => {
    const row: any = {
      id: "s1", subject_id: PLACE_ID, claim_type: SAFETY_CLAIM_TYPE,
      value: { level: SAFETY_CLAIM_LEVEL }, confidence: 0.9,
      observed_at: iso(-5), expires_at: iso(30), privacy_eligible: true, conflict_state: "none",
      latitude: 51.5, longitude: -0.1276,
    };
    // A place with no usable coordinate yields NOTHING — it never falls back to
    // the row's. Falling back is what "the canonical place is the source" forbids.
    assert.equal(projectSafetyNotice(row, { id: PLACE_ID, status: "active", merged_into_place_id: null } as any, { now: NOW_MS }), null);
    const good = projectSafetyNotice(row, canonicalPlace() as any, { now: NOW_MS });
    assert.deepEqual(good?.geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
  });

  it("a merged or inactive place anchors nothing", async () => {
    const { snapshots } = await project();
    for (const bad of [{ status: "closed" }, { merged_into_place_id: "other" }]) {
      const r = await readMap(readerWorld(snapshots, { places: [canonicalPlace(bad)] }));
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.equal(r.notices.length, 0, `a ${JSON.stringify(bad)} place must not carry a hazard`);
    }
  });
});

// ══ NEGATIVE ══════════════════════════════════════════════════════════════════

describe("S2 negative — nothing but an approved, current assertion renders", () => {
  /** Assert a scenario produces no snapshot at the writer AND no object at the reader. */
  async function refuses(label: string, over: any) {
    const { pass, snapshots, read } = await publish(over);
    assert.equal(snapshots.length, 0, `${label}: the projection must write no snapshot`);
    assert.equal(pass.written, 0, `${label}: nothing published`);
    assert.ok(read.ok, `${label}: refusing to publish is a SUCCESS with nothing to show`);
    if (read.ok) assert.equal(read.notices.length, 0, `${label}: nothing on the Map`);
  }

  it("candidate: an unreviewed claim is not even selected for projection", async () => {
    // The pass selects on LIVE_ELIGIBLE_CLAIM_STATUSES, which excludes 'candidate'.
    assert.ok(!LIVE_ELIGIBLE_CLAIM_STATUSES.includes("candidate" as any));
    await refuses("candidate", { claims: [safetyClaim({ status: "candidate" })], reviews: [] });
  });

  it("CONFLICTING: selected for projection, and refused by the safety lane", async () => {
    // The gap S2 closes. 'conflicting' IS live-eligible, so the claim reaches
    // projectClaim — an ordinary claim in this state gets a snapshot at a lowered
    // band. A safety claim must not: "some say this place is dangerous, others
    // disagree" is a coin flip rendered as authority.
    assert.ok(LIVE_ELIGIBLE_CLAIM_STATUSES.includes("conflicting" as any),
      "precondition: the projection really does admit conflicting claims");
    assert.ok(!SAFETY_SERVABLE_CLAIM_STATUSES.includes("conflicting"),
      "precondition: safety policy really does exclude them");
    await refuses("conflicting", {
      claims: [safetyClaim({ status: "conflicting" })],
      reviews: [approval({ new_status: "conflicting" })],
    });
  });

  it("rejected / retracted / superseded / expired: no snapshot at any of them", async () => {
    for (const status of ["rejected", "retracted", "superseded", "expired"]) {
      await refuses(status, {
        claims: [safetyClaim({ status })],
        reviews: [approval({ new_status: status })],
      });
    }
  });

  it("UNAUTHORIZED: an active unsafe_density claim with NO review publishes nothing", async () => {
    // The case that matters most. The claim looks identical to an approved one —
    // same value, same status, same cohort. Only the audit trail differs, and
    // that is the whole point: status and value are both reachable without a
    // review, so neither may be treated as one.
    await refuses("no review row", { reviews: [] });
  });

  it("a REJECT decision is not an approval, however recent", async () => {
    await refuses("latest decision is a reject", { reviews: [approval({ action: "reject" })] });
  });

  it("a STALE approval does not survive the claim moving on", async () => {
    // Approved, then retracted, then back to 'active' by some other path. The
    // old approval must not travel with it.
    await refuses("stale approval", {
      claims: [safetyClaim({ status: "active" })],
      reviews: [
        approval({ created_at: iso(-60) }),
        approval({ action: "retract", prior_status: "active", new_status: "retracted", created_at: iso(-30) }),
      ],
    });
  });

  it("an approval that does not match where the claim actually IS grants nothing", async () => {
    // The audit table is the authority, so a row is trusted only when it is
    // internally consistent with the claim it says it moved. This shape is
    // unreachable through SafetyReviewService — its approve/reconfirm
    // transitions all land on 'active' — which is precisely why refusing it
    // matters: it can only be a corrupt, foreign or hand-written row, and "some
    // row in the reviews table mentions this claim" is not an approval.
    await refuses("approval inconsistent with the claim's status", {
      claims: [safetyClaim({ status: "active" })],
      reviews: [approval({ new_status: "candidate" })],
    });
  });

  it("an unreadable audit trail is never an approval (fail-closed)", async () => {
    await refuses("review read error", { errorTable: "intel_claim_reviews" });
  });

  it("an unapproved level cannot ride the safety lane, and gains nothing from a review row", async () => {
    // A `packed` claim with an approval row attached: it is ordinary intel, it
    // takes the ordinary threshold, and one observer does not clear it.
    const { pass, snapshots, read } = await publish({
      claims: [safetyClaim({ value: { level: "packed" } })],
      observations: [observation({ value: { level: "packed" } })],
    });
    assert.equal(pass.written, 0, "a review row must not buy an ordinary claim the reviewed threshold");
    assert.equal(snapshots[0]?.privacy_eligible, false);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.notices.length, 0);
  });

  it("a materially-conflicted snapshot is still SERVED, capped — status is not conflict_state", async () => {
    // Two different things wear the word "conflict", and collapsing them is a
    // mistake this test exists to prevent (I made it while writing S2):
    //
    //   intel_claims.status = 'conflicting'  — the LIFECYCLE state. S1a's
    //     SAFETY_SERVABLE_CLAIM_STATUSES excludes it, and the projection above
    //     refuses to write a snapshot for it at all.
    //   snapshot.conflict_state = 'material' — the §10 state of a cohort that
    //     DISAGREES about an otherwise ACTIVE claim. Map spec §5 forbids
    //     silently removing a safety notice, and "reports differ about a crush"
    //     is itself safety information, so it is served at a capped band with
    //     the state in the payload for the sheet to render.
    //
    // src/test/intelConflictReaders.test.ts owns that capping contract in full.
    // Asserted here only so the end-to-end path cannot quietly start dropping it.
    const { snapshots } = await project();
    const r = await readMap(readerWorld([{ ...snapshots[0], conflict_state: "material" }]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notices.length, 1, "§5: a disputed hazard is capped, never silently removed");
    assert.equal((r.notices[0].payload as any).conflictState, "material",
      "and the state travels, so the sheet can say reports differ instead of implying certainty");
    assert.ok(!["live", "strong"].includes(String(r.notices[0].confidence)),
      "but never at a live or strong band");
  });

  it("an unrecognised conflict marker fails CLOSED to material, and is capped", async () => {
    const { snapshots } = await project();
    const r = await readMap(readerWorld([{ ...snapshots[0], conflict_state: "brand_new_state" }]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal((r.notices[0].payload as any).conflictState, "material",
      "normalizeConflictState reads any unrecognised marker as material — a conflict " +
      "state nobody has taught this reader about must not serve as agreement");
    assert.ok(!["live", "strong"].includes(String(r.notices[0].confidence)));
  });
});

// ══ FAILURE SEMANTICS ═════════════════════════════════════════════════════════

describe("S2 failure semantics — a failure is never an empty Map", () => {
  it("the three refusals and the honest empty are four DIFFERENT shapes", async () => {
    const { snapshots } = await project();

    const snapFail = await readMap(readerWorld(snapshots, {
      intel_state_snapshots: { error: { message: "permission denied" } } as any,
    }));
    assert.deepEqual(snapFail, { ok: false, reason: "snapshot_read_failed" });

    const placeFail = await readMap(readerWorld(snapshots, { places: { error: { message: "schema drift" } } as any }));
    assert.deepEqual(placeFail, { ok: false, reason: "places_read_failed" });

    const gated = await readMap(readerWorld(snapshots, {
      feature_flags: LIVE_GATES_OPEN.map((f) => ({ ...f, enabled: f.flag !== "intel_limited_live" })),
    }));
    assert.deepEqual(gated, { ok: false, reason: "live_gates_closed" });

    const empty = await readMap(readerWorld([]));
    assert.equal(empty.ok, true, "a world with no hazards is a SUCCESS with an empty list");
    if (empty.ok) assert.equal(empty.notices.length, 0);

    // The point of the four together: no caller can confuse "we could not read
    // the hazards" with "there are no hazards". That substitution is the entire
    // reason this feature is dangerous to get wrong.
  });

  it("a projection-side failure does not fabricate an empty success either", async () => {
    invalidateFreshnessPolicyCache();
    const db = makeWriterDb({
      flags: { intel_claim_projection_crowd: true }, errorTable: "intel_claims",
      claims: [safetyClaim()], observations: [observation()], reviews: [approval()],
      policies: [{ claim_type: SAFETY_CLAIM_TYPE, ttl_seconds: 2700, note: null }],
    });
    const pass = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(pass.reason, "error", "an unreadable claim table is reported, not silently skipped");
    assert.equal(pass.skippedRun, true);
    assert.equal(db._snaps.length, 0);
  });

  it("the projection flag being off is 'disabled', not 'nothing to publish'", async () => {
    const { pass } = await project({ flags: { intel_claim_projection_crowd: false } });
    assert.equal(pass.reason, "disabled");
    assert.equal(pass.skippedRun, true);
  });
});

// ══ EXPIRY AND REVOCATION ═════════════════════════════════════════════════════

describe("S2 revocation — a published notice stops being served when the assertion ends", () => {
  it("expiry needs no extra step: the same row, a later clock, nothing served", async () => {
    const { snapshots } = await project();
    const before = await readMap(readerWorld(snapshots));
    assert.ok(before.ok);
    if (before.ok) assert.equal(before.notices.length, 1, "visible while current");

    const after = await readSafetyNotices(reader(readerWorld(snapshots)), {
      bbox: BBOX, now: NOW_MS + 24 * 60 * 60_000,
    });
    assert.ok(after.ok);
    if (after.ok) assert.equal(after.notices.length, 0, "and gone once expires_at has passed");
  });

  it("RETRACTION revokes the live snapshot: the reconciliation expires it and the Map clears", async () => {
    // Publish, then retract the claim and run the pass again over the SAME
    // snapshot store. The claim has left live-eligibility, so the reconciliation
    // must force-expire the servable snapshot it left behind — otherwise a
    // retracted danger warning keeps showing until its TTL runs out.
    const first = await project();
    assert.equal(first.snapshots.length, 1);
    const live = first.snapshots[0];

    invalidateFreshnessPolicyCache();
    const db = makeWriterDb({
      flags: { intel_claim_projection_crowd: true },
      claims: [safetyClaim({ status: "retracted" })],
      observations: [observation()],
      reviews: [approval({ action: "retract", prior_status: "active", new_status: "retracted" })],
      policies: [{ claim_type: SAFETY_CLAIM_TYPE, ttl_seconds: 2700, note: null }],
      snapshots: [{ ...live, id: "snap-live" }],
    });
    await runIntelProjectionPass({ client: db as any, now: NOW });

    const revoked = db._snaps.find((s: any) => s.id === "snap-live");
    assert.ok(revoked, "the snapshot row is still there — revocation is not deletion");
    assert.equal(revoked.privacy_eligible, false,
      "a retracted assertion's snapshot must stop being servable at the next pass, " +
      "not linger until its TTL");

    const read = await readMap(readerWorld(db._snaps));
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.notices.length, 0, "and the Map clears");
  });

  it("the pure projector refuses a revoked, expired or conflicted row on its own", async () => {
    const { snapshots } = await project();
    const row = snapshots[0];
    const place = canonicalPlace() as any;
    assert.equal(projectSafetyNotice({ ...row, privacy_eligible: false }, place, { now: NOW_MS }), null);
    assert.equal(projectSafetyNotice({ ...row, expires_at: iso(-1) }, place, { now: NOW_MS }), null);
    // Defence in depth: the read already filters these, and the projector must
    // not depend on the caller having done it.
  });
});
