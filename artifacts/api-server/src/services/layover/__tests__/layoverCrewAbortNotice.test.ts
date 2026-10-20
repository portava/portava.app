/**
 * census-layover L144 — at the §15.1 one-tap abort, the crew "is notified if
 * policy + user settings allow" (spec §15). LayoverCrewAbortNotice.ts.
 *
 * What was true on main (9af376fa4): `abortToAirport` answered
 * `crewNotified: []` with the hard-coded `crew_notify_not_enabled` on every
 * abort, whatever the traveller wanted and whatever the crew tables held. Every
 * case below that expects a crewmate to hold a notice is red there (the module
 * does not exist; `abortToAirport` ignores `crewNotice`).
 *
 * The decision (OQ-3, owner) is NOT taken here. What is pinned is the
 * fail-closed default the plan names — flag OFF; per-abort explicit opt-in;
 * crew only; the crew card's gates in both directions; minimal text; a count,
 * never a person — and that the essential-safety channel of #701/#709
 * (census §66/§69) cannot see this notice.
 *
 * ── WHAT THE DOUBLE CANNOT SEE ───────────────────────────────────────────────
 * `fakeLayoverDb` models no RLS, no unique index and no CHECK. The crew tables
 * have zero client grants and zero policies (2984, applied), so the route layer
 * is the only gate there is — which is what this suite exercises. Nothing here
 * is evidence about the live `notifications` table beyond the columns the
 * pipeline already writes.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewAbortNotice.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { certifySessionFeasibility } from "../../airport/LayoverFeasibility.js";
import type { LayoverSession } from "../../airport/LayoverSessionService.js";
import type { AirportProfile } from "../../airport/AirportProfileService.js";
import { abortToAirport } from "../../airport/LayoverSafeReturnService.js";
import { returnWarningSourceId } from "../../airport/LayoverReturnEscalation.js";
import { returnWarningSupersededSince } from "../../airport/LayoverOpportunityNotifier.js";
import { NotificationDeduplicationService } from "../../notifications/NotificationDeduplicationService.js";
import { NotificationRouter } from "../../notifications/NotificationRouter.js";
import { TEMPLATES, renderTemplate } from "../../notifications/NotificationTemplateService.js";
import { _setTestFetch } from "../../../lib/push.js";
import { runRouterMatrix, typeOf } from "../../notifications/__tests__/routerDecisionMatrix.js";
import {
  CREW_ABORT_NOTICE_DEADLINE_MS,
  CREW_ABORT_NOTICE_EVENT_TYPE,
  CREW_ABORT_NOTICE_FALLBACK_NAME,
  CREW_ABORT_NOTICE_SOURCE_TYPE,
  crewAbortNoticeCapability,
  crewAbortNoticeRequest,
  crewAbortNoticeSourceId,
  tellCrewOfAbort,
  tellCrewRequested,
  type CrewAbortNoticeRequest,
} from "../LayoverCrewAbortNotice.js";

const NOW = Date.now();
const HOUR = 3_600_000;
const A = "user-a";
const B = "user-b";
const C = "user-c";
const D = "user-d";
const SA = "session-a";
const SB = "session-b";
const SC = "session-c";
const CREW = "crew-1";

const ON: CrewAbortNoticeRequest = { requested: true, enabled: true };

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport",
  city: "Taoyuan", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: false, terminalInfo: null,
};

function sessionA(tripId: string | null = null): LayoverSession {
  const row = sessionRow({ id: SA, user_id: A, arrival_time: new Date(NOW).toISOString(), departure_time: new Date(NOW + 8 * HOUR).toISOString() });
  return {
    id: row.id, userId: row.user_id, airportId: row.airport_id, tripId,
    arrivalTime: row.arrival_time, departureTime: row.departure_time, boardingTime: null,
    layoverMinutes: 480, flightType: "international", immigrationRequired: false,
    checkedBags: false, loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
    vibeChips: [], manualAirportName: null, manualCity: null, manualCountry: null,
    manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active", createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function member(userId: string, sessionId: string, role = "member", over: Record<string, unknown> = {}) {
  return { crew_id: CREW, user_id: userId, session_id: sessionId, role, joined_at: new Date(NOW - HOUR).toISOString(), left_at: null, ...over };
}

interface StageOpts {
  members?: Record<string, unknown>[];
  crew?: Record<string, unknown>;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  locationPrefs?: Array<Record<string, unknown>>;
  showRealName?: string[];
  failures?: Record<string, { message: string; code?: string }>;
  flagOn?: boolean;
  /** `trip_crew_location_preferences` rows — the per-trip Ghost Mode `evaluateSharingGate` reads (fix round 1, F1). */
  ghost?: Array<{ trip_id: string; user_id: string; ghost_mode_enabled: boolean }>;
}

function stage(o: StageOpts = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "layover_crew_abort_notify_enabled", enabled: o.flagOn ?? true }],
    layover_sessions: [sessionRow({ id: SA, user_id: A, status: "active" })],
    layover_plan_stops: [],
    layover_events: [],
    layover_crews: [{
      id: CREW, city: "taoyuan", airport_ref: "TPE", created_by: A, created_session_id: SA, title: "Ramen",
      meeting_point_label: "T2 food court", status: "open", max_members: 6,
      expires_at: new Date(NOW + 6 * HOUR).toISOString(), created_at: new Date(NOW - 2 * HOUR).toISOString(),
      ...(o.crew ?? {}),
    }],
    layover_crew_members: o.members ?? [member(A, SA, "owner"), member(B, SB), member(C, SC)],
    blocks: o.blocks ?? [],
    location_preferences: o.locationPrefs ?? [A, B, C, D].map((u) => ({ user_id: u, location_mode: "city_only", sharing_paused: false })),
    profiles: [
      { id: A, handle: "ann", name: "Ann Example", avatar_url: null },
      { id: B, handle: "bo", name: "Bo", avatar_url: null },
      { id: C, handle: "cy", name: "Cy", avatar_url: null },
    ],
    profile_privacy_settings: (o.showRealName ?? []).map((u) => ({ user_id: u, show_real_name: true })),
    trip_crew_location_preferences: o.ghost ?? [],
    notifications: [],
    notification_delivery_attempts: [],
    notification_preferences: [],
    notification_category_preferences: [],
  };
  return { tables, db: makeLayoverDb(tables, { failures: o.failures ?? {} }) };
}

async function abort(db: any, crewNotice?: CrewAbortNoticeRequest, opts: { tripId?: string | null; deadlineMs?: number } = {}) {
  const s = sessionA(opts.tripId ?? null);
  return abortToAirport(db, {
    session: s, airport: AIRPORT, record: certifySessionFeasibility(AIRPORT, s, { nowMs: NOW }),
    userId: A, nowMs: NOW, statusEnabled: false, ...(crewNotice ? { crewNotice } : {}),
    ...(opts.deadlineMs !== undefined ? { crewNoticeDeadlineMs: opts.deadlineMs } : {}),
  });
}

interface NoticeOp { op: "select" | "insert"; cols: string; at: number }

/**
 * Every `notifications` operation takes `ms`, and each is logged with the moment it was issued (fix round 2):
 * `select("id")` is a notice's duplicate check — the first step of a create, i.e. the notice STARTING —
 * `select("user_id")` the prior-notice read, and `insert` the write itself.
 */
function stallNotifications(db: any, ms: number, log: NoticeOp[]) {
  return {
    ...db,
    from(t: string) {
      const b = db.from(t);
      if (t !== "notifications") return b;
      let op: NoticeOp["op"] = "select";
      let cols = "";
      const select = b.select.bind(b);
      b.select = (c?: string, o?: unknown) => { if (op === "select") cols = c ?? ""; return select(c, o); };
      const insert = b.insert.bind(b);
      b.insert = (row: unknown) => { op = "insert"; cols = "*"; return insert(row); };
      const delay = () => new Promise<void>((r) => setTimeout(r, ms));
      const then = b.then.bind(b);
      const single = b.single.bind(b);
      const maybeSingle = b.maybeSingle.bind(b);
      b.then = (ok: any, ko: any) => { log.push({ op, cols, at: Date.now() }); return delay().then(() => then(ok, ko)); };
      b.single = () => { log.push({ op, cols, at: Date.now() }); return delay().then(() => single()); };
      b.maybeSingle = () => { log.push({ op, cols, at: Date.now() }); return delay().then(() => maybeSingle()); };
      return b;
    },
  };
}

/** One table's reads answer late (`ms`) or never (`null`), the way a stuck connection would (fix round 1, F3). */
function stallTable(db: any, table: string, ms: number | null) {
  return {
    ...db,
    from(t: string) {
      const b = db.from(t);
      if (t !== table) return b;
      const settle = b.then.bind(b);
      b.then = (ok: any, ko: any) =>
        (ms === null ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, ms))).then(() => settle(ok, ko));
      return b;
    },
  };
}

const notices = (tables: Record<string, any[]>) =>
  tables.notifications.filter((n) => n.event_type === CREW_ABORT_NOTICE_EVENT_TYPE);

/** The router runs fire-and-forget after the row exists; give it the turns it needs. */
async function settle(tables: Record<string, any[]>, attemptsExpected: number) {
  for (let i = 0; i < 100 && tables.notification_delivery_attempts.length < attemptsExpected; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The double fails table+op globally; this fails ONE recipient's notice insert, the way a per-row error would. */
function failNoticeInsertFor(db: any, userId: string) {
  return {
    ...db,
    from(table: string) {
      const b = db.from(table);
      if (table !== "notifications") return b;
      const insert = b.insert.bind(b);
      b.insert = (row: any) => {
        if (row?.user_id !== userId) return insert(row);
        const failed = { data: null, error: { message: "insert failed for this row" } };
        const f: any = { select: () => f, single: async () => failed, maybeSingle: async () => failed, then: (ok: any, ko: any) => Promise.resolve(failed).then(ok, ko) };
        return f;
      };
      return b;
    },
  };
}

afterEach(() => { _setTestFetch(null); });

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 fail-closed defaults: the flag, and the traveller's own per-abort choice", () => {
  it("FLAG OFF + asked: nobody is told, and the crew is not even read", async () => {
    // A crew read that would FAIL proves no crew read happened: an implementation
    // that read first would answer crew_unreadable.
    const { tables, db } = stage({ failures: { "layover_crew_members:select": { message: "must not be read" } } });
    const r = await abort(db, { requested: true, enabled: false });
    assert.equal(r.ok, true);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "crew_notify_not_enabled");
    assert.ok(r.effects.includes("crew_notify_unavailable"));
    assert.equal(r.effects.includes("crew_notified"), false);
    assert.equal(notices(tables).length, 0);
  });

  it("no crewNotice passed at all (every pre-L144 caller): exactly main's answer", async () => {
    const { tables, db } = stage();
    const r = await abort(db);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "crew_notify_not_enabled");
    assert.equal(notices(tables).length, 0);
  });

  it("FLAG ON + NOT asked: nobody is told, and the reason says the traveller did not ask", async () => {
    const { tables, db } = stage(); /* LAYOVER 165 B2-CREW (census L144, owner rule 2026-10-18): an unticked abort may still be authorized — a live crew location share, or an emergency contact of an active Safe Return session — so the crew IS read now; with neither basis nobody is told, and the reason is still not_requested */
    const r = await abort(db, { requested: false, enabled: true });
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "not_requested");
    assert.equal(notices(tables).length, 0);
  });

  it("consent is the literal boolean true on tellCrew, nothing else", () => {
    assert.equal(tellCrewRequested({ tellCrew: true }), true);
    for (const body of [undefined, null, {}, { tellCrew: "true" }, { tellCrew: 1 }, { tellCrew: false }, { notifyCrew: true }, "tellCrew", [true]]) {
      assert.equal(tellCrewRequested(body), false, JSON.stringify(body));
    }
  });

  it("crewAbortNoticeRequest reads the flag fail-closed: absent row or unreadable table = not enabled", async () => {
    const absent = makeLayoverDb({ feature_flags: [] });
    assert.deepEqual(await crewAbortNoticeRequest(absent, { tellCrew: true }), { requested: true, enabled: false });
    const broken = makeLayoverDb({ feature_flags: [{ flag: "layover_crew_abort_notify_enabled", enabled: true }] }, { failures: { "feature_flags:select": { message: "down" } } });
    assert.deepEqual(await crewAbortNoticeRequest(broken, { tellCrew: true }), { requested: true, enabled: false });
    const on = makeLayoverDb({ feature_flags: [{ flag: "layover_crew_abort_notify_enabled", enabled: true }] });
    assert.deepEqual(await crewAbortNoticeRequest(on, { tellCrew: true }), { requested: true, enabled: true });
    assert.deepEqual(await crewAbortNoticeRequest(on, {}), { requested: false, enabled: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 flag ON + asked: the crew is told, as a count, in minimal words", () => {
  it("each other live crewmate gets ONE in-app notice; the abort reports a COUNT and no ids", async () => {
    const { tables, db } = stage();
    const r = await abort(db, ON);
    assert.equal(r.ok, true, `effects: ${r.effects.join(",")}`);
    assert.equal(r.crewNotifiedCount, 2);
    assert.equal(r.crewNotifyUnavailableReason, null);
    assert.ok(r.effects.includes("crew_notified"));
    assert.equal(r.effects.includes("crew_notify_unavailable"), false);
    const rows = notices(tables);
    assert.deepEqual(rows.map((n) => n.user_id).sort(), [B, C]);
    // The traveller never notifies themselves.
    assert.equal(rows.some((n) => n.user_id === A), false);
    // A count, never a person: no crewmate id anywhere in what the traveller receives.
    const wire = JSON.stringify(r);
    for (const id of [B, C, SB, SC]) assert.equal(wire.includes(id), false, `${id} leaked into the abort result`);
    assert.equal("crewNotified" in r, false);
  });

  it("the text is the whole disclosure: the fallback name, no reason, time or place, no actor, no push channel", async () => {
    const { tables, db } = stage();
    await abort(db, ON);
    for (const n of notices(tables)) {
      assert.equal(n.title, "Your layover crew");
      assert.equal(n.body, `${CREW_ABORT_NOTICE_FALLBACK_NAME} is heading back to the airport.`);
      assert.equal(n.category, "airport");
      assert.equal(n.priority, "normal");
      assert.equal(n.actor_id, null, "an actor id would let a client render the person the name rule hides");
      assert.deepEqual(n.metadata, {});
      assert.equal(/\d/.test(`${n.title} ${n.body}`), false, "no time");
      for (const place of ["TPE", "Taoyuan", "Taiwan", "T2", "food court", "Ramen"]) {
        assert.equal(`${n.title} ${n.body}`.includes(place), false, `place/plan "${place}" in the notice`);
      }
      // Nothing on the row names the traveller or their session.
      const row = JSON.stringify(n);
      for (const id of [A, SA, "ann", "Ann"]) assert.equal(row.includes(id), false, `${id} on the crewmate's row`);
    }
    const t = renderTemplate(CREW_ABORT_NOTICE_EVENT_TYPE, { actor: "X" })!;
    assert.deepEqual(t.channels, ["in_app"], "in-app only: no lock-screen preview");
  });

  it("the real name appears ONLY when the traveller shows it (name visibility)", async () => {
    const { tables, db } = stage({ showRealName: [A] });
    await abort(db, ON);
    for (const n of notices(tables)) assert.equal(n.body, "Ann Example is heading back to the airport.");
  });

  it("an unreadable name falls back to 'A crew member' and still tells the crew", async () => {
    const { tables, db } = stage({ showRealName: [A], failures: { "profiles:select": { message: "down" } } });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 2);
    for (const n of notices(tables)) assert.equal(n.body, `${CREW_ABORT_NOTICE_FALLBACK_NAME} is heading back to the airport.`);
  });

  it("each crewmate's notice opens their OWN layover", async () => {
    const { tables, db } = stage();
    await abort(db, ON);
    const by = new Map(notices(tables).map((n) => [n.user_id, n.action_url]));
    assert.equal(by.get(B), `/layover/${SB}`);
    assert.equal(by.get(C), `/layover/${SC}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 crew only, and the crew card's gates in both directions", () => {
  it("a crewmate who BLOCKED the traveller is not told; one the traveller blocked is not told either", async () => {
    const { tables, db } = stage({ blocks: [{ blocker_id: B, blocked_id: A }, { blocker_id: A, blocked_id: C }] });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "no_crewmate_to_tell");
    assert.equal(notices(tables).length, 0);
  });

  it("a block on one side only removes that crewmate (control: the other is told)", async () => {
    const { tables, db } = stage({ blocks: [{ blocker_id: B, blocked_id: A }] });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 1);
    assert.deepEqual(notices(tables).map((n) => n.user_id), [C]);
  });

  it("a block between two OTHER people changes nothing", async () => {
    const { db } = stage({ blocks: [{ blocker_id: B, blocked_id: D }] });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 2);
  });

  it("an UNREADABLE block list tells nobody", async () => {
    const { tables, db } = stage({ failures: { "blocks:select": { message: "down" } } });
    const r = await abort(db, ON);
    assert.equal(r.ok, true, "the abort itself is unaffected");
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "blocks_unreadable");
    assert.equal(notices(tables).length, 0);
  });

  it("a crewmate whose sharing is paused is not told (they are not on the traveller's crew card)", async () => {
    const { tables, db } = stage({
      locationPrefs: [
        { user_id: A, location_mode: "city_only", sharing_paused: false },
        { user_id: B, location_mode: "city_only", sharing_paused: true },
        { user_id: C, location_mode: "off", sharing_paused: false },
      ],
    });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "no_crewmate_to_tell");
    assert.equal(notices(tables).length, 0);
  });

  it("a traveller whose OWN sharing is paused is not announced, even on request", async () => {
    const { tables, db } = stage({
      locationPrefs: [
        { user_id: A, location_mode: "city_only", sharing_paused: true },
        { user_id: B, location_mode: "city_only", sharing_paused: false },
        { user_id: C, location_mode: "city_only", sharing_paused: false },
      ],
    });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "sharing_not_allowed");
    assert.equal(notices(tables).length, 0);
  });

  it("an UNREADABLE sharing table tells nobody", async () => {
    const { tables, db } = stage({ failures: { "location_preferences:select": { message: "down" } } });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "sharing_preferences_unreadable");
    assert.equal(notices(tables).length, 0);
  });

  it("a crewmate who LEFT is not told; a crew of one tells nobody", async () => {
    const left = stage({ members: [member(A, SA, "owner"), member(B, SB, "member", { left_at: new Date(NOW - 60_000).toISOString() }), member(C, SC)] });
    const r1 = await abort(left.db, ON);
    assert.equal(r1.crewNotifiedCount, 1);
    assert.deepEqual(notices(left.tables).map((n) => n.user_id), [C]);

    const alone = stage({ members: [member(A, SA, "owner")] });
    const r2 = await abort(alone.db, ON);
    assert.equal(r2.crewNotifyUnavailableReason, "no_crewmate_to_tell");
    assert.equal(notices(alone.tables).length, 0);
  });

  it("people in ANOTHER crew are never told", async () => {
    const { tables, db } = stage({
      members: [member(A, SA, "owner"), member(B, SB), { ...member(D, "session-d"), crew_id: "crew-2" }],
    });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 1);
    assert.deepEqual(notices(tables).map((n) => n.user_id), [B]);
  });

  it("not in a crew; a crew joined with ANOTHER session; a disbanded or expired crew: nobody, not_in_a_crew", async () => {
    const cases: StageOpts[] = [
      { members: [member(B, SB), member(C, SC)] },
      { members: [member(A, "session-other", "owner"), member(B, SB)] },
      { crew: { status: "disbanded" } },
      { crew: { expires_at: new Date(NOW - 60_000).toISOString() } },
    ];
    for (const c of cases) {
      const { tables, db } = stage(c);
      const r = await abort(db, ON);
      assert.equal(r.crewNotifyUnavailableReason, "not_in_a_crew", JSON.stringify(c));
      assert.equal(notices(tables).length, 0);
    }
  });

  it("an UNREADABLE crew is crew_unreadable, never 'not in a crew', and tells nobody", async () => {
    for (const t of ["layover_crew_members:select", "layover_crews:select"]) {
      const { tables, db } = stage({ failures: { [t]: { message: "down" } } });
      const r = await abort(db, ON);
      assert.equal(r.ok, true);
      assert.equal(r.crewNotifyUnavailableReason, "crew_unreadable", t);
      assert.equal(notices(tables).length, 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 never fails the abort, and never claims what it cannot know", () => {
  it("every notice write fails: the abort is still ok, and nobody is reported told", async () => {
    const { tables, db } = stage({ failures: { "notifications:insert": { message: "insert failed" } } });
    const r = await abort(db, ON);
    assert.equal(r.ok, true, "telling the crew never fails the abort");
    assert.ok(r.effects.includes("ledger_recorded"));
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "notify_failed");
    assert.ok(r.effects.includes("crew_notify_unavailable"));
    assert.equal(tables.layover_events.length, 1, "the ledger row is written regardless");
  });

  it("a FAILED abort (ledger write failed) still tells the crew the traveller asked to tell — they are still heading back", async () => {
    const { tables, db } = stage({ failures: { "layover_events:insert": { message: "check violation" } } });
    const r = await abort(db, ON);
    assert.equal(r.ok, false);
    assert.equal(r.crewNotifiedCount, 2);
    assert.equal(notices(tables).length, 2);
  });

  it("a double-tapped abort writes nothing new and still reports the crewmates who hold the notice", async () => {
    const { tables, db } = stage();
    const first = await abort(db, ON);
    const second = await abort(db, ON);
    assert.equal(first.crewNotifiedCount, 2);
    assert.equal(notices(tables).length, 2, "the duplicate window suppressed the second write");
    assert.equal(second.crewNotifiedCount, 2, "both crewmates DO hold the notice — read, not assumed");
    assert.equal(second.crewNotifyUnavailableReason, null);
  });

  it("an UNREADABLE notifications ledger (dedup answers 'duplicate', fail-closed) is NOT counted as told", async () => {
    const { tables, db } = stage({ failures: { "notifications:select": { message: "down" } } });
    const r = await abort(db, ON);
    assert.equal(notices(tables).length, 0);
    assert.equal(r.crewNotifiedCount, 0, "a refusal the server cannot explain is not 'already told'");
    assert.equal(r.crewNotifyUnavailableReason, "notify_failed");
  });

  it("one crewmate's notice already on record (inside the window): counted as told because it was READ, the other is written now", async () => {
    const { tables, db } = stage();
    tables.notifications.push({
      id: "n-old", user_id: B, category: "airport", event_type: CREW_ABORT_NOTICE_EVENT_TYPE,
      source_type: CREW_ABORT_NOTICE_SOURCE_TYPE, source_id: crewAbortNoticeSourceId(CREW, SA), created_at: new Date().toISOString(),
      title: "Your layover crew", body: "x", priority: "normal", metadata: {},
    });
    const r = await abort(db, ON);
    assert.equal(r.crewNotifiedCount, 2);
    assert.equal(r.crewNotifyUnavailableReason, null);
    assert.deepEqual(notices(tables).map((n) => n.user_id).sort(), [B, C], "B's old row and C's new one — no second row for B");
  });

  it("some writes fail: the count is the ones that landed, and the reason says partial", async () => {
    const { tables, db } = stage();
    const r = await abort(failNoticeInsertFor(db, C), ON);
    assert.equal(r.ok, true);
    assert.equal(r.crewNotifiedCount, 1);
    assert.equal(r.crewNotifyUnavailableReason, "notify_partially_failed");
    assert.deepEqual(notices(tables).map((n) => n.user_id), [B]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 does not touch the essential-safety return channel (#701/#709, census §66/§69)", () => {
  it("its own event type, source type and an app-route action url — never layover_return / /airport/sessions/", async () => {
    const { tables, db } = stage();
    await abort(db, ON);
    for (const n of notices(tables)) {
      assert.equal(n.source_type, CREW_ABORT_NOTICE_SOURCE_TYPE);
      assert.notEqual(n.source_type, "layover_return");
      assert.notEqual(n.source_type, "layover_replan");
      assert.equal(String(n.event_type).startsWith("layover.return."), false);
      assert.equal(String(n.action_url).startsWith("/airport/sessions/"), false);
    }
  });

  it("a crewmate's return-warning superseding read and essential dedup do not see the crew notice", async () => {
    const { db } = stage();
    await abort(db, ON);
    const warningSource = returnWarningSourceId(SB, "leave_now");
    assert.equal(await returnWarningSupersededSince(db, B, SB, warningSource), null);
    const dup = await new NotificationDeduplicationService(db).check({
      userId: B, category: "airport", eventType: "layover.return.leave_now",
      sourceType: "layover_return", sourceId: warningSource, essential: true,
    });
    assert.equal(dup.isDuplicate, false, "B's own leave-now warning must still go out");
  });

  it("routing: in-app only — no Expo message for ANY priority, setting or switch position", async () => {
    const tpl = TEMPLATES.find((t) => t.eventType === CREW_ABORT_NOTICE_EVENT_TYPE)!;
    assert.ok(tpl, "the template exists");
    const decisions = (await runRouterMatrix(NotificationRouter as any, _setTestFetch, [tpl]))
      .filter((d) => typeOf(d.key) === `airport|${CREW_ABORT_NOTICE_EVENT_TYPE}`);
    assert.equal(decisions.length, 2 * 4 * 2, "default + urgent, four settings, switch off and on");
    for (const d of decisions) {
      assert.deepEqual(d.sent, [], d.key);
      const push = (d.attempts as Array<{ channel: string; status: string }>).find((a) => a.channel === "push");
      assert.equal(push?.status, "suppressed", d.key);
    }
  });

  it("a real abort's notices route without any push request", async () => {
    let pushes = 0;
    _setTestFetch((async () => { pushes++; return new Response("{}", { status: 200 }); }) as typeof fetch);
    const { tables, db } = stage();
    await abort(db, ON);
    await settle(tables, 2 * 4);
    const ids = new Set(notices(tables).map((n) => n.id));
    const mine = tables.notification_delivery_attempts.filter((a) => ids.has(a.notification_id));
    assert.ok(mine.some((a) => a.channel === "in_app" && a.status === "sent"), "the in-app delivery is logged");
    assert.equal(mine.some((a) => a.channel === "push" && a.status !== "suppressed"), false);
    assert.equal(pushes, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("L144 capability: whether 'tell my crew' may be offered at all", () => {
  it("flag OFF: not offered, and no crew read", async () => {
    const { db } = stage({ flagOn: false, failures: { "layover_crew_members:select": { message: "must not be read" } } });
    assert.deepEqual(await crewAbortNoticeCapability(db, A, SA, NOW), { available: false, reason: "crew_notify_not_enabled" });
  });

  it("flag ON and a live crew with someone else in it: offered", async () => {
    const { db } = stage();
    assert.deepEqual(await crewAbortNoticeCapability(db, A, SA, NOW), { available: true, reason: null });
  });

  it("no crew / another session's crew / a crew of one / an unreadable crew: not offered, each named", async () => {
    assert.deepEqual(await crewAbortNoticeCapability(stage({ members: [member(B, SB)] }).db, A, SA, NOW), { available: false, reason: "not_in_a_crew" });
    assert.deepEqual(await crewAbortNoticeCapability(stage().db, A, "session-other", NOW), { available: false, reason: "not_in_a_crew" });
    assert.deepEqual(await crewAbortNoticeCapability(stage({ members: [member(A, SA, "owner")] }).db, A, SA, NOW), { available: false, reason: "no_crewmate_to_tell" });
    assert.deepEqual(
      await crewAbortNoticeCapability(stage({ failures: { "layover_crew_members:select": { message: "down" } } }).db, A, SA, NOW),
      { available: false, reason: "crew_unreadable" },
    );
  });

  it("tellCrewOfAbort with the capability's crew of one still writes nothing (no notice to self)", async () => {
    const { tables, db } = stage({ members: [member(A, SA, "owner")] });
    const r = await tellCrewOfAbort(db, { userId: A, sessionId: SA, nowMs: NOW, request: ON });
    assert.deepEqual(r, { notifiedCount: 0, reason: "no_crewmate_to_tell" });
    assert.equal(notices(tables).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1 (verdict V-723 on c127f47cf)
// ─────────────────────────────────────────────────────────────────────────────

const TRIP = "trip-1";

describe("F1 — the traveller's OWN gate is the layover sharing gate, trip Ghost Mode included", () => {
  it("a traveller in this trip's Ghost Mode who ticks the box is NOT announced", async () => {
    const { tables, db } = stage({ ghost: [{ trip_id: TRIP, user_id: A, ghost_mode_enabled: true }] });
    const r = await abort(db, ON, { tripId: TRIP });
    assert.equal(r.ok, true);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "sharing_not_allowed");
    assert.equal(notices(tables).length, 0);
  });

  it("an UNREADABLE Ghost Mode tells nobody (fail closed)", async () => {
    const { tables, db } = stage({ failures: { "trip_crew_location_preferences:select": { message: "down" } } });
    const r = await abort(db, ON, { tripId: TRIP });
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "sharing_preferences_unreadable");
    assert.equal(notices(tables).length, 0);
  });

  it("control: the same trip with Ghost Mode OFF tells the crew", async () => {
    const { tables, db } = stage({ ghost: [{ trip_id: TRIP, user_id: A, ghost_mode_enabled: false }] });
    const r = await abort(db, ON, { tripId: TRIP });
    assert.equal(r.crewNotifiedCount, 2);
    assert.equal(notices(tables).length, 2);
  });

  it("control: Ghost Mode on ANOTHER trip, or a crewmate's Ghost Mode, does not gate the traveller", async () => {
    const { db } = stage({ ghost: [{ trip_id: "trip-other", user_id: A, ghost_mode_enabled: true }, { trip_id: TRIP, user_id: B, ghost_mode_enabled: true }] });
    const r = await abort(db, ON, { tripId: TRIP });
    assert.equal(r.crewNotifiedCount, 2);
  });
});

describe("F2 — 'tell my crew' is not OFFERED to a traveller whose own gate refuses", () => {
  it("sharing paused, Ghost Mode on, or either unreadable: not offered, each named", async () => {
    const paused = stage({ locationPrefs: [{ user_id: A, location_mode: "city_only", sharing_paused: true }] });
    assert.deepEqual(await crewAbortNoticeCapability(paused.db, A, SA, NOW, null), { available: false, reason: "sharing_not_allowed" });
    const ghosted = stage({ ghost: [{ trip_id: TRIP, user_id: A, ghost_mode_enabled: true }] });
    assert.deepEqual(await crewAbortNoticeCapability(ghosted.db, A, SA, NOW, TRIP), { available: false, reason: "sharing_not_allowed" });
    const unreadable = stage({ failures: { "trip_crew_location_preferences:select": { message: "down" } } });
    assert.deepEqual(await crewAbortNoticeCapability(unreadable.db, A, SA, NOW, TRIP), { available: false, reason: "sharing_preferences_unreadable" });
  });

  it("control: the same traveller with Ghost Mode OFF on this trip is offered", async () => {
    const { db } = stage({ ghost: [{ trip_id: TRIP, user_id: A, ghost_mode_enabled: false }] });
    assert.deepEqual(await crewAbortNoticeCapability(db, A, SA, NOW, TRIP), { available: true, reason: null });
  });
});

describe("F1 follow-up — the crewmates' sharing read is its own gate", () => {
  it("the CREWMATES' sharing read failing (the traveller's own is readable) tells nobody", async () => {
    const { tables, db } = stage();
    const failing = {
      ...db,
      from(t: string) {
        const b = db.from(t);
        if (t !== "location_preferences") return b;
        // Only the batch read over the crew (`.in("user_id", …)`) fails; the
        // traveller's own single-row read (`.eq(…).maybeSingle()`) still answers.
        b.in = () => ({ then: (ok: any, ko: any) => Promise.resolve({ data: null, error: { message: "down" } }).then(ok, ko) });
        return b;
      },
    };
    const r = await abort(failing, ON);
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "sharing_preferences_unreadable");
    assert.equal(notices(tables).length, 0);
  });
});

describe("F3 — the notice is bounded inside the abort", () => {
  it("a crew read that never answers cannot hold the abort: notify_timed_out, ok, ledger written", { timeout: 5_000 }, async () => {
    const { tables, db } = stage();
    const started = Date.now();
    const r = await abort(stallTable(db, "layover_crew_members", null), ON, { deadlineMs: 50 });
    assert.ok(Date.now() - started < 2_000, "the abort answered inside the bound, not after a stuck read");
    assert.equal(r.ok, true);
    assert.ok(r.effects.includes("ledger_recorded"));
    assert.equal(r.crewNotifiedCount, 0);
    assert.equal(r.crewNotifyUnavailableReason, "notify_timed_out");
    assert.ok(r.effects.includes("crew_notify_unavailable"));
    assert.equal(tables.layover_events.length, 1);
  });

  it("a notice that misses the bound writes NOTHING afterwards (no crewmate told after the traveller was answered)", async () => {
    const { tables, db } = stage();
    const r = await abort(stallTable(db, "layover_crew_members", 120), ON, { deadlineMs: 20 });
    assert.equal(r.crewNotifyUnavailableReason, "notify_timed_out");
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(notices(tables).length, 0, "the late notifier stopped before writing");
  });

  it("IN FLIGHT (fix round 2): no notice STARTS after the deadline, but one already started may land after the answer — hence 'could not confirm', never 'not told'", { timeout: 10_000 }, async () => {
    const { tables, db } = stage();
    const log: NoticeOp[] = [];
    // Every `notifications` op takes 200 ms. The notifier's prior-notice read ends at ~200 ms, inside the
    // 300 ms bound, so the cancellation check passes and both creates START; their duplicate checks end at
    // ~400 ms, after the bound, and the inserts land after the traveller has been answered.
    const r = await abort(stallNotifications(db, 200, log), ON, { deadlineMs: 300 });
    const answeredAt = Date.now();
    assert.equal(r.ok, true);
    assert.equal(r.crewNotifiedCount, 0, "nobody is REPORTED told");
    assert.equal(r.crewNotifyUnavailableReason, "notify_timed_out");
    assert.equal(notices(tables).length, 0, "nothing had landed when the traveller was answered");
    const starts = log.filter((o) => o.op === "select" && o.cols === "id");
    assert.equal(starts.length, 2, "both notices had STARTED (duplicate check) before the bound");
    for (const s of starts) assert.ok(s.at < answeredAt, "no notice started after the answer");
    await new Promise((res) => setTimeout(res, 900));
    const inserts = log.filter((o) => o.op === "insert");
    assert.ok(inserts.some((o) => o.at >= answeredAt), "the case is real: an insert ran after the answer");
    assert.ok(inserts.length <= starts.length, "at most the notices already started are written");
    assert.equal(notices(tables).length, starts.length, "the in-flight notices DID land — the app must not say 'not told'");
    assert.equal(log.filter((o) => o.op === "select" && o.cols === "id" && o.at >= answeredAt).length, 0, "no new notice started after the answer");
  });

  it("CANCELLED before any notice starts: the deadline passes during the prior-notice read, and nothing is ever written", { timeout: 10_000 }, async () => {
    const { tables, db } = stage();
    const log: NoticeOp[] = [];
    const r = await abort(stallNotifications(db, 200, log), ON, { deadlineMs: 80 });
    assert.equal(r.crewNotifyUnavailableReason, "notify_timed_out");
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(log.filter((o) => o.op === "select" && o.cols === "id").length, 0, "no notice started");
    assert.equal(log.filter((o) => o.op === "insert").length, 0);
    assert.equal(notices(tables).length, 0);
  });

  it("control: inside the bound the crew is told as before", async () => {
    const { tables, db } = stage();
    const r = await abort(stallTable(db, "layover_crew_members", 10), ON, { deadlineMs: 2_000 });
    assert.equal(r.crewNotifiedCount, 2);
    assert.equal(notices(tables).length, 2);
  });

  it("the default bound is short and finite", () => {
    assert.ok(CREW_ABORT_NOTICE_DEADLINE_MS > 0 && CREW_ABORT_NOTICE_DEADLINE_MS <= 3_000, String(CREW_ABORT_NOTICE_DEADLINE_MS));
  });
});
