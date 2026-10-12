/**
 * census-trips §95 — the owner's plan-visibility ruling, OD-1012-PRIV-5 (2026-10-12, verbatim):
 *   "Organizers may narrow a plan's visibility, but organizer status alone grants no access to someone else's
 *    private plan. Private access is limited to its author and explicitly selected people. Time slots inherit
 *    plan privacy. Never widen visibility automatically."
 *
 * WHAT EACH PART PINS
 *   P. the pure rule: the scope ORDER (narrowing vs widening, the incomparable pair, unknown = most private),
 *      who may move a scope, who a selected_participants plan admits, and that a plan its scope keeps from the
 *      viewer is DROPPED — not served as a "Private plan" slot.
 *   L. the loader: planItemAccessFor reads the selection (3727), fails closed and named, and a selection is
 *      valid only while the viewer is accepted crew.
 *   W. the write doors: selected_participants is stored WITH its selection (author only, crew only), refused
 *      without it, and a failed selection write leaves the plan its author's alone.
 *   O. the organizer: narrows, never widens, never names people, and gets nothing of a plan it narrowed out of
 *      its own reach.
 *   R. a reader: GET /trips/:id/plan for the author, a selected person, an unselected crew member, the organizer.
 *
 * The SQL half (table, writer, triggers, RLS for client roles, the client never-widen guard) is rehearsed on
 * PGlite and executed by db/tripPlanItemAudienceRls.db.test.ts on CI's local database.
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripPlanVisibilityRuling.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";
import {
  TRIP_PLAN_PRIVACY_SCOPES, PRIVACY_SCOPE_BREADTH, isNarrowingOrSameScope, planScopeChangeRefusal, privacyScopeRefusal,
  type TripPlanPrivacyScope,
} from "../domain/trips/policies/tripPlanPrivacy.js";
import {
  ownerOnlyAccess, planScopeAdmitsViewer, planItemVisibility, withholdPrivatePlanItems, canSeePlanItemLocation, type PlanItemAccess,
} from "../domain/trips/policies/privateAnchorAccess.js";
import { checkAudience } from "../server/trips/planItemAudience.js";
import { planItemAccessFor } from "../server/trips/privateAnchorShares.js";

const ORG  = "aaaaaaaa-0000-0000-0000-0000000000a1"; // the trip's owner: the organizer
const ANA  = "aaaaaaaa-0000-0000-0000-0000000000a2"; // the plan's author
const BEN  = "aaaaaaaa-0000-0000-0000-0000000000a3"; // selected
const CLEO = "aaaaaaaa-0000-0000-0000-0000000000a4"; // crew, not selected
const OUT  = "aaaaaaaa-0000-0000-0000-0000000000a5"; // not on the trip
const TRIP = "33333333-0000-0000-0000-000000000031";
const ITEM = "66666666-0000-0000-0000-000000000064";
const SECRET = "Ana's surprise party";

// ── P. the pure rule ─────────────────────────────────────────────────────────

describe("P. OD-1012-PRIV-5, the pure rule", () => {
  it("P1. the order: private < selected_participants < crew < {friends_nearby, trip} < public, every pair", () => {
    const expected: Record<string, TripPlanPrivacyScope[]> = {
      private: ["private"],
      selected_participants: ["private", "selected_participants"],
      crew: ["private", "selected_participants", "crew"],
      friends_nearby: ["private", "selected_participants", "crew", "friends_nearby"],
      trip: ["private", "selected_participants", "crew", "trip"],
      public: ["private", "selected_participants", "crew", "friends_nearby", "trip", "public"],
    };
    for (const from of TRIP_PLAN_PRIVACY_SCOPES) {
      for (const to of TRIP_PLAN_PRIVACY_SCOPES) {
        assert.equal(isNarrowingOrSameScope(from, to), expected[from]!.includes(to), `${from} -> ${to}`);
      }
    }
    assert.equal(PRIVACY_SCOPE_BREADTH.friends_nearby, PRIVACY_SCOPE_BREADTH.trip, "one rank, and NOT comparable");
  });

  it("P2. an unknown or unread current scope is the most private: nothing is narrower, only itself", () => {
    for (const from of [null, undefined, "", "members", "PRIVATE", 3]) {
      for (const to of TRIP_PLAN_PRIVACY_SCOPES) assert.equal(isNarrowingOrSameScope(from, to), false, `${String(from)} -> ${to}`);
    }
  });

  it("P3. the author may move her plan's scope anywhere; anyone else only narrows", () => {
    assert.equal(planScopeChangeRefusal(ANA, ANA, "private", "public"), null, "the author widens explicitly");
    assert.equal(planScopeChangeRefusal(ORG, ANA, "crew", "private"), null, "the organizer narrows");
    assert.equal(planScopeChangeRefusal(ORG, ANA, "crew", "crew"), null, "the same scope is no change");
    assert.equal(planScopeChangeRefusal(ORG, ANA, "crew", "public")?.reason, "TRIP_PLAN_SCOPE_WIDENING_REFUSED");
    assert.equal(planScopeChangeRefusal(ORG, ANA, "private", "selected_participants")?.reason, "TRIP_PLAN_SCOPE_WIDENING_REFUSED");
    assert.equal(planScopeChangeRefusal(ORG, ANA, "friends_nearby", "trip")?.reason, "TRIP_PLAN_SCOPE_WIDENING_REFUSED");
    assert.equal(planScopeChangeRefusal(ORG, null, "crew", "private"), null, "an unknown author is not the actor, and narrowing is still allowed");
    assert.equal(planScopeChangeRefusal(ORG, null, "crew", "public")?.reason, "TRIP_PLAN_SCOPE_WIDENING_REFUSED");
  });

  const sel = (viewerId: string, ids: string[] = [ITEM]): PlanItemAccess => ({ ...ownerOnlyAccess(viewerId), selected: new Set(ids) });
  const row = (o: Record<string, unknown> = {}) => ({ id: ITEM, creator_id: ANA, title: SECRET, location_is_private: false, privacy_scope: "selected_participants", removed_at: null, starts_at: "2026-10-20T19:00:00Z", ...o });

  it("P4. selected_participants admits its author and the people she selected — nobody else, the organizer included", () => {
    assert.equal(planScopeAdmitsViewer(ownerOnlyAccess(ANA), row()), true, "author (CONTROL)");
    assert.equal(planScopeAdmitsViewer(sel(BEN), row()), true, "Ben, selected");
    assert.equal(planScopeAdmitsViewer(ownerOnlyAccess(CLEO), row()), false, "Cleo, crew");
    assert.equal(planScopeAdmitsViewer(ownerOnlyAccess(ORG), row()), false, "the organizer");
    assert.equal(planScopeAdmitsViewer(sel(BEN, ["another-item"]), row()), false, "a selection for ANOTHER plan");
    assert.equal(planScopeAdmitsViewer(BEN, row()), false, "a bare viewer id carries no selection");
  });

  it("P5. a selection admits only to a selected_participants plan that is live: never to `private`, never to unknown", () => {
    assert.equal(planScopeAdmitsViewer(sel(BEN), row({ privacy_scope: "private" })), false);
    assert.equal(planScopeAdmitsViewer(sel(BEN), row({ privacy_scope: null })), false);
    assert.equal(planScopeAdmitsViewer(sel(BEN), row({ privacy_scope: "SELECTED_PARTICIPANTS" })), false);
    assert.equal(planScopeAdmitsViewer(sel(BEN), row({ removed_at: "2026-10-01T00:00:00Z" })), false);
  });

  it("P6. time slots inherit plan privacy: a plan the scope keeps from the viewer is DROPPED, not served as a slot", () => {
    const rows = [row(), row({ id: "crew-1", privacy_scope: "crew", title: "Dinner", starts_at: "2026-10-21T19:00:00Z" }), row({ id: "anch-1", privacy_scope: "crew", location_is_private: true, title: "Hotel", lat: 1, starts_at: "2026-10-22T19:00:00Z" })];
    assert.deepEqual(withholdPrivatePlanItems(rows, ownerOnlyAccess(CLEO)).map((r) => r.id), ["crew-1", "anch-1"]);
    assert.doesNotMatch(JSON.stringify(withholdPrivatePlanItems(rows, ownerOnlyAccess(CLEO))), /surprise|2026-10-20T19/);
    assert.equal(planItemVisibility(ownerOnlyAccess(CLEO), rows[0]!), "hidden");
    assert.equal(planItemVisibility(ownerOnlyAccess(CLEO), rows[2]!), "slot", "OD-TRIP-3: a crew plan at a private PLACE keeps its slot");
    assert.equal(planItemVisibility(sel(BEN), rows[0]!), "full");
    assert.equal(planItemVisibility(sel(BEN), row({ location_is_private: true })), "slot", "selected for the PLAN is not a grant of the private PLACE");
    assert.equal(canSeePlanItemLocation({ ...sel(BEN), status: "unread" }, rows[0]!), true, "an unread GRANT read does not cost a selected person a public place");
    assert.equal(withholdPrivatePlanItems([row({ privacy_scope: undefined })], ownerOnlyAccess(CLEO)).length, 0, "unread scope: dropped (fail closed)");
  });

  it("P7. the selection list: never empty, at most 50, never the author, crew only, uncheckable is a 503", () => {
    const crew = new Set([ORG, ANA, BEN, CLEO]);
    assert.deepEqual(checkAudience(ANA, [BEN, BEN], crew), { ok: true, memberIds: [BEN] });
    assert.equal((checkAudience(ANA, [], crew) as any).reason, "TRIP_PLAN_AUDIENCE_REQUIRED");
    assert.equal((checkAudience(ANA, [ANA], crew) as any).reason, "TRIP_PLAN_AUDIENCE_NOT_CREW");
    assert.equal((checkAudience(ANA, [OUT], crew) as any).reason, "TRIP_PLAN_AUDIENCE_NOT_CREW");
    assert.equal((checkAudience(ANA, [BEN], null) as any).status, 503);
    const many = Array.from({ length: 51 }, (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`);
    assert.equal((checkAudience(ANA, many, new Set(many)) as any).reason, "TRIP_PLAN_AUDIENCE_TOO_LARGE");
    assert.deepEqual(checkAudience(ANA, [ORG], crew), { ok: true, memberIds: [ORG] }, "the organizer can be SELECTED — by the author");
  });

  it("P8. without the store, selected_participants keeps §90's refusal; with it, the refusal lifts", () => {
    assert.equal(privacyScopeRefusal("selected_participants")?.reason, "TRIP_PRIVACY_SCOPE_NOT_ENFORCED", "the default is absent");
    assert.equal(privacyScopeRefusal("selected_participants", "absent")?.reason, "TRIP_PRIVACY_SCOPE_NOT_ENFORCED");
    assert.equal(privacyScopeRefusal("selected_participants", "unread")?.reason, "TRIP_PRIVACY_SCOPE_NOT_ENFORCED");
    assert.equal(privacyScopeRefusal("selected_participants", "available"), null);
    assert.equal(privacyScopeRefusal("private", "absent"), null);
  });
});

// ── a fake database that models 3727's writer and triggers ───────────────────

interface State {
  trips: any[]; trip_members: any[]; trip_plan_items: any[]; trip_activity_log: any[]; feature_flags: any[];
  /** absent = 3727 not applied. */
  trip_plan_item_audience?: any[];
  failAudienceRead?: boolean;
  failRpc?: boolean;
  rpcCalls: any[];
}

function baseState(): State {
  return {
    trips: [{ id: TRIP, owner_id: ORG, plan_edit_permission: "all_members", start_date: null, end_date: null }],
    trip_members: [
      { trip_id: TRIP, user_id: ORG, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: CLEO, role: "member", status: "accepted" },
    ],
    trip_plan_items: [],
    trip_activity_log: [],
    feature_flags: [],
    trip_plan_item_audience: [],
    rpcCalls: [],
  };
}

const accepted = (s: State, uid: string) => s.trip_members.some((m) => m.user_id === uid && ["owner", "co_host", "member", "viewer"].includes(m.role) && (m.status == null || m.status === "accepted"));

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const rows = (): any[] => (state as any)[table] ?? [];
    async function resolve(one: boolean) {
      if (table === "trip_plan_item_audience") {
        if (!state.trip_plan_item_audience) return { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.trip_plan_item_audience' in the schema cache" } };
        if (state.failAudienceRead) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      const m = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "select") return { data: one ? (m[0] ?? null) : m, error: null };
      if (op === "insert") {
        const row = { id: ITEM, removed_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...payload };
        rows().push(row);
        return { data: one ? row : [row], error: null };
      }
      if (op === "update") {
        let last: any = null;
        for (const r of m) {
          // 3727's trip_plan_items_clear_audience: a scope that CHANGES clears the selection.
          if (table === "trip_plan_items" && "privacy_scope" in payload && payload.privacy_scope !== r.privacy_scope && state.trip_plan_item_audience) {
            state.trip_plan_item_audience = state.trip_plan_item_audience.filter((a) => a.plan_item_id !== r.id);
          }
          Object.assign(r, payload); last = r;
        }
        return { data: one ? last : null, error: null };
      }
      (state as any)[table] = rows().filter((r) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    const b: any = {
      select() { return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order() { return b; }, limit() { return b; },
      // trust_restrictions' filters: this fake carries no restriction rows, so they narrow nothing.
      or() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, neq() { return b; }, not() { return b; },
      maybeSingle() { return resolve(true); }, single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    return b;
  }
  // 3727's trip_plan_item_audience_replace, the same refusals in the same order.
  async function rpc(fn: string, args: any) {
    state.rpcCalls.push({ fn, args });
    if (fn !== "trip_plan_item_audience_replace") return { data: null, error: { message: `no rpc ${fn}` } };
    if (state.failRpc) return { data: null, error: { message: "connection reset" } };
    const item = state.trip_plan_items.find((i) => i.id === args.p_item_id);
    if (!item || item.removed_at) return { data: null, error: { message: "TRIP_PLAN_AUDIENCE_ITEM_NOT_FOUND" } };
    if (item.creator_id !== args.p_actor_id) return { data: null, error: { message: "TRIP_PLAN_AUDIENCE_NOT_AUTHOR" } };
    if (item.privacy_scope !== "selected_participants") return { data: null, error: { message: "TRIP_PLAN_AUDIENCE_SCOPE_MISMATCH" } };
    if ((args.p_member_ids as string[]).some((m) => m === item.creator_id || !accepted(state, m))) return { data: null, error: { message: "TRIP_PLAN_AUDIENCE_NOT_CREW" } };
    state.trip_plan_item_audience = (state.trip_plan_item_audience ?? []).filter((a) => a.plan_item_id !== item.id)
      .concat((args.p_member_ids as string[]).map((m) => ({ plan_item_id: item.id, trip_id: item.trip_id, member_id: m, added_by: args.p_actor_id })));
    return { data: args.p_member_ids.length, error: null };
  }
  return {
    from, rpc,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

async function withServer<T>(state: State, fn: (call: (who: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<T>): Promise<T> {
  _setTestClient(makeFakeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", tripsRouter);
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  srv.unref();
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${who}`, connection: "close" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try { return await fn(call); } finally { await new Promise<void>((res) => { srv.closeAllConnections(); srv.close(() => res()); }); }
}

const plan = (o: Record<string, unknown> = {}) => ({
  id: ITEM, trip_id: TRIP, creator_id: ANA, title: SECRET, category: "activity", status: "tentative", visibility: "members",
  privacy_scope: "crew", location_is_private: false, removed_at: null, starts_at: "2026-10-20T19:00:00Z", sort_order: 0, ...o,
});
const audienceOf = (s: State) => (s.trip_plan_item_audience ?? []).map((a) => a.member_id).sort();

// ── L. the loader ────────────────────────────────────────────────────────────

describe("L. planItemAccessFor reads the selection", () => {
  it("L1. the viewer's selections on this trip, while they are accepted crew", async () => {
    const s = baseState();
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    const a = await planItemAccessFor(makeFakeClient(s) as any, TRIP, BEN);
    assert.deepEqual([...(a.selected ?? [])], [ITEM]);
    assert.equal(a.selectionUnread, undefined);
  });
  it("L2. a selection of someone who LEFT the trip admits nothing", async () => {
    const s = baseState();
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    s.trip_members.find((m) => m.user_id === BEN)!.status = "left";
    const a = await planItemAccessFor(makeFakeClient(s) as any, TRIP, BEN);
    assert.equal(a.selected?.has(ITEM) ?? false, false);
  });
  it("L3. a selection read that FAILED admits through no selection, says so, and leaves the grants' status alone", async () => {
    const s = baseState();
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    s.failAudienceRead = true;
    const a = await planItemAccessFor(makeFakeClient(s) as any, TRIP, BEN);
    assert.equal(a.selected?.size ?? 0, 0);
    assert.match(String(a.selectionUnread), /could not be read/);
    assert.equal(planScopeAdmitsViewer(a, plan({ privacy_scope: "selected_participants" })), false);
  });
  it("L4. 3727 not applied: no selection exists, exactly", async () => {
    const s = baseState(); delete s.trip_plan_item_audience;
    const a = await planItemAccessFor(makeFakeClient(s) as any, TRIP, BEN);
    assert.equal(a.selected?.size ?? 0, 0);
    assert.equal(a.selectionUnread, undefined);
  });
});

// ── W. the write doors ───────────────────────────────────────────────────────

const CREATE = { title: SECRET, category: "activity" };

describe("W. selected_participants is stored WITH its selection", () => {
  it("W1. create: the plan, its scope and the author's selection; the answer names the selection", async () => {
    const s = baseState();
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "selected_participants", selectedMemberIds: [BEN] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(s.trip_plan_items[0].privacy_scope, "selected_participants");
    assert.equal(s.trip_plan_items[0].visibility, "members");
    assert.deepEqual(audienceOf(s), [BEN]);
    assert.deepEqual(r.body.selectedMemberIds, [BEN]);
  });
  it("W2. create naming nobody is refused, nothing written", async () => {
    const s = baseState();
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "selected_participants" }));
    assert.equal(r.status, 422);
    assert.equal(r.body.reason, "TRIP_PLAN_AUDIENCE_REQUIRED");
    assert.equal(s.trip_plan_items.length, 0);
  });
  it("W3. create naming someone outside the crew is refused, nothing written", async () => {
    const s = baseState();
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "selected_participants", selectedMemberIds: [BEN, OUT] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.reason, "TRIP_PLAN_AUDIENCE_NOT_CREW");
    assert.equal(s.trip_plan_items.length, 0);
    assert.equal(s.rpcCalls.length, 0);
  });
  it("W4. people named for a plan that is not selected_participants are refused (a list nobody would honour)", async () => {
    const s = baseState();
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "crew", selectedMemberIds: [BEN] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.reason, "TRIP_PLAN_AUDIENCE_SCOPE_MISMATCH");
    assert.equal(s.trip_plan_items.length, 0);
  });
  it("W5. the selection write fails: 503, and the plan is its author's alone (narrower than asked, never wider)", async () => {
    const s = baseState(); s.failRpc = true;
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "selected_participants", selectedMemberIds: [BEN] }));
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PLAN_AUDIENCE_NOT_SAVED");
    assert.equal(s.trip_plan_items[0].privacy_scope, "selected_participants");
    assert.deepEqual(audienceOf(s), []);
    assert.equal(planScopeAdmitsViewer(await planItemAccessFor(makeFakeClient(s) as any, TRIP, BEN), s.trip_plan_items[0]), false);
  });
  it("W6. without 3727 the scope is still refused (§90's 422), nothing written", async () => {
    const s = baseState(); delete s.trip_plan_item_audience;
    const r = await withServer(s, (call) => call(ANA, "POST", `/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "selected_participants", selectedMemberIds: [BEN] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.reason, "TRIP_PRIVACY_SCOPE_NOT_ENFORCED");
    assert.equal(s.trip_plan_items.length, 0);
  });
  it("W7. PATCH by the author: crew -> selected_participants with a selection; the scope change cleared nothing it should keep", async () => {
    const s = baseState(); s.trip_plan_items.push(plan());
    const r = await withServer(s, (call) => call(ANA, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "selected_participants", selectedMemberIds: [CLEO, BEN] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.trip_plan_items[0].privacy_scope, "selected_participants");
    assert.deepEqual(audienceOf(s), [BEN, CLEO].sort());
  });
  it("W8. PATCH by the author: entering selected_participants without naming anyone is refused, row unchanged", async () => {
    const s = baseState(); s.trip_plan_items.push(plan());
    const r = await withServer(s, (call) => call(ANA, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "selected_participants" }));
    assert.equal(r.status, 422);
    assert.equal(s.trip_plan_items[0].privacy_scope, "crew");
  });
  it("W9. PATCH by the author re-choosing only the people replaces the selection (no union) and writes no plan column", async () => {
    const s = baseState(); s.trip_plan_items.push(plan({ privacy_scope: "selected_participants" }));
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    const r = await withServer(s, (call) => call(ANA, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { selectedMemberIds: [CLEO] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(audienceOf(s), [CLEO]);
    assert.equal(s.trip_activity_log.length, 0, "no plan write, so no plan_item_updated");
  });
  it("W10. the author moving away from selected_participants takes the selection with it (no revival later)", async () => {
    const s = baseState(); s.trip_plan_items.push(plan({ privacy_scope: "selected_participants" }));
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    const r = await withServer(s, (call) => call(ANA, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "private" }));
    assert.equal(r.status, 200);
    assert.deepEqual(audienceOf(s), []);
  });
});

// ── O. the organizer ─────────────────────────────────────────────────────────

describe("O. the organizer narrows, never widens, never chooses people, and learns nothing by narrowing", () => {
  it("O1. narrowing Ana's crew plan to private: allowed, and the answer is its id and new scope only", async () => {
    const s = baseState(); s.trip_plan_items.push(plan());
    const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "private" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.trip_plan_items[0].privacy_scope, "private");
    assert.deepEqual(r.body, { id: ITEM, tripId: TRIP, privacyScope: "private", hidden: true });
  });
  it("O2. widening Ana's crew plan to public, trip or friends_nearby: 403, unchanged", async () => {
    for (const to of ["public", "trip", "friends_nearby"]) {
      const s = baseState(); s.trip_plan_items.push(plan());
      const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: to }));
      assert.equal(r.status, 403, `${to}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.reason, "TRIP_PLAN_SCOPE_WIDENING_REFUSED");
      assert.equal(s.trip_plan_items[0].privacy_scope, "crew");
    }
  });
  it("O3. widening Ana's PRIVATE plan to crew (the §90 door): 403, unchanged, nothing of it in the answer", async () => {
    const s = baseState(); s.trip_plan_items.push(plan({ privacy_scope: "private" }));
    const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "crew" }));
    assert.equal(r.status, 403);
    assert.doesNotMatch(JSON.stringify(r.body), /surprise/);
    assert.equal(s.trip_plan_items[0].privacy_scope, "private");
  });
  it("O4. narrowing a selected_participants plan he is not in to private: allowed, and the answer is nothing of it", async () => {
    const s = baseState(); s.trip_plan_items.push(plan({ privacy_scope: "selected_participants" }));
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "private" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.doesNotMatch(JSON.stringify(r.body), /surprise|2026-10-20/);
    assert.equal(s.trip_plan_items[0].privacy_scope, "private");
    assert.deepEqual(audienceOf(s), [], "Ben's access ends with the narrowing");
  });
  it("O5. the organizer cannot choose who sees Ana's plan", async () => {
    const s = baseState(); s.trip_plan_items.push(plan({ privacy_scope: "selected_participants" }));
    const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { selectedMemberIds: [ORG] }));
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "TRIP_PLAN_AUDIENCE_AUTHOR_ONLY");
    assert.deepEqual(audienceOf(s), []);
    assert.equal(s.rpcCalls.length, 0);
  });
  it("O6. narrowing crew -> selected_participants by the organizer starts with NOBODY selected: Ana's alone", async () => {
    const s = baseState(); s.trip_plan_items.push(plan());
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: CLEO, added_by: ANA }]; // a stale row from before
    const r = await withServer(s, (call) => call(ORG, "PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "selected_participants" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(audienceOf(s), [], "nothing revives");
    assert.equal(r.body.hidden, true);
  });
});

// ── R. a reader ──────────────────────────────────────────────────────────────

describe("R. GET /trips/:id/plan — author, selected, unselected crew, organizer", () => {
  const seed = () => {
    const s = baseState();
    s.trip_plan_items.push(plan({ privacy_scope: "selected_participants" }), plan({ id: "77777777-0000-0000-0000-000000000077", title: "Group dinner", privacy_scope: "crew", sort_order: 1, starts_at: "2026-10-21T19:00:00Z" }));
    s.trip_plan_item_audience = [{ plan_item_id: ITEM, trip_id: TRIP, member_id: BEN, added_by: ANA }];
    return s;
  };
  const titles = (r: { body: any }) => (r.body.items as any[]).map((i) => i.title).sort();
  it("R1. the author and the person she selected see the plan", async () => {
    for (const who of [ANA, BEN]) {
      const r = await withServer(seed(), (call) => call(who, "GET", `/trips/${TRIP}/plan`));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(titles(r), ["Group dinner", SECRET].sort(), who);
    }
  });
  it("R2. unselected crew and the organizer get NOTHING of it — not even a 'Private plan' slot at its time", async () => {
    for (const who of [CLEO, ORG]) {
      const r = await withServer(seed(), (call) => call(who, "GET", `/trips/${TRIP}/plan`));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(titles(r), ["Group dinner"], who);
      assert.doesNotMatch(JSON.stringify(r.body), /surprise|Private plan|2026-10-20T19/, who);
    }
  });
});
