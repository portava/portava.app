/**
 * census-compass CT-02 — the code-actionable half, proved.
 *
 * WHAT CT-02 ASKS, AND WHAT THIS SUITE IS ABOUT
 * =============================================
 * CT-02 is *"Consume typed Trip projections rather than duplicating Trip
 * semantics"*. §15.4 closed the duplication of SELECTION across four modules
 * (`compass/CompassCurrentTrip.ts`) and recorded what the duplication had been
 * CONCEALING: the copies bound no `error`, so an unreadable `trip_members`
 * came out as *"No active or upcoming trip."* — the assistant telling a
 * traveller standing in Lisbon that they have no trip.
 *
 * That fix stopped at the two files that lane owned. §27.7 then recorded CT-02
 * as *"honestly short… 14 reads across 10 further `compass/` modules remain"*.
 * This suite is the same defect in the modules nobody had opened, each pinned
 * with the real failure shape:
 *
 *     supabase-js RESOLVES { data: null, error } on a database error.
 *
 * It does not throw. So `try/catch` is dead code for this class and `data ?? []`
 * is the defect — which is why every case below drives a client that RESOLVES
 * an error for one named table (`makeClient(..., { errors })`) rather than one
 * that throws. A fake that could only throw cannot see any of these bugs.
 *
 * EVERY CASE HAS A POSITIVE CONTROL. A fix that blanks the feature passes a
 * failure test and ships; so each group also asserts the working behaviour over
 * a healthy store, and those controls are the half that would catch it.
 *
 * TEST-FIRST — what RED looked like, per group, before the source changed:
 *   A1  getAutopilotSettings returned `{enabled:true, allowMoveFlexible:true,
 *       allowMoveOptional:true}` from defaultAutopilotSettings() on an
 *       unreadable table: a user's REVOKED permission granted back by the
 *       failure of the read whose job was to honour the revocation.
 *   A2  applyProposal then moved the item — `applied: 1` — on a permission it
 *       had never observed.
 *   A3  upsertAutopilotSettings merged the patch onto those defaults and wrote
 *       all four columns: a transient read failure became a DURABLE grant.
 *   A4  computeHeartbeat answered an unreadable `trip_plan_items` with
 *       `status: "healthy"`, `itemCounts.total: 0` and no issues.
 *   A5  runAutopilotCheck read the pending-proposal dedupe set as `[]` and
 *       INSERTED a duplicate of every proposal the user already had.
 *   B1  buildLiveRollingContext wrote `currentStop: null` over the real stop
 *       and recorded a bogus transition event — a failed read persisted.
 *   C1  toolWhosAround said "The user has no active trips or upcoming events
 *       with a circle to check." while trip_members was erroring.
 *   C2  resolveGroupMemberIds said "the user has no active or upcoming trip
 *       group", discarding the `info` get_current_trip had written.
 *   D1  buildFallbackFeed returned `fallbackReason: "x"` with no active_trip
 *       section — a degradation presented as an absence by the one surface
 *       whose whole job is honesty about degradation.
 *   E1  buildProfile returned `hasActiveTrip: false` over an unreadable
 *       trip_members and getCompassProfile CACHED it for two minutes.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassTripReadsNeverEmpty.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { makeClient } from "./highlightRouteHarness.js";
import {
  getAutopilotSettings,
  upsertAutopilotSettings,
  applyProposal,
  computeHeartbeat,
  runAutopilotCheck,
  fetchPlanItems,
} from "../compass/CompassAutopilotEngine.js";
import { buildLiveRollingContext } from "../compass/CompassLiveEngine.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildFallbackFeed } from "../compass/CompassFallbackFeedBuilder.js";
import { getCompassProfile, clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { resolveMemberTripIds } from "../compass/CompassCurrentTrip.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const TRIP = "11111111-0000-4000-8000-000000000001";
const USER = "22222222-0000-4000-8000-000000000002";
const MATE = "33333333-0000-4000-8000-000000000003";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PROP = "cccccccc-0000-4000-8000-00000000000c";

const ERR = { message: "canceling statement due to statement timeout", code: "57014" };

function planItem(id: string, title: string, startsAt: string, endsAt: string) {
  return {
    id, trip_id: TRIP, title, category: "activity", status: "planned", lock_type: "flexible",
    day_date: "2026-10-01", starts_at: startsAt, ends_at: endsAt, location_name: null, lat: null, lng: null,
    source_type: "manual", source_id: null, sort_order: 0, removed_at: null,
  };
}

/** A (10:00–11:00) overlapped by B (10:30–11:30) — the `timing:A:B` conflict. */
const OVERLAPPING = () => [
  planItem(A, "Museum", "2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"),
  planItem(B, "Lunch",  "2026-10-01T10:30:00.000Z", "2026-10-01T11:30:00.000Z"),
];

/** The repair that conflict produces: move B to 13:00. */
const MOVE_B = [{
  itemId: B, title: "Lunch", lockType: "flexible",
  before: { startsAt: "2026-10-01T10:30:00.000Z" },
  after:  { startsAt: "2026-10-01T13:00:00.000Z", endsAt: "2026-10-01T14:00:00.000Z" },
}];

function autopilotStore(over: Record<string, any[]> = {}) {
  return {
    feature_flags: [{ flag: "trip_kernel_enabled", enabled: true }],
    trips: [{ id: TRIP, destination_city: null, start_date: "2026-10-01", end_date: "2026-10-03" }],
    trip_plan_items: OVERLAPPING(),
    trip_autopilot_settings: [] as any[],
    trip_autopilot_proposals: [] as any[],
    meetups: [] as any[],
    ...over,
  };
}

/**
 * ERROR ONLY THE `maybeSingle()` READS of one table, leaving its writes alone.
 *
 * `makeClient`'s `errors` map fails a table for every operation, which cannot
 * express the case `upsertAutopilotSettings` turns into a defect: the READ
 * failed and the WRITE then SUCCEEDED, carrying the permissive defaults into
 * the row. With both failing the refusal is indistinguishable from a refused
 * write, and the mutation that restores the old merge survives (measured: M2,
 * 30 pass / 0 fail, before this helper existed).
 */
function readErrorOnly(sc: any, table: string) {
  const realFrom = sc.from.bind(sc);
  sc.from = (t: string) => {
    const b = realFrom(t);
    if (t !== table) return b;
    const wrapped = new Proxy(b, {
      get(target, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: null, error: ERR });
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? (...a: any[]) => { const r = v.apply(target, a); return r === target ? wrapped : r; } : v;
      },
    });
    return wrapped;
  };
  return sc;
}

/**
 * ERROR THE Nth AND LATER reads of one table.
 *
 * Needed because the two reads a request makes of `trip_members` do different
 * jobs — the SELECTION union, then the trip's ROSTER — and failing the table
 * outright stops at the first, so the roster's own refusal is never reached and
 * a mutation that removes it survives (measured: M12 and M18, 30 pass / 0 fail).
 */
function errorFromNthRead(sc: any, table: string, nth: number) {
  let seen = 0;
  const realFrom = sc.from.bind(sc);
  sc.from = (t: string) => {
    const b = realFrom(t);
    if (t !== table) return b;
    seen += 1;
    if (seen < nth) return b;
    const chain: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: any) => Promise.resolve({ data: null, error: ERR, count: null }).then(res);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: ERR });
        if (prop === "catch" || prop === "finally") return undefined;
        return () => chain;
      },
    });
    return chain;
  };
  return sc;
}

/** The shared harness does not model the kernel RPC; this applies the patch, as the kernel does. */
function withKernel(sc: any) {
  sc.rpc = async (name: string, args: any) => {
    if (name !== "trip_kernel_execute") return { data: null, error: { message: "rpc not modelled" } };
    const cmd = args?.p_command ?? {};
    const patch = (cmd.payload?.patch ?? {}) as Record<string, unknown>;
    for (const r of sc._store.trip_plan_items ?? []) if (r.id === cmd.payload?.item_id) Object.assign(r, patch);
    return { data: { ok: true, duplicate: false, version: 2, event_id: "e1", sequence: 1, result: null, contract_version: 2 }, error: null };
  };
  return sc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Trip Autopilot — the permission read, the write it fed, and the health view
// ═══════════════════════════════════════════════════════════════════════════════

describe("CT-02 A — an unreadable autopilot settings row is never a GRANT", () => {
  it("A1 unread: the read says so instead of answering with the permissive defaults", async () => {
    const sc = makeClient(autopilotStore(), { errors: { trip_autopilot_settings: ERR } });
    const read = await getAutopilotSettings(sc as any, TRIP, USER);
    assert.equal(read.status, "unread", "an errored settings read must not be answered with defaults");
    assert.doesNotMatch(JSON.stringify(read), /"enabled":true/,
      "defaultAutopilotSettings() grants enabled + both move permissions; a failed read may not produce them");
  });

  it("A1 control: no row means NOT CONFIGURED, which is the case the defaults are for", async () => {
    const sc = makeClient(autopilotStore());
    const read = await getAutopilotSettings(sc as any, TRIP, USER);
    assert.equal(read.status, "ok");
    assert.equal(read.status === "ok" && read.configured, false, "absence and unreadability are different facts");
    assert.equal(read.status === "ok" && read.settings.enabled, true, "an unconfigured user still gets the documented defaults");
  });

  it("A1 control: a configured row is read verbatim, revocations included", async () => {
    const sc = makeClient(autopilotStore({
      trip_autopilot_settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: false, allow_remove_optional: false }],
    }));
    const read = await getAutopilotSettings(sc as any, TRIP, USER);
    assert.equal(read.status, "ok");
    assert.equal(read.status === "ok" && read.settings.allowMoveFlexible, false);
  });

  it("A2 the CONFIRM refuses when the permissions it re-checks could not be read — nothing is written", async () => {
    const sc = withKernel(makeClient(autopilotStore(), { errors: { trip_autopilot_settings: ERR } }));
    const before = JSON.stringify(sc._store.trip_plan_items);
    const r = await applyProposal(sc as any, {
      id: PROP, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict",
      dedupe_key: `fix:timing:${A}:${B}`, changes: MOVE_B,
    });
    assert.equal(r.applied, 0, "a Trip Kernel command was issued on a permission that was never observed");
    assert.match(r.blocked.join(" "), /permissions could not be read/i);
    assert.equal(JSON.stringify(sc._store.trip_plan_items), before, "the plan was changed over an unread permission");
  });

  it("A2 control: the same confirm still APPLIES over a healthy read, and is still refused by name when revoked", async () => {
    const ok = withKernel(makeClient(autopilotStore()));
    const applied = await applyProposal(ok as any, {
      id: PROP, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict",
      dedupe_key: `fix:timing:${A}:${B}`, changes: MOVE_B,
    });
    assert.equal(applied.applied, 1, JSON.stringify(applied));
    assert.equal(ok._store.trip_plan_items.find((i: any) => i.id === B)?.starts_at, "2026-10-01T13:00:00.000Z");

    const revoked = withKernel(makeClient(autopilotStore({
      trip_autopilot_settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: false, allow_remove_optional: false }],
    })));
    const refused = await applyProposal(revoked as any, {
      id: PROP, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict",
      dedupe_key: `fix:timing:${A}:${B}`, changes: MOVE_B,
    });
    assert.equal(refused.applied, 0);
    assert.match(refused.blocked.join(" "), /not permitted by your autopilot settings/,
      "the revocation must still be refused for the PERMISSION, not for the read");
  });

  it("A3 a failed read does not become a WRITE: the patch is refused, and no row is upserted", async () => {
    const sc = makeClient(autopilotStore(), { errors: { trip_autopilot_settings: ERR } });
    const saved = await upsertAutopilotSettings(sc as any, TRIP, USER, { enabled: false });
    assert.equal(saved.status, "unread");
    assert.equal((sc._store.trip_autopilot_settings ?? []).length, 0,
      "a read that failed was merged onto the permissive defaults and written over the user's real settings");
  });

  it("A3 the read failed and the write WOULD have succeeded — the row is still untouched", async () => {
    // The shape of the original defect exactly: `getAutopilotSettings` returns
    // the permissive defaults, `{...defaults, ...patch}` is upserted, and all
    // four columns land — so the user's stored `allow_move_flexible: false`
    // becomes `true` because they toggled something else.
    const sc = readErrorOnly(makeClient(autopilotStore({
      trip_autopilot_settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: false, allow_remove_optional: false }],
    })), "trip_autopilot_settings");
    const saved = await upsertAutopilotSettings(sc as any, TRIP, USER, { enabled: false });
    assert.equal(saved.status, "unread", "a read that failed must not be merged and written");
    assert.equal(sc._store.trip_autopilot_settings[0]!.allow_move_flexible, false,
      "the revocation was overwritten with a default by a WRITE built on a FAILED READ");
    assert.equal(sc._store.trip_autopilot_settings[0]!.enabled, true, "and the patch itself was not applied either");
  });

  it("A1 the same read-only failure is `unread` at the settings seam, not the defaults", async () => {
    const sc = readErrorOnly(makeClient(autopilotStore()), "trip_autopilot_settings");
    const read = await getAutopilotSettings(sc as any, TRIP, USER);
    assert.equal(read.status, "unread");
  });

  it("A3 control: a real patch still saves, and the UNTOUCHED columns keep their stored values", async () => {
    const sc = makeClient(autopilotStore({
      trip_autopilot_settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: true, allow_remove_optional: false }],
    }));
    const saved = await upsertAutopilotSettings(sc as any, TRIP, USER, { enabled: false });
    assert.equal(saved.status, "ok");
    assert.equal(saved.status === "ok" && saved.settings.enabled, false, "the patch applied");
    assert.equal(saved.status === "ok" && saved.settings.allowMoveFlexible, false,
      "the stored revocation survived a patch to a different field");
    assert.equal(sc._store.trip_autopilot_settings[0]!.allow_move_flexible, false);
  });

  it("A4 the Heartbeat says `unknown`, not `healthy`, when the plan could not be read", async () => {
    const sc = makeClient(autopilotStore(), { errors: { trip_plan_items: ERR } });
    const hb = await computeHeartbeat(sc as any, TRIP, USER, { nowMs: Date.parse("2026-10-01T09:00:00.000Z") });
    assert.equal(hb.status, "unknown", "`healthy` over an unread plan is the one value a traveller acts on by doing nothing");
    assert.deepEqual(hb.unreadSources, ["trip_plan_items"]);
    assert.equal(hb.itemCounts, null, "0 items is a claim about the trip; null is a fact about the read");
    assert.equal(hb.pendingProposals, null);
  });

  it("A4 control: a readable plan still produces a real verdict, counts and next item", async () => {
    const sc = makeClient(autopilotStore());
    const hb = await computeHeartbeat(sc as any, TRIP, USER, { nowMs: Date.parse("2026-10-01T09:00:00.000Z") });
    assert.deepEqual(hb.unreadSources, []);
    assert.equal(hb.itemCounts?.total, 2);
    assert.equal(hb.pendingProposals, 0, "a READ zero is still zero");
    assert.notEqual(hb.status, "unknown");
    assert.equal(hb.nextItem?.id, A);
    assert.ok(hb.issues.length > 0, "the overlapping pair is a real timing conflict and must still be found");
  });

  it("A4 a clean partial reading is `unknown` too — a missing source is not a clean bill of health", async () => {
    const sc = makeClient(autopilotStore({ trip_plan_items: [] }), { errors: { trip_autopilot_proposals: ERR } });
    const hb = await computeHeartbeat(sc as any, TRIP, USER, { nowMs: Date.parse("2026-10-01T09:00:00.000Z") });
    assert.equal(hb.status, "unknown");
    assert.deepEqual(hb.unreadSources, ["trip_autopilot_proposals"]);
    assert.equal(hb.pendingProposals, null);
  });

  it("A5 an unreadable dedupe set creates NOTHING — it used to insert a duplicate of every pending proposal", async () => {
    const sc = makeClient(autopilotStore(), { errors: { trip_autopilot_proposals: ERR } });
    const r = await runAutopilotCheck(sc as any, TRIP, USER);
    assert.deepEqual(r.proposalsCreated, [], "a failed READ became a WRITE");
    assert.equal((sc._store.trip_autopilot_proposals ?? []).length, 0);
    assert.ok(r.unreadSources.includes("trip_autopilot_proposals"));
    assert.ok(r.issues.length > 0, "the issues that WERE read are still reported — the plan was readable");
  });

  it("A5 control: with the dedupe set readable the proposal is created, and a second run skips it", async () => {
    const sc = makeClient(autopilotStore());
    const first = await runAutopilotCheck(sc as any, TRIP, USER);
    assert.equal(first.proposalsCreated.length, 1, JSON.stringify(first));
    assert.deepEqual(first.unreadSources, []);
    const second = await runAutopilotCheck(sc as any, TRIP, USER);
    assert.equal(second.proposalsCreated.length, 0);
    assert.equal(second.proposalsSkipped, 1, "the dedupe must still dedupe");
  });

  it("A5 an unreadable PLAN ends the run rather than reporting a clean check over nothing", async () => {
    const sc = makeClient(autopilotStore(), { errors: { trip_plan_items: ERR } });
    const r = await runAutopilotCheck(sc as any, TRIP, USER);
    assert.deepEqual(r.issues, []);
    assert.ok(r.unreadSources.includes("trip_plan_items"),
      "zero issues over an unread plan must be labelled, or it reads as 'nothing is wrong'");
    const read = await fetchPlanItems(sc as any, TRIP);
    assert.equal(read.status, "unread");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Compass Live — the rolling context is PERSISTED, so a failed read persists
// ═══════════════════════════════════════════════════════════════════════════════

function liveStore(items: any[]) {
  return {
    trips: [{ id: TRIP, owner_id: USER, title: "Lisbon", destination_city: "Lisbon", destination_country: "PT", start_date: "2026-10-01", end_date: "2026-10-05", status: "active", timezone: null }],
    trip_members: [{ trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" }],
    trip_plan_items: items,
    user_location_state: [] as any[],
  };
}

const TODAY = new Date().toISOString().slice(0, 10);
const liveItem = (id: string, title: string, hhmm: string) => ({
  id, trip_id: TRIP, title, status: "planned", day_date: TODAY, starts_at: `${TODAY}T${hhmm}:00.000Z`, removed_at: null,
});

describe("CT-02 B — an unreadable day does not erase where the traveller is", () => {
  const nowMs = Date.parse(`${TODAY}T12:00:00.000Z`);

  it("B1 control: a readable day resolves the current stop and the next item", async () => {
    const sc = makeClient(liveStore([liveItem(A, "Castle", "09:00"), liveItem(B, "Dinner", "19:00")]));
    const ctx = await buildLiveRollingContext(sc as any, USER, null, nowMs);
    assert.equal(ctx.currentStop?.id, A);
    assert.equal(ctx.nextItem?.id, B);
    assert.equal(ctx.planUnread, false);
  });

  it("B1 an unreadable plan carries the previous context forward instead of writing nulls over it", async () => {
    const healthy = makeClient(liveStore([liveItem(A, "Castle", "09:00"), liveItem(B, "Dinner", "19:00")]));
    const previous = await buildLiveRollingContext(healthy as any, USER, null, nowMs);

    const broken = makeClient(liveStore([liveItem(A, "Castle", "09:00"), liveItem(B, "Dinner", "19:00")]), { errors: { trip_plan_items: ERR } });
    const ctx = await buildLiveRollingContext(broken as any, USER, previous, nowMs + 60_000);

    assert.equal(ctx.planUnread, true, "the reading was incomplete and the context must say so");
    assert.equal(ctx.currentStop?.id, A, "the real stop was replaced with null because one query failed");
    assert.equal(ctx.nextItem?.id, B);
    assert.deepEqual(
      ctx.recentEvents.filter((e) => e.kind === "reached_stop" || e.kind === "next_item_changed"),
      previous.recentEvents.filter((e) => e.kind === "reached_stop" || e.kind === "next_item_changed"),
      "a transition is a fact about the plan and may not be invented from a failed read",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. The two sentences the assistant repeats as fact
// ═══════════════════════════════════════════════════════════════════════════════

function socialStore(over: Record<string, any[]> = {}) {
  return {
    trips: [{ id: TRIP, owner_id: USER, title: "Lisbon", destination_city: "Lisbon", destination_country: "PT", start_date: "2026-10-01", end_date: "2026-10-05", status: "active", timezone: null }],
    trip_members: [
      { trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: MATE, role: "member", status: "accepted" },
    ],
    event_rsvps: [] as any[],
    events: [] as any[],
    event_attendees: [] as any[],
    profiles: [{ id: MATE, handle: "mate", name: null, display_name: null }],
    ...over,
  };
}

describe("CT-02 C — 'you have no trips' is never said about a table that could not be read", () => {
  it("C1 whos_around: an unreadable trip_members is disclosed, not reported as having no trips", async () => {
    const sc = makeClient(socialStore(), { errors: { trip_members: ERR } });
    const out: any = await executeCompassTool(sc as any, USER, null, "get_whos_around", {});
    assert.match(String(out.info), /could not be read/i);
    assert.doesNotMatch(String(out.info), /has no active trips/i,
      "the assistant repeats this line as fact to a traveller who IS on a trip");
    assert.doesNotMatch(String(out.info), /Nobody in the user's circles is sharing/i);
    assert.deepEqual(out.people, []);
  });

  it("C1 control: with no trip and no event the honest absence sentence is still used", async () => {
    const sc = makeClient(socialStore({ trips: [], trip_members: [] }));
    const out: any = await executeCompassTool(sc as any, USER, null, "get_whos_around", {});
    assert.match(String(out.info), /has no active trips or upcoming events/i,
      "a real absence must still read as an absence");
    assert.doesNotMatch(String(out.info), /could not be read/i);
  });

  it("C1 control: a readable context with nobody sharing is the third, distinct sentence", async () => {
    const sc = makeClient(socialStore());
    const out: any = await executeCompassTool(sc as any, USER, null, "get_whos_around", {});
    assert.match(String(out.info), /Nobody in the user's circles is sharing/i);
    assert.doesNotMatch(String(out.info), /could not be read/i);
  });

  it("C1 a context that resolved but whose ROSTER could not be read is disclosed too", async () => {
    // The selection read succeeds and the roster read fails. `contextsChecked`
    // is 1, so the absence sentence does not fire — and before this the roster
    // failure was swallowed by a bare `continue`, leaving "Nobody in the user's
    // circles is sharing their presence right now" as the answer to a table
    // that was never read.
    const sc = errorFromNthRead(makeClient(socialStore()), "trip_members", 2);
    const out: any = await executeCompassTool(sc as any, USER, null, "get_whos_around", {});
    assert.match(String(out.info), /could not be read/i);
    assert.doesNotMatch(String(out.info), /Nobody in the user's circles is sharing/i);
  });

  it("C2 the roster read's OWN failure refuses the group, rather than recommending for one person", async () => {
    // Selection read 1 succeeds; the roster is read 2. With the refusal removed
    // the roster is `[]`, `ids` is `{userId}` and the group recommendation is
    // computed for the caller alone and returned under the group's name.
    const sc = errorFromNthRead(makeClient(socialStore()), "trip_members", 2);
    const out: any = await executeCompassTool(sc as any, USER, null, "get_group_recommendation", {});
    const said = String(out.info ?? out.error ?? "");
    assert.match(said, /member list could not be read/i, said);
  });

  it("C2 the group roster: an unreadable trip_members is not a group of one", async () => {
    const sc = makeClient(socialStore(), { errors: { trip_members: ERR } });
    const out: any = await executeCompassTool(sc as any, USER, null, "get_group_recommendation", {});
    assert.match(String(out.info ?? out.error ?? ""), /could not be read/i);
    assert.doesNotMatch(String(out.info ?? out.error ?? ""), /has no active or upcoming trip group/i,
      "`toolGetCurrentTrip` had already distinguished unread from none; this discarded it");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. The fallback feed — the surface whose whole job is honesty about degrading
// ═══════════════════════════════════════════════════════════════════════════════

function fallbackStore(over: Record<string, any[]> = {}) {
  return {
    blocks: [] as any[],
    user_mutes: [] as any[],
    feature_flags: [] as any[],
    trips: [{ id: TRIP, owner_id: USER, destination_city: "Lisbon", start_date: "2099-01-01", end_date: "2099-01-05", status: "active" }],
    trip_members: [{ trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" }],
    rent_buddy_bookings: [] as any[],
    ...over,
  };
}

describe("CT-02 D — the fallback feed says WHICH source it could not read", () => {
  it("D1 an unreadable trip source is named in fallbackReason rather than shown as no trips", async () => {
    const sc = makeClient(fallbackStore(), { errors: { trips: ERR, trip_members: ERR } });
    const out = await buildFallbackFeed(sc as any, USER, null, "feed_builder_threw");
    assert.match(out.fallbackReason, /trip_sources_unavailable/,
      "a feed with no active_trip section and no reason is a degradation dressed as an absence");
    assert.equal(out.safeItems.some((i) => i.category === "active_trip"), false);
  });

  it("D1 a PARTIAL reading is unread too — one of the two trip halves failing is still a gap", async () => {
    // Only `trips` errors, so the owned half fails and the member half does
    // not. The `ownedErr && memberErr` early return does NOT fire, which is why
    // this case exists: it is the only one that reaches
    // `unread: Boolean(ownedErr || memberErr)`.
    const sc = makeClient(fallbackStore(), { errors: { trips: ERR } });
    const out = await buildFallbackFeed(sc as any, USER, null, "feed_builder_threw");
    assert.match(out.fallbackReason, /trip_sources_unavailable/,
      "a trip list missing its owned half, with nothing saying so, is the defect one level in");
  });

  it("D1 control: readable trip sources carry the trip and leave the reason alone", async () => {
    const sc = makeClient(fallbackStore());
    const out = await buildFallbackFeed(sc as any, USER, null, "feed_builder_threw");
    assert.equal(out.fallbackReason, "feed_builder_threw", "no suffix on a complete reading");
    assert.ok(out.safeItems.some((i) => i.category === "active_trip"), JSON.stringify(out.safeItems.map((i) => i.category)));
  });

  it("D1 the block-list refusal still wins, and still says which list it was", async () => {
    const sc = makeClient(fallbackStore(), { errors: { blocks: ERR } });
    const out = await buildFallbackFeed(sc as any, USER, null, "feed_builder_threw");
    assert.match(out.fallbackReason, /block_list_unavailable/);
    assert.deepEqual(out.safeItems, [], "no user content may be served without the hidden set");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. The profile — a two-minute cache is a two-minute lie
// ═══════════════════════════════════════════════════════════════════════════════

function profileStore(over: Record<string, any[]> = {}) {
  return {
    trips: [{ id: TRIP, owner_id: USER, start_date: "2099-01-01", end_date: "2099-01-05", status: "upcoming" }],
    trip_members: [{ trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" }],
    profiles: [{ id: USER, spoken_languages: null, default_language: null, budget_style: null, travel_styles: null, travel_group_style: null, travel_pace: null }],
    trust_profiles: [] as any[],
    user_preference_profiles: [] as any[],
    user_location_state: [] as any[],
    location_preferences: [] as any[],
    blocks: [] as any[],
    user_mutes: [] as any[],
    safe_return_sessions: [] as any[],
    rent_buddy_bookings: [] as any[],
    compass_user_preferences: [] as any[],
    ...over,
  };
}

describe("CT-02 E — a profile built over an unread trip state is labelled and not cached", () => {
  it("E1 an unreadable trip_members is reported, and `hasFutureTripScheduled: false` is not cached as fact", async () => {
    clearCompassProfileCache();
    const broken = makeClient(profileStore(), { errors: { trip_members: ERR } });
    const first = await getCompassProfile(broken as any, USER);
    assert.equal(first.tripStateUnread, true, "`false` on the three trip booleans must be distinguishable from 'not read'");

    // The cache is the half that makes this durable: one transient failure used
    // to freeze the answer for two minutes and serve it to every Compass
    // surface that asked, long after the database recovered.
    const healthy = makeClient(profileStore());
    const second = await getCompassProfile(healthy as any, USER);
    assert.equal(second.tripStateUnread, false, "the degraded profile was served from cache after the read recovered");
    assert.equal(second.hasFutureTripScheduled, true);
  });

  it("E1 control: a complete profile IS cached — the fix must not disable caching", async () => {
    clearCompassProfileCache();
    const sc = makeClient(profileStore());
    const first = await getCompassProfile(sc as any, USER);
    assert.equal(first.tripStateUnread, false);
    assert.equal(first.hasFutureTripScheduled, true);

    // A client that errors on everything: a cache MISS here would throw on the
    // fail-closed block read, so returning the profile proves it was cached.
    const poisoned = makeClient(profileStore(), { errors: { blocks: ERR, trip_members: ERR, trips: ERR } });
    const second = await getCompassProfile(poisoned as any, USER);
    assert.equal(second.hasFutureTripScheduled, true, "the healthy profile was not cached");
    clearCompassProfileCache();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. The duplication itself — one membership read, three role sets, named
// ═══════════════════════════════════════════════════════════════════════════════

describe("CT-02 F — the membership union is read in ONE module, and the divergences are named there", () => {
  it("the seam is three-valued: an unreadable trip_members is `unread`, not an empty id list", async () => {
    const sc = makeClient(socialStore(), { errors: { trip_members: ERR } });
    const read = await resolveMemberTripIds(sc as any, USER, { roles: ["owner", "member"] });
    assert.equal(read.status, "unread");
  });

  it("control: it returns the ids it read, and an empty list when there genuinely are none", async () => {
    const some = await resolveMemberTripIds(makeClient(socialStore()) as any, USER, { roles: ["owner", "member"] });
    assert.deepEqual(some.status === "ok" ? some.tripIds : null, [TRIP]);
    const none = await resolveMemberTripIds(makeClient(socialStore({ trip_members: [] })) as any, USER, { roles: ["owner", "member"] });
    assert.deepEqual(none.status === "ok" ? none.tripIds : null, []);
  });

  it("`acceptedOnly` narrows only when asked — nothing narrows an authorization set on a caller's behalf", async () => {
    const store = socialStore({
      trip_members: [{ trip_id: TRIP, user_id: USER, role: "member", status: "invited" }],
    });
    const wide = await resolveMemberTripIds(makeClient(store) as any, USER, { roles: ["owner", "member"] });
    assert.deepEqual(wide.status === "ok" ? wide.tripIds : null, [TRIP], "the default must be the wider answer resolveUserTrips has always given");
    const narrow = await resolveMemberTripIds(makeClient(store) as any, USER, { roles: ["owner", "member"], acceptedOnly: true });
    assert.deepEqual(narrow.status === "ok" ? narrow.tripIds : null, []);
  });

  it("the three modules that each had their own copy now consume the seam", () => {
    for (const file of [
      "compass/CompassSocialEngine.ts",
      "compass/CompassProfileService.ts",
    ]) {
      const src = SRC(file);
      assert.match(src, /resolveMemberTripIds/, `${file} must take the membership union from CompassCurrentTrip`);
      assert.doesNotMatch(
        src, /\.from\("trip_members"\)\s*\n?\s*\.select\("trip_id/,
        `${file} still re-derives the user's trip ids from trip_members itself`,
      );
    }
  });

  it("the role lists are CONSTANTS in the seam, not inlined literals — the divergence is preserved, not resolved", () => {
    const seam = SRC("compass/CompassCurrentTrip.ts");
    assert.match(seam, /SELECTION_TRIP_ROLES\s*=\s*\["owner", "member"\]/);
    assert.match(seam, /SOCIAL_CONTEXT_TRIP_ROLES\s*=\s*\["owner", "co_host", "member", "viewer"\]/);
    assert.match(seam, /owner decision|product decision/i,
      "an unwritten product decision must be named where the constants are, as the status sets are");
  });

  it("CompassTripContext's reason for staying raw is the one that is TRUE at this tree", () => {
    const src = SRC("compass/CompassTripContext.ts");
    // The retired sentence may survive as a QUOTATION of itself (the comment
    // records what it used to say); what must not survive is it being the
    // module's operative reason. So: the live reason must be stated, and the
    // retired one must be marked retired where it appears.
    assert.match(src, /both of which are now FALSE/,
      "a reason that expired must be recorded as expired, not silently replaced");
    assert.match(src, /starts_at|startsAt/, "the live reason is the columns the projection does not carry");
  });
});
