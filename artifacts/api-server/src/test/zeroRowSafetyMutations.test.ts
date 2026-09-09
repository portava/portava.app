/**
 * ZERO ROWS vs A FAILED STATEMENT vs A REAL "NO" — the safety services.
 *
 * ── WHY THIS FILE HAS ITS OWN FAKE ──────────────────────────────────────────
 * `helpers/failClosedSupabase.ts` models a failed READ exactly right and is used
 * for that in safetySurfaceFailClosed.test.ts. It cannot express the OTHER half
 * of this defect class: its `update()` echoes the payload back, so every update
 * looks like it matched exactly one row. A fake that cannot produce a zero-row
 * UPDATE cannot test the bug where a revocation that matched nothing is
 * reported as done — which is precisely the bug in `endSession`.
 *
 * So `makeRowFake` below applies the builder's filters to its stored rows and
 * returns THE ROWS THAT MATCHED, the way PostgREST does with `RETURNING`:
 *
 *   • an UPDATE whose filters match nothing resolves `{ data: [], error: null }`
 *     — indistinguishable from a successful one WITHOUT `.select()`, which is
 *     the whole reason `.select()` was added to these statements;
 *   • an UPDATE that matches mutates the stored row, so a follow-up read sees
 *     the new state and "already ended" is reachable a second time;
 *   • a failed statement resolves `{ data: null, error }` and NEVER throws — a
 *     fake that threw would exercise a `try/catch` production never enters.
 *
 * Nothing here goes over HTTP: these are the service functions the routes and
 * the escalation scheduler both call, and a defect in them is a defect in both.
 *
 * Run: node --import tsx/esm --test src/test/zeroRowSafetyMutations.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  endSession,
  getActiveSessions,
} from "../services/location/LocationSessionService.js";
import {
  loadPreferences,
  isSharingActive,
  effectivePulseVisibility,
} from "../services/location/LocationPermissionService.js";
import { checkNearPrivateStay, isNearPrivateStay } from "../services/location/GeoZoneService.js";
import { getUserTrustLevel } from "../services/location/LocationSafetyService.js";
import {
  createSession,
  markContactNotified,
  findExpiredActiveSessions,
  cancelSession,
} from "../services/safeReturn/SafeReturnService.js";

const USER    = "aaaaaaaa-1111-4000-a000-000000000001";
const SESSION = "dddddddd-4444-4000-a000-000000000004";
const CONTACT = "aaaaaaaa-7777-4000-a000-000000000007";

const DB_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

// ── A fake whose UPDATEs really match (or really do not) ─────────────────────

interface RowFakeSpec {
  rows?: Record<string, Record<string, any>[]>;
  /** Make reads on a table resolve as a failure. */
  failReads?: (table: string) => any;
  /** Make writes on a table resolve as a failure. */
  failWrites?: (table: string) => any;
}

function makeRowFake(spec: RowFakeSpec): any {
  const store = spec.rows ?? {};
  return {
    from(table: string) {
      const filters: Array<[string, string, any]> = [];
      let kind: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let returning = false;

      const match = (r: Record<string, any>) =>
        filters.every(([col, op, val]) => {
          const v = r[col];
          switch (op) {
            case "eq":  return String(v) === String(val);
            case "neq": return String(v) !== String(val);
            case "in":  return Array.isArray(val) && val.map(String).includes(String(v));
            case "is":  return val === null ? v == null : v === val;
            case "not.is": return val === null ? v != null : v !== val;
            case "gt":  return v > val;
            case "lt":  return v < val;
            default:    return true;
          }
        });

      function settle(): any {
        if (kind === "select") {
          const err = spec.failReads?.(table);
          if (err) return { data: null, error: err, count: null };
          return { data: (store[table] ?? []).filter(match), error: null, count: null };
        }
        const err = spec.failWrites?.(table);
        if (err) return { data: null, error: err, count: null };
        if (kind === "insert") {
          const list = Array.isArray(payload) ? payload : [payload];
          const rows = list.map((p: any, i: number) => ({ id: `gen-${table}-${i}`, ...p }));
          (store[table] ??= []).push(...rows);
          return { data: returning ? rows : null, error: null, count: null };
        }
        if (kind === "update") {
          // THE POINT OF THIS FAKE. Only the rows the filters actually match
          // are touched, and only those come back.
          const hit = (store[table] ?? []).filter(match);
          for (const r of hit) Object.assign(r, payload);
          return { data: returning ? hit : null, error: null, count: null };
        }
        const kept = (store[table] ?? []).filter((r) => !match(r));
        const removed = (store[table] ?? []).length - kept.length;
        store[table] = kept;
        return { data: returning ? new Array(removed).fill({}) : null, error: null, count: null };
      }

      const b: any = {
        select(_c?: string) { returning = true; if (kind === "select") returning = true; return b; },
        insert(p: any) { kind = "insert"; payload = p; returning = false; return b; },
        upsert(p: any) { kind = "insert"; payload = p; returning = false; return b; },
        update(p: any) { kind = "update"; payload = p; returning = false; return b; },
        delete() { kind = "delete"; returning = false; return b; },
        eq(c: string, v: any)  { filters.push([c, "eq", v]);  return b; },
        neq(c: string, v: any) { filters.push([c, "neq", v]); return b; },
        in(c: string, v: any)  { filters.push([c, "in", v]);  return b; },
        is(c: string, v: any)  { filters.push([c, "is", v]);  return b; },
        not(c: string, op: string, v: any) { filters.push([c, `not.${op}`, v]); return b; },
        gt(c: string, v: any)  { filters.push([c, "gt", v]);  return b; },
        lt(c: string, v: any)  { filters.push([c, "lt", v]);  return b; },
        gte() { return b; }, lte() { return b; }, or() { return b; },
        order() { return b; }, limit() { return b; }, range() { return b; },
        maybeSingle() {
          const r = settle();
          if (r.error) return Promise.resolve(r);
          const list = (r.data as any[]) ?? [];
          return Promise.resolve({ data: list[0] ?? null, error: null, count: null });
        },
        single() {
          const r = settle();
          if (r.error) return Promise.resolve(r);
          const list = (r.data as any[]) ?? [];
          if (list.length !== 1) {
            return Promise.resolve({
              data: null,
              error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
              count: null,
            });
          }
          return Promise.resolve({ data: list[0], error: null, count: null });
        },
        then(onF: any, onR: any) { return Promise.resolve(settle()).then(onF, onR); },
      };
      // `.select()` on a mutation is the RETURNING clause.
      const rawSelect = b.select;
      b.select = (c?: string) => { returning = true; return rawSelect.call(b, c); };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

function liveLocationSession() {
  return {
    id: SESSION, user_id: USER, session_type: "trusted_circle",
    started_at: new Date().toISOString(), expires_at: null, ended_at: null,
    city: "Da Nang", district: null, country: "Vietnam",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// endSession — the revocation
// ═══════════════════════════════════════════════════════════════════════════

describe("LocationSessionService.endSession — a revocation that changed nothing is not a revocation", () => {
  it("ends a live session and reports 'ended'", async () => {
    const rows = { location_sessions: [liveLocationSession()] };
    const db = makeRowFake({ rows });

    const result = await endSession(db, SESSION, USER);

    assert.equal(result.outcome, "ended");
    assert.notEqual(rows.location_sessions[0]!.ended_at, null, "the row must actually carry ended_at");
  });

  it("a session that does not belong to this user reports 'not_found' — NOT 'ended'", async () => {
    // The pre-fix body returned `true` here: the UPDATE matched zero rows,
    // `error` was null, and "location sharing revoked" was reported for a
    // statement that touched nothing.
    const db = makeRowFake({ rows: { location_sessions: [liveLocationSession()] } });

    const result = await endSession(db, SESSION, "someone-else");

    assert.equal(result.outcome, "not_found");
    assert.notEqual(result.outcome as string, "ended");
  });

  it("a session already ended reports 'already_ended' — the idempotent zero, named", async () => {
    const ended = { ...liveLocationSession(), ended_at: new Date().toISOString() };
    const db = makeRowFake({ rows: { location_sessions: [ended] } });

    const result = await endSession(db, SESSION, USER);

    assert.equal(result.outcome, "already_ended", "sharing is off; this is a legitimate zero-row update");
  });

  it("a failed UPDATE reports 'unavailable' — never 'ended'", async () => {
    const db = makeRowFake({
      rows: { location_sessions: [liveLocationSession()] },
      failWrites: (t) => (t === "location_sessions" ? DB_ERROR : null),
    });

    const result = await endSession(db, SESSION, USER);

    assert.equal(result.outcome, "unavailable");
    assert.match(String((result as any).reason), /connection/i);
  });

  it("a zero-row UPDATE whose disambiguating READ also fails reports 'unavailable', not 'not_found'", async () => {
    const db = makeRowFake({
      rows: { location_sessions: [] },
      failReads: (t) => (t === "location_sessions" ? DB_ERROR : null),
    });

    const result = await endSession(db, SESSION, USER);

    assert.equal(result.outcome, "unavailable", "state is unknown, and unknown must not render as a tidy 'no such session'");
  });
});

describe("LocationSessionService.getActiveSessions — 'you are sharing with nobody' needs a successful read", () => {
  it("an unreadable table reports ok:false, not an empty list", async () => {
    const db = makeRowFake({
      rows: { location_sessions: [liveLocationSession()] },
      failReads: () => DB_ERROR,
    });

    const result = await getActiveSessions(db, USER);

    assert.equal(result.ok, false);
  });

  it("a readable, empty table reports ok:true with no sessions", async () => {
    const db = makeRowFake({ rows: { location_sessions: [] } });

    const result = await getActiveSessions(db, USER);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.sessions : null, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Location privacy — a failed read is not permission
// ═══════════════════════════════════════════════════════════════════════════

describe("LocationPermissionService.loadPreferences — an unreadable preferences row must fail CLOSED", () => {
  it("a read error yields no sharing at all, flagged as degraded", async () => {
    const db = makeRowFake({
      rows: { location_preferences: [{ user_id: USER, location_mode: "trusted_circle_live", sharing_paused: false }] },
      failReads: (t) => (t === "location_preferences" ? DB_ERROR : null),
    });

    const prefs = await loadPreferences(db as any, USER);

    assert.equal(prefs.degraded, true, "the caller must be able to tell these are not the user's stored settings");
    assert.equal(prefs.locationMode, "off");
    assert.equal(prefs.sharingPaused, true);
    assert.equal(isSharingActive(prefs), false, "the permissive DEFAULT_PREFS made this TRUE for a read that never happened");
    assert.equal(effectivePulseVisibility(prefs), "no_location");
    assert.equal(prefs.hotelBlurEnabled, true, "closed means blur, never expose");
    assert.equal(prefs.safeReturnEnabled, true, "closed reduces DISCLOSURE; it must not switch off a safety feature");
  });

  it("an absent row is a real answer and still gets the shipped defaults", async () => {
    const db = makeRowFake({ rows: { location_preferences: [] } });

    const prefs = await loadPreferences(db as any, USER);

    assert.equal(prefs.degraded, false, "a user who never opened settings has genuinely made no choice");
    assert.equal(prefs.locationMode, "city_only");
    assert.equal(isSharingActive(prefs), true);
  });

  it("a stored opt-out is still honoured when the read succeeds", async () => {
    const db = makeRowFake({
      rows: { location_preferences: [{ user_id: USER, location_mode: "off", sharing_paused: true }] },
    });

    const prefs = await loadPreferences(db as any, USER);

    assert.equal(prefs.degraded, false);
    assert.equal(isSharingActive(prefs), false);
  });
});

describe("GeoZoneService hotel blur — an unperformed check must not skip the blur", () => {
  it("a read error yields near: 'unknown', which is not false", async () => {
    const db = makeRowFake({ rows: { location_sessions: [] }, failReads: () => DB_ERROR });

    const result = await checkNearPrivateStay(db as any, USER, 16.05, 108.2);

    assert.equal(result.near, "unknown");
    assert.notEqual(result.near, false);
  });

  it("the boolean form resolves 'unknown' to TRUE — the blur-applying direction", async () => {
    const db = makeRowFake({ rows: { location_sessions: [] }, failReads: () => DB_ERROR });

    assert.equal(
      await isNearPrivateStay(db as any, USER, 16.05, 108.2), true,
      "returning false here published a hotel-precision pin for exactly the users the table would have named",
    );
  });

  it("a successful read with no private stay is still a real false", async () => {
    const db = makeRowFake({ rows: { location_sessions: [] } });

    const result = await checkNearPrivateStay(db as any, USER, 16.05, 108.2);

    assert.equal(result.near, false);
    assert.equal(await isNearPrivateStay(db as any, USER, 16.05, 108.2), false);
  });
});

describe("LocationSafetyService.getUserTrustLevel — a check that did not run is not a check that passed", () => {
  it("an unreadable location_trust_events reports 'review', not 'trusted'", async () => {
    const db = makeRowFake({ rows: { location_trust_events: [] }, failReads: () => DB_ERROR });

    const level = await getUserTrustLevel(db as any, USER);

    assert.equal(level, "review");
    assert.notEqual(level, "trusted", "'trusted' is the verdict a GPS spoofer wants out of an outage");
  });

  it("a readable log with no unreviewed events is genuinely 'trusted'", async () => {
    const db = makeRowFake({ rows: { location_trust_events: [] } });

    assert.equal(await getUserTrustLevel(db as any, USER), "trusted");
  });

  it("a high-confidence event still reports 'suspicious'", async () => {
    const db = makeRowFake({
      rows: { location_trust_events: [{ user_id: USER, event_type: "impossible_speed", confidence: "high", reviewed_at: null, created_at: new Date().toISOString() }] },
    });

    assert.equal(await getUserTrustLevel(db as any, USER), "suspicious");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return service — contacts, stamps, and the escalation feed
// ═══════════════════════════════════════════════════════════════════════════

describe("SafeReturnService.createSession — contacts that were not stored must not be reported as stored", () => {
  it("a failed contacts insert still returns the session, with contactsSaved 0 and a reason", async () => {
    const db = makeRowFake({
      rows: { safe_return_sessions: [], safe_return_contacts: [], safe_return_events: [] },
      failWrites: (t) => (t === "safe_return_contacts" ? DB_ERROR : null),
    });

    const result = await createSession(db as any, {
      userId: USER,
      timerMinutes: 30,
      trustedCircleEnabled: true,
      contacts: [
        { contactUserId: CONTACT, contactMethod: "in_app", canReceiveLiveLocation: false },
        { contactUserId: null, contactName: "Mum", contactMethod: "sms" },
      ],
    });

    assert.ok(result, "the timer and the traveller's own alert are real and worth keeping");
    assert.equal(result!.contactsRequested, 2);
    assert.equal(result!.contactsSaved, 0, "a session that will alert nobody must not report two saved contacts");
    assert.ok(result!.contactsError, "the reason travels with the result so the route can tell the user");
  });

  it("the audit trail records the shortfall as its own event", async () => {
    const rows: Record<string, any[]> = { safe_return_sessions: [], safe_return_contacts: [], safe_return_events: [] };
    const db = makeRowFake({ rows, failWrites: (t) => (t === "safe_return_contacts" ? DB_ERROR : null) });

    await createSession(db as any, {
      userId: USER, timerMinutes: 30,
      contacts: [{ contactUserId: CONTACT, contactMethod: "in_app" }],
    });

    const types = rows.safe_return_events!.map((e) => e.event_type);
    assert.ok(types.includes("contacts_not_stored"), `expected contacts_not_stored, got ${JSON.stringify(types)}`);
  });

  it("a clean create reports every contact saved and writes no shortfall event", async () => {
    const rows: Record<string, any[]> = { safe_return_sessions: [], safe_return_contacts: [], safe_return_events: [] };
    const db = makeRowFake({ rows });

    const result = await createSession(db as any, {
      userId: USER, timerMinutes: 30,
      contacts: [{ contactUserId: CONTACT, contactMethod: "in_app" }],
    });

    assert.equal(result!.contactsRequested, 1);
    assert.equal(result!.contactsSaved, 1);
    assert.equal(result!.contactsError, undefined);
    assert.equal(rows.safe_return_events!.some((e) => e.event_type === "contacts_not_stored"), false);
  });
});

describe("SafeReturnService.markContactNotified — the idempotent zero, and the failure that is not one", () => {
  function contactRow(notifiedAt: string | null) {
    return { id: CONTACT, session_id: SESSION, notified_at: notifiedAt };
  }

  it("stamping an un-notified contact succeeds", async () => {
    const rows = { safe_return_contacts: [contactRow(null)] };
    const db = makeRowFake({ rows });

    assert.equal((await markContactNotified(db as any, CONTACT)).ok, true);
    assert.notEqual(rows.safe_return_contacts[0]!.notified_at, null);
  });

  it("an already-notified contact is a legitimate zero-row update and still reports ok", async () => {
    const stamped = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const rows = { safe_return_contacts: [contactRow(stamped)] };
    const db = makeRowFake({ rows });

    assert.equal((await markContactNotified(db as any, CONTACT)).ok, true);
    assert.equal(rows.safe_return_contacts[0]!.notified_at, stamped, "the original stamp must not be overwritten");
  });

  it("a failed update reports ok:false — it used to bind nothing and drop the error", async () => {
    const db = makeRowFake({
      rows: { safe_return_contacts: [contactRow(null)] },
      failWrites: () => DB_ERROR,
    });

    const result = await markContactNotified(db as any, CONTACT);

    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
});

describe("SafeReturnService.findExpiredActiveSessions — the escalation job's off switch", () => {
  it("an unreadable table reports ok:false rather than 'nothing has expired'", async () => {
    const db = makeRowFake({ rows: { safe_return_sessions: [] }, failReads: () => DB_ERROR });

    const result = await findExpiredActiveSessions(db as any);

    assert.equal(result.ok, false, "an empty list here silently stands the whole escalation system down");
  });

  it("a readable, empty table reports ok:true with nothing to do", async () => {
    const db = makeRowFake({ rows: { safe_return_sessions: [] } });

    const result = await findExpiredActiveSessions(db as any);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : null, []);
  });
});

describe("SafeReturnService.cancelSession — 'no_match' and 'unavailable' are different answers", () => {
  const active = {
    id: SESSION, user_id: USER, status: "active", escalation_level: 0,
    trusted_circle_enabled: false, live_share_enabled: false,
    notify_host_enabled: false, notify_trip_crew_enabled: false,
    timer_start_at: null, timer_end_at: null, last_prompt_at: null,
    last_safe_confirmation_at: null, plan_item_id: null, trip_id: null,
    trigger_reason: null, emergency_note: null, closed_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  it("a wrong id is 'no_match'", async () => {
    const db = makeRowFake({ rows: { safe_return_sessions: [{ ...active }], safe_return_events: [] } });

    const result = await cancelSession(db as any, "nope", USER);

    assert.equal(result.outcome, "no_match");
  });

  it("a failed write is 'unavailable', so the route can say the session may still be running", async () => {
    const db = makeRowFake({
      rows: { safe_return_sessions: [{ ...active }], safe_return_events: [] },
      failWrites: (t) => (t === "safe_return_sessions" ? DB_ERROR : null),
    });

    const result = await cancelSession(db as any, SESSION, USER);

    assert.equal(result.outcome, "unavailable");
    assert.notEqual(result.outcome as string, "no_match");
  });

  it("a real cancel closes the session", async () => {
    const rows = { safe_return_sessions: [{ ...active }], safe_return_events: [] as any[] };
    const db = makeRowFake({ rows });

    const result = await cancelSession(db as any, SESSION, USER);

    assert.equal(result.outcome, "ok");
    assert.equal(rows.safe_return_sessions[0]!.status, "cancelled");
  });
});
