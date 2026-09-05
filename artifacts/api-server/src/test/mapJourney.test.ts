/**
 * §36 Phase 6 — group decision and recovery.
 *
 * The three properties the unit is judged on:
 *
 *   1. THE GROUP DECISION NEVER LEAKS A CREW COORDINATE (§23). A crew card is
 *      fed through the projection WITH `exactCoords` populated — the shape a
 *      live-share grant actually produces — and the SERIALIZED response is
 *      searched for the coordinate. Not the object: the JSON, because a type
 *      that omits a field does not stop a spread from carrying it to the wire.
 *   2. RECOVERY FIRES ONLY ON A REAL LIVE CONSTRAINT, AND CITES IT. The same
 *      walk-in denial is replayed as emerging, as a prediction source class, as
 *      an expired claim and as a weak band; none of them may produce a live
 *      recovery. The one that clears `isLiveConstraintEligible` produces one,
 *      and it carries the claim reference it acted on.
 *   3. A SCHEDULE FACT IS NEVER DRESSED AS AN OBSERVATION (§37). A missed
 *      window carries `evidence.kind: 'schedule'` and there is no branch that
 *      can give it a claimRef.
 *
 * Plus the route: membership is checked BEFORE the flag (so a stranger cannot
 * probe whether Phase 6 is on for someone else's trip), a disabled flag records
 * nothing, and a vote on a non-candidate item is refused.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapJourney.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import mapJourneyRouter from "../routes/mapJourney.js";
import {
  MIN_ACCEPTS_FOR_READY,
  SHORTLIST_MAX,
  buildShortlist,
  tallyItem,
  toCrewAreas,
  type ShortlistItemRow,
  type VoteRow,
} from "../lib/journeyGroupDecision.js";
import {
  MISSED_WINDOW_GRACE_MINUTES,
  RECOVERABLE_CLOSURE_STATES,
  closureStateOf,
  computeRecovery,
  type PlannedStop,
  type RecoveryCandidate,
} from "../lib/journeyRecovery.js";
import type { CrewMemberCard } from "../lib/tripCrewLocation.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const MIN = 60_000;

// ── fixtures ──────────────────────────────────────────────────────────────────

/** The coordinate a live-share grant would put on a crew card. Never servable. */
const LIVE_SHARE_LAT = 16.0491234;
const LIVE_SHARE_LNG = 108.2013579;

function crewCard(over: Partial<CrewMemberCard> = {}): CrewMemberCard {
  return {
    userId: "crew-1",
    name: "Mai",
    handle: "mai",
    avatarUrl: null,
    statusLabel: "in_area",
    areaLabel: "Riverside",
    exactCoords: { lat: LIVE_SHARE_LAT, lng: LIVE_SHARE_LNG },
    planCheckInStatus: null,
    safeReturnActive: false,
    liveShareActive: true,
    liveShareExpiresAt: null,
    ghostMode: false,
    updatedAt: null,
    ...over,
  } as CrewMemberCard;
}

function planRow(over: Partial<ShortlistItemRow> = {}): ShortlistItemRow {
  return {
    id: "item-1",
    trip_id: "trip-1",
    title: "Bánh mì stall",
    category: "dining",
    status: "tentative",
    starts_at: null,
    location_name: "An Thuong",
    sort_order: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function envelope(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  const now = Date.now();
  return {
    id: "claim-ref-1",
    claimType: "access.walk_in",
    value: { accepted: false },
    confidence: 0.9,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "several",
    observedAt: new Date(now - 5 * MIN).toISOString(),
    validUntil: new Date(now + 25 * MIN).toISOString(),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  } as LiveClaimEnvelope;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Group decision — the shortlist projection
// ═══════════════════════════════════════════════════════════════════════════

describe("group decision — §23: crew members are coarse areas, never coordinates", () => {
  it("drops exactCoords from a live-sharing crew member", () => {
    const areas = toCrewAreas([crewCard()]);
    assert.equal(areas.length, 1);
    assert.equal(areas[0]!.areaLabel, "Riverside");
    // The projection has no coordinate FIELD at all.
    assert.deepEqual(Object.keys(areas[0]!).sort(), ["areaLabel", "name", "statusLabel", "userId"]);
  });

  it("the SERIALIZED shortlist contains no crew coordinate", () => {
    const projection = buildShortlist({
      rows: [planRow()],
      votes: [],
      eligibleMemberIds: ["viewer", "crew-1"],
      viewerId: "viewer",
      crew: [crewCard()],
    });
    const json = JSON.stringify(projection);
    assert.ok(!json.includes(String(LIVE_SHARE_LAT)), "no live-share latitude on the wire");
    assert.ok(!json.includes(String(LIVE_SHARE_LNG)), "no live-share longitude on the wire");
    assert.ok(!json.includes("exactCoords"), "no exactCoords key on the wire");
    assert.ok(!/"lat"|"lng"/.test(json), "no lat/lng key anywhere in the projection");
    // …and the coarse label DID survive, so this is not passing by emptiness.
    assert.equal(projection.crew[0]!.areaLabel, "Riverside");
  });

  it("hides ghost-mode members and members sharing nothing", () => {
    const areas = toCrewAreas([
      crewCard({ userId: "ghost", ghostMode: true }),
      crewCard({ userId: "hidden", statusLabel: "location_hidden" }),
      crewCard({ userId: "none", statusLabel: "not_shared" }),
      crewCard({ userId: "visible" }),
    ]);
    assert.deepEqual(areas.map((a) => a.userId), ["visible"]);
  });
});

describe("group decision — the tally", () => {
  const eligible = new Set(["a", "b", "c"]);

  it("a decline BLOCKS, it does not subtract", () => {
    const votes: VoteRow[] = [
      { plan_item_id: "i", user_id: "a", vote: "accept" },
      { plan_item_id: "i", user_id: "b", vote: "accept" },
      { plan_item_id: "i", user_id: "c", vote: "decline" },
    ];
    const t = tallyItem(votes, eligible, "a");
    assert.equal(t.accepts, 2);
    assert.equal(t.declines, 1);
    assert.equal(t.readyToConfirm, false, "a majority must not overrule someone on the trip");
    assert.equal(t.blockedBy, "declined");
  });

  it("is not ready while anyone has yet to vote", () => {
    const t = tallyItem(
      [
        { plan_item_id: "i", user_id: "a", vote: "accept" },
        { plan_item_id: "i", user_id: "b", vote: "accept" },
      ],
      eligible,
      "a",
    );
    assert.equal(t.pending, 1);
    assert.equal(t.readyToConfirm, false);
    assert.equal(t.blockedBy, "awaiting_votes");
  });

  it("is ready when every eligible member has accepted", () => {
    const t = tallyItem(
      [
        { plan_item_id: "i", user_id: "a", vote: "accept" },
        { plan_item_id: "i", user_id: "b", vote: "accept" },
        { plan_item_id: "i", user_id: "c", vote: "accept" },
      ],
      eligible,
      "b",
    );
    assert.equal(t.readyToConfirm, true);
    assert.equal(t.blockedBy, null);
    assert.equal(t.myVote, "accept");
  });

  it("one person accepting alone is not a group decision", () => {
    const solo = new Set(["a"]);
    const t = tallyItem([{ plan_item_id: "i", user_id: "a", vote: "accept" }], solo, "a");
    assert.equal(t.accepts, 1);
    assert.ok(t.accepts < MIN_ACCEPTS_FOR_READY);
    assert.equal(t.readyToConfirm, false);
    assert.equal(t.blockedBy, "too_few_accepts");
  });

  it("ignores votes from users who are no longer members", () => {
    const t = tallyItem(
      [
        { plan_item_id: "i", user_id: "a", vote: "accept" },
        { plan_item_id: "i", user_id: "b", vote: "accept" },
        { plan_item_id: "i", user_id: "c", vote: "accept" },
        { plan_item_id: "i", user_id: "removed-member", vote: "decline" },
      ],
      eligible,
      "a",
    );
    assert.equal(t.declines, 0, "a removed member's vote must not keep deciding the trip");
    assert.equal(t.readyToConfirm, true);
  });

  it("ignores an unrecognised vote value rather than counting it", () => {
    const t = tallyItem([{ plan_item_id: "i", user_id: "a", vote: "maybe" }], eligible, "a");
    assert.equal(t.accepts, 0);
    assert.equal(t.declines, 0);
    assert.equal(t.pending, 3);
    assert.equal(t.myVote, null);
  });
});

describe("group decision — the shortlist is bounded and is the PLAN", () => {
  it("only 'tentative' items are candidates", () => {
    const p = buildShortlist({
      rows: [
        planRow({ id: "tentative", status: "tentative" }),
        planRow({ id: "confirmed", status: "confirmed" }),
        planRow({ id: "done", status: "done" }),
        planRow({ id: "cancelled", status: "cancelled" }),
      ],
      votes: [],
      eligibleMemberIds: ["a"],
      viewerId: "a",
    });
    assert.deepEqual(p.items.map((i) => i.id), ["tentative"]);
  });

  it("caps at SHORTLIST_MAX and REPORTS the overflow", () => {
    const rows = Array.from({ length: SHORTLIST_MAX + 5 }, (_, i) =>
      planRow({ id: `item-${i}`, sort_order: i }),
    );
    const p = buildShortlist({ rows, votes: [], eligibleMemberIds: ["a"], viewerId: "a" });
    assert.equal(p.items.length, SHORTLIST_MAX);
    assert.equal(p.truncated, 5);
  });

  it("orders by time then plan order — never by vote count", () => {
    const rows = [
      planRow({ id: "later", starts_at: "2026-09-05T18:00:00.000Z" }),
      planRow({ id: "sooner", starts_at: "2026-09-05T09:00:00.000Z" }),
      planRow({ id: "undated", starts_at: null, sort_order: 1 }),
    ];
    const votes: VoteRow[] = [
      { plan_item_id: "later", user_id: "a", vote: "accept" },
      { plan_item_id: "later", user_id: "b", vote: "accept" },
    ];
    const p = buildShortlist({ rows, votes, eligibleMemberIds: ["a", "b"], viewerId: "a" });
    assert.deepEqual(p.items.map((i) => i.id), ["sooner", "later", "undated"]);
  });

  it("carries a place NAME and never a geometry", () => {
    const p = buildShortlist({
      rows: [planRow()],
      votes: [],
      eligibleMemberIds: ["a"],
      viewerId: "a",
    });
    assert.equal(p.items[0]!.locationName, "An Thuong");
    assert.deepEqual(
      Object.keys(p.items[0]!).sort(),
      ["category", "id", "locationName", "startsAt", "tally", "title"],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Recovery
// ═══════════════════════════════════════════════════════════════════════════

const STOP: PlannedStop = {
  id: "stop-1",
  title: "Madame Lân",
  category: "dining",
  subjectId: "subject-1",
  endsAt: null,
};

const CANDIDATES: RecoveryCandidate[] = [
  { id: "alt-1", title: "Bếp Cuốn", category: "dining", score: 90 },
  { id: "alt-2", title: "Museum", category: "activity", score: 95 },
];

function recoverWith(envelopes: LiveClaimEnvelope[], over: Partial<PlannedStop> = {}) {
  return computeRecovery({
    stops: [{ ...STOP, ...over }],
    envelopesBySubject: new Map([["subject-1", envelopes]]),
    candidates: CANDIDATES,
    nowMs: Date.now(),
  });
}

describe("recovery — fires only on a REAL live constraint, and cites it", () => {
  it("a live walk-in denial fires, names the reason and carries the claim ref", () => {
    const r = recoverWith([envelope()]);
    assert.equal(r.entries.length, 1);
    const e = r.entries[0]!;
    assert.equal(e.stopId, "stop-1");
    assert.equal(e.reasonCode, "walk_in_denied");
    assert.ok(e.reason.length > 0, "the reason is stated, not implied");
    assert.equal(e.evidence.kind, "live");
    assert.equal(e.evidence.kind === "live" ? e.evidence.claimRef : null, "claim-ref-1");
    assert.equal(e.evidence.kind === "live" ? e.evidence.claimType : null, "access.walk_in");
    // Same category, not the higher-scoring museum.
    assert.equal(e.alternativeId, "alt-1");
    assert.equal(e.alternativeTitle, "Bếp Cuốn");
  });

  it("an EMERGING claim does not fire a recovery", () => {
    const r = recoverWith([envelope({ state: "emerging" })]);
    assert.equal(r.entries.length, 0, "emerging is a nudge, never a reroute");
    assert.equal(r.weakEvidenceStops, 1, "and the weak evidence is reported, not hidden");
  });

  it("a PREDICTION source class does not fire a recovery (§37)", () => {
    const r = recoverWith([envelope({ sourceClass: "portava_prediction" } as Partial<LiveClaimEnvelope>)]);
    assert.equal(r.entries.length, 0);
    assert.equal(r.weakEvidenceStops, 1);
  });

  it("a HISTORICAL PATTERN does not fire a recovery", () => {
    const r = recoverWith([envelope({ sourceClass: "historical_pattern" } as Partial<LiveClaimEnvelope>)]);
    assert.equal(r.entries.length, 0);
  });

  it("an EXPIRED claim does not fire a recovery", () => {
    const r = recoverWith([envelope({ validUntil: new Date(Date.now() - MIN).toISOString() })]);
    assert.equal(r.entries.length, 0);
  });

  it("a WEAK band does not fire a recovery", () => {
    const r = recoverWith([envelope({ band: "unverified" } as Partial<LiveClaimEnvelope>)]);
    assert.equal(r.entries.length, 0);
  });

  it("a stop with no live claim at all produces nothing and reports no weak evidence", () => {
    const r = recoverWith([]);
    assert.equal(r.entries.length, 0);
    assert.equal(r.weakEvidenceStops, 0, "silence is not weak evidence");
    assert.equal(r.considered, 1);
  });

  it("a live claim that says walk-in IS accepted fires nothing", () => {
    const r = recoverWith([envelope({ value: { accepted: true } })]);
    assert.equal(r.entries.length, 0);
  });
});

describe("recovery — closure", () => {
  it("reads the closure state from either shape", () => {
    assert.equal(closureStateOf({ state: "temporarily_closed" }), "temporarily_closed");
    assert.equal(closureStateOf("temporarily_closed"), "temporarily_closed");
    assert.equal(closureStateOf({ nope: 1 }), null);
    assert.equal(closureStateOf(null), null);
  });

  it("a live temporary closure fires and cites the closure claim", () => {
    const r = recoverWith([
      envelope({ claimType: "closure.state", value: { state: "temporarily_closed" }, id: "closure-ref" }),
    ]);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0]!.reasonCode, "closed_now");
    assert.equal(
      r.entries[0]!.evidence.kind === "live" ? r.entries[0]!.evidence.claimRef : null,
      "closure-ref",
    );
    assert.equal(r.entries[0]!.alternativeId, "alt-1");
  });

  it("PERMANENTLY closed never fires — a structural fact one report may not establish", () => {
    assert.ok(!RECOVERABLE_CLOSURE_STATES.includes("permanently_closed"));
    const r = recoverWith([
      envelope({ claimType: "closure.state", value: { state: "permanently_closed" } }),
    ]);
    assert.equal(r.entries.length, 0);
  });

  it("'open' fires nothing", () => {
    const r = recoverWith([envelope({ claimType: "closure.state", value: { state: "open" } })]);
    assert.equal(r.entries.length, 0);
  });
});

describe("recovery — a missed window is a SCHEDULE fact, not an observation (§37)", () => {
  const past = new Date(Date.now() - (MISSED_WINDOW_GRACE_MINUTES + 10) * MIN).toISOString();

  it("fires past the grace period, with schedule evidence and no claim ref", () => {
    const r = recoverWith([], { endsAt: past });
    assert.equal(r.entries.length, 1);
    const e = r.entries[0]!;
    assert.equal(e.reasonCode, "window_missed");
    assert.equal(e.evidence.kind, "schedule");
    assert.equal(e.evidence.kind === "schedule" ? e.evidence.windowEndedAt : null, past);
    // The type has no claimRef on this branch, and the JSON must not grow one.
    assert.ok(!JSON.stringify(e.evidence).includes("claimRef"));
    assert.equal(e.alternativeId, "alt-1", "the same-category rule still applies");
  });

  it("does NOT fire inside the grace period", () => {
    const justEnded = new Date(Date.now() - (MISSED_WINDOW_GRACE_MINUTES - 5) * MIN).toISOString();
    const r = recoverWith([], { endsAt: justEnded });
    assert.equal(r.entries.length, 0);
  });

  it("a stop with no planned end can never miss its window", () => {
    const r = recoverWith([], { endsAt: null });
    assert.equal(r.entries.length, 0);
  });

  it("a live constraint wins: one stop never produces two entries", () => {
    const r = recoverWith([envelope()], { endsAt: past });
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0]!.reasonCode, "walk_in_denied");
  });
});

describe("recovery — the alternative", () => {
  it("falls back to the coarse type when no same-category candidate exists", () => {
    const r = computeRecovery({
      stops: [STOP],
      envelopesBySubject: new Map([["subject-1", [envelope()]]]),
      candidates: [{ id: "alt-2", title: "Museum", category: "activity", score: 95 }],
      nowMs: Date.now(),
    });
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0]!.alternativeId, "alt-2", "coarse 'place' fallback, per the Compass rule");
  });

  it("never offers a candidate that is itself live-constrained", () => {
    const r = computeRecovery({
      stops: [STOP],
      envelopesBySubject: new Map([["subject-1", [envelope()]]]),
      candidates: [
        { id: "alt-1", title: "Bếp Cuốn", category: "dining", score: 90, hasHardConstraint: true },
        { id: "alt-3", title: "Quán Nem", category: "dining", score: 10 },
      ],
      nowMs: Date.now(),
    });
    assert.equal(r.entries[0]!.alternativeId, "alt-3");
  });

  it("with no candidates at all there is no entry to make", () => {
    const r = computeRecovery({
      stops: [STOP],
      envelopesBySubject: new Map([["subject-1", [envelope()]]]),
      candidates: [],
      nowMs: Date.now(),
    });
    assert.equal(r.entries.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The route
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN = "journey-test-token";
const VIEWER = "journey-viewer";
const TRIP = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

interface TableSpec { rows?: any[]; error?: { message: string } }
type FakeState = Record<string, TableSpec | any[]>;

const writes: Array<{ table: string; rows: any }> = [];

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

function buildQuery(table: string, spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });
  const q: any = {
    select() { return q; },
    order() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    is(col: string, val: any) {
      rows = val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val);
      return q;
    },
    upsert(payload: any) { writes.push({ table, rows: payload }); return q; },
    insert(payload: any) { writes.push({ table, rows: payload }); return q; },
    update(payload: any) { writes.push({ table, rows: payload }); return q; },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

let state: FakeState = {};

function makeClient() {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(table, specOf(state, table)),
  };
}

let server: http.Server;
let base: string;

function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function baseState(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_journey_intelligence_enabled", enabled: true }],
    // The owner is crew-1, who is ALSO in trip_members, so the electorate is
    // exactly {VIEWER, crew-1}: two people, the smallest real group.
    trips: [{ id: TRIP, owner_id: "crew-1" }],
    trip_members: [
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: "crew-1", role: "member", status: "accepted" },
    ],
    trip_plan_items: [
      { id: ITEM, trip_id: TRIP, title: "Bánh mì stall", category: "dining", status: "tentative",
        starts_at: null, ends_at: null, location_name: "An Thuong", sort_order: 0,
        created_at: "2026-09-01T00:00:00.000Z", source_type: "manual", source_id: null, removed_at: null },
    ],
    trip_plan_item_votes: [],
    trip_saved_places: [],
    profiles: [{ id: VIEWER, travel_styles: [] }],
    ...over,
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use(mapJourneyRouter);
  await new Promise<void>((resolve) => {
    // Bind loopback explicitly: a host-less listen(0) binds [::] and a foreign
    // IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  _setTestClient(makeClient(), true);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("route — GET /map/journey/shortlist", () => {
  it("refuses a non-member BEFORE consulting the flag", async () => {
    state = baseState({ trip_members: [], trips: [{ id: TRIP, owner_id: "someone-else" }] });
    const res = await call("GET", `/map/journey/shortlist?tripId=${TRIP}`);
    assert.equal(res.body.error, "not_member");
    // Nothing about the capability's state may leak to a stranger.
    assert.ok(!("enabled" in res.body));
  });

  it("answers enabled:false and empty when the flag is off", async () => {
    state = baseState({ feature_flags: [{ flag: "map_journey_intelligence_enabled", enabled: false }] });
    const res = await call("GET", `/map/journey/shortlist?tripId=${TRIP}`);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.items, []);
    assert.deepEqual(res.body.crew, []);
  });

  it("serves the shortlist with a tally and NO coordinate on the wire", async () => {
    state = baseState({
      trip_plan_item_votes: [
        { trip_id: TRIP, plan_item_id: ITEM, user_id: VIEWER, vote: "accept" },
      ],
      user_location_state: [
        { user_id: "crew-1", city: "Da Nang", district: "Riverside",
          lat: LIVE_SHARE_LAT, lng: LIVE_SHARE_LNG, updated_at: null },
      ],
    });
    const res = await call("GET", `/map/journey/shortlist?tripId=${TRIP}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0]!.tally.accepts, 1);
    assert.equal(res.body.items[0]!.tally.myVote, "accept");
    assert.equal(res.body.items[0]!.tally.readyToConfirm, false, "one member has not voted");
    assert.ok(!res.raw.includes(String(LIVE_SHARE_LAT)), "no crew coordinate on the wire");
    assert.ok(!res.raw.includes(String(LIVE_SHARE_LNG)), "no crew coordinate on the wire");
  });

  it("refuses rather than showing an empty tally when the vote read fails", async () => {
    state = baseState({ trip_plan_item_votes: { error: { message: "boom" } } });
    const res = await call("GET", `/map/journey/shortlist?tripId=${TRIP}`);
    assert.equal(res.body.error, "db_error");
  });
});

describe("route — POST /map/journey/shortlist/:planItemId/vote", () => {
  it("records nothing while the flag is off", async () => {
    state = baseState({ feature_flags: [{ flag: "map_journey_intelligence_enabled", enabled: false }] });
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "accept" });
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.recorded, false);
    assert.deepEqual(writes, [], "a disabled capability must not accumulate hidden votes");
  });

  it("refuses a non-member", async () => {
    state = baseState({ trip_members: [] });
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "accept" });
    assert.equal(res.body.error, "not_member");
    assert.deepEqual(writes, []);
  });

  it("refuses a vote on an item that is no longer a candidate", async () => {
    state = baseState({
      trip_plan_items: [
        { id: ITEM, trip_id: TRIP, title: "x", category: "dining", status: "confirmed",
          starts_at: null, ends_at: null, location_name: null, sort_order: 0,
          created_at: null, source_type: "manual", source_id: null, removed_at: null },
      ],
    });
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "accept" });
    assert.equal(res.body.error, "forbidden");
    assert.deepEqual(writes, [], "the sheet must not re-open a decision the plan already made");
  });

  it("refuses a vote for an item belonging to a different trip", async () => {
    state = baseState({
      trip_plan_items: [
        { id: ITEM, trip_id: "33333333-3333-4333-8333-333333333333", title: "x", category: "dining",
          status: "tentative", starts_at: null, ends_at: null, location_name: null, sort_order: 0,
          created_at: null, source_type: "manual", source_id: null, removed_at: null },
      ],
    });
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "accept" });
    assert.equal(res.body.error, "not_found");
    assert.deepEqual(writes, []);
  });

  it("rejects a vote value outside accept/decline", async () => {
    state = baseState();
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "maybe" });
    assert.equal(res.body.error, "invalid_payload");
    assert.deepEqual(writes, []);
  });

  it("records an accept and echoes the fresh tally", async () => {
    state = baseState({
      trip_plan_item_votes: [
        { trip_id: TRIP, plan_item_id: ITEM, user_id: VIEWER, vote: "accept" },
        { trip_id: TRIP, plan_item_id: ITEM, user_id: "crew-1", vote: "accept" },
      ],
    });
    writes.length = 0;
    const res = await call("POST", `/map/journey/shortlist/${ITEM}/vote`, { tripId: TRIP, vote: "accept" });
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.recorded, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.table, "trip_plan_item_votes");
    assert.equal(writes[0]!.rows.user_id, VIEWER, "the vote is filed under the SESSION identity");
    assert.equal(res.body.tally.accepts, 2);
    assert.equal(res.body.tally.readyToConfirm, true);
  });
});

describe("route — GET /map/journey/recovery", () => {
  it("refuses a non-member before the flag", async () => {
    state = baseState({ trip_members: [] });
    const res = await call("GET", `/map/journey/recovery?tripId=${TRIP}`);
    assert.equal(res.body.error, "not_member");
  });

  it("answers enabled:false when the flag is off", async () => {
    state = baseState({ feature_flags: [{ flag: "map_journey_intelligence_enabled", enabled: false }] });
    const res = await call("GET", `/map/journey/recovery?tripId=${TRIP}`);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.entries, []);
  });

  it("surfaces a missed-window recovery from the trip's own saved places", async () => {
    const past = new Date(Date.now() - (MISSED_WINDOW_GRACE_MINUTES + 20) * MIN).toISOString();
    state = baseState({
      trip_plan_items: [
        { id: ITEM, trip_id: TRIP, title: "Madame Lân", category: "dining", status: "confirmed",
          starts_at: null, ends_at: past, location_name: null, sort_order: 0,
          created_at: null, source_type: "manual", source_id: null, removed_at: null },
      ],
      trip_saved_places: [
        { id: "44444444-4444-4444-8444-444444444444", trip_id: TRIP, place_name: "Bếp Cuốn",
          place_type: "dining", saved_at: "2026-09-01T00:00:00.000Z" },
      ],
    });
    const res = await call("GET", `/map/journey/recovery?tripId=${TRIP}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.entries[0]!.reasonCode, "window_missed");
    assert.equal(res.body.entries[0]!.evidence.kind, "schedule");
    assert.equal(res.body.entries[0]!.alternativeTitle, "Bếp Cuốn");
  });

  it("reasons over CONFIRMED stops only — a tentative candidate is the shortlist's job", async () => {
    const past = new Date(Date.now() - (MISSED_WINDOW_GRACE_MINUTES + 20) * MIN).toISOString();
    state = baseState({
      trip_plan_items: [
        { id: ITEM, trip_id: TRIP, title: "Madame Lân", category: "dining", status: "tentative",
          starts_at: null, ends_at: past, location_name: null, sort_order: 0,
          created_at: null, source_type: "manual", source_id: null, removed_at: null },
      ],
    });
    const res = await call("GET", `/map/journey/recovery?tripId=${TRIP}`);
    assert.equal(res.body.entries.length, 0);
    assert.equal(res.body.considered, 0);
  });
});
