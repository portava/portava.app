/**
 * census-trips §81.3 — a private-anchor grant has effect only while it is
 * still true, and is CLEARED where it stops being true (verifier finding 3,
 * 2026-10-05). Also the client door (migration 3972) by its text.
 *
 * WHAT WAS WRONG at `85bb3c5339`:
 *   - REVOKE went through the grant gate, so a grant on an item later made
 *     public or removed, or made by a creator who had since left the trip,
 *     could not be taken back (403/400) — while it stayed in the table;
 *   - a grant was honoured with no check that its owner or its grantee was
 *     still an accepted member: a removed member's own route plan on the trip
 *     showed the stay they had been granted, and a removed creator's grants
 *     kept showing their place to the crew;
 *   - nothing ever deleted a grant row: not on member removal, not when the
 *     item went public (so it revived when the item went private again), not
 *     when the item was removed;
 *   - the owner's share list answered an unreadable sharing setting as "off".
 *
 * WHAT IS ASSERTED, through the real routes over the certification harness:
 *   R. revoke needs only "you created it, and it is on this trip";
 *   V. read-time validity: owner and grantee must be accepted members, the
 *      grant's owner must be the item's creator, the setting is three-valued;
 *   C. clearing at every API site that ends a grant's truth — member removal
 *      (legacy and kernel), item made public (legacy and kernel; cleared FIRST,
 *      and a failed clearing refuses the change), item removed (PATCH /remove
 *      and DELETE, legacy and kernel) — and a change that keeps the item
 *      private clears nothing;
 *   E. an organizer's edit of another member's private item keeps off the
 *      fields that locate or name it, and gets the slot back;
 *   M. migration 3972 by its text: the policy's three clauses, qualified
 *      columns, no read of trip_plan_items inside the helper, both triggers
 *      and their events, the rollback that names the hole it reopens.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/tripPrivateAnchorLifecycle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripsRouter from "../routes/trips.js";
import routePlanRouter from "../routes/routePlan.js";
import anchorSharesRouter from "../routes/tripAnchorShares.js";
import { planItemAccessFor, visiblePrivateAnchorLayer } from "../server/trips/privateAnchorShares.js";
import { makeFakeClient, startRouter, call, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001";
const ANA = "22222222-0000-4000-8000-000000000002";
const BEN = "33333333-0000-4000-8000-000000000003";
const CLEO = "44444444-0000-4000-8000-000000000004";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_TRIP = "aaaaaaaa-0000-4000-8000-00000000000f";
const HOTEL = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLEO_FLAT = "bbbbbbbb-0000-4000-8000-0000000000cf"; // Cleo's own private place, granted to Ben
const SECRET = /Casa Segreta|Rua do Segredo|38\.70417/;

type Rows = Array<Record<string, unknown>>;
type Seed = Record<string, Rows>;

function seed(o: { sharing?: boolean; kernel?: boolean } = {}): Seed {
  const flags: Rows = [];
  if (o.sharing !== false) flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true });
  if (o.kernel) flags.push({ flag: "trip_kernel_enabled", enabled: true });
  return {
    feature_flags: flags,
    trips: [{ id: TRIP, owner_id: ORGANIZER, version: 3, title: "Lisbon", status: "active" }],
    trip_members: [ORGANIZER, ANA, BEN, CLEO].map((u) => ({ trip_id: TRIP, user_id: u, role: u === ORGANIZER ? "owner" : "member", status: "accepted" })),
    trip_plan_items: [
      { id: HOTEL, trip_id: TRIP, creator_id: ANA, title: "Casa Segreta", category: "accommodation", status: "planned",
        lat: 38.70417, lng: -9.13853, location_is_private: true, location_name: "Rua do Segredo 7", notes: null,
        day_date: "2026-10-06", starts_at: "2026-10-06T20:00:00Z", ends_at: "2026-10-07T09:00:00Z", sort_order: 1, removed_at: null },
      { id: CLEO_FLAT, trip_id: TRIP, creator_id: CLEO, title: "Cleo flat", category: "accommodation", status: "planned",
        lat: 38.72, lng: -9.15, location_is_private: true, location_name: "Flat", notes: null, day_date: "2026-10-06",
        starts_at: null, ends_at: null, sort_order: 2, removed_at: null },
    ],
    trip_private_anchor_shares: [
      { plan_item_id: HOTEL, trip_id: TRIP, owner_id: ANA, member_id: BEN, created_at: "2026-10-05T00:00:00Z" },
      { plan_item_id: HOTEL, trip_id: TRIP, owner_id: ANA, member_id: CLEO, created_at: "2026-10-05T00:00:00Z" },
      { plan_item_id: CLEO_FLAT, trip_id: TRIP, owner_id: CLEO, member_id: BEN, created_at: "2026-10-05T00:00:00Z" },
    ],
    route_plans: [], route_stops: [], trip_activity_log: [], plan_editors: [],
  };
}

/** The kernel, as far as these routes need it: apply the command to the store and answer as 2420 does. */
function withKernel(c: FakeClient): FakeClient {
  const store = c._store;
  (c as any).rpc = async (name: string, args: any) => {
    if (name !== "trip_kernel_execute") return { data: null, error: { message: `rpc ${name} not modelled` } };
    const cmd = args.p_command;
    ((c as any).kernelCommands ??= []).push(cmd.type);
    let result: any = null;
    if (cmd.type === "REMOVE_PARTICIPANT") {
      store.trip_members = (store.trip_members ?? []).filter((m: any) => !(m.trip_id === cmd.trip_id && m.user_id === cmd.payload.user_id));
      result = { user_id: cmd.payload.user_id };
    } else if (cmd.type === "REMOVE_PLAN") {
      const row = (store.trip_plan_items ?? []).find((r: any) => r.id === cmd.payload.item_id);
      if (row) row.removed_at = cmd.payload.removed_at;
      result = row;
    } else if (cmd.type === "UPDATE_PLAN" || cmd.type === "MOVE_PLAN") {
      const row = (store.trip_plan_items ?? []).find((r: any) => r.id === cmd.payload.item_id);
      if (row) Object.assign(row, cmd.payload.patch);
      result = row ? { ...row } : null;
    } else {
      return { data: { ok: false, reason: "TRIP_KERNEL_UNAVAILABLE", detail: `fake kernel: ${cmd.type}` }, error: null };
    }
    return { data: { ok: true, duplicate: false, version: 4, event_id: "e-1", sequence: 1, result, contract_version: 2 }, error: null };
  };
  return c;
}

function use(s: Seed, opts: FakeDbOptions = {}, kernel = false): FakeClient {
  const c = makeFakeClient(s, opts);
  if (kernel) withKernel(c);
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}

/** On the kernel path, the command really went through the (fake) kernel — the test is not the legacy path twice. */
const sentToKernel = (c: FakeClient, kernel: boolean, type: string) => { if (kernel) assert.ok(((c as any).kernelCommands ?? []).includes(type), `${type} was not sent to the kernel`); };
const grants = (c: FakeClient) => ((c._store.trip_private_anchor_shares ?? []) as Rows).map((g) => `${g.plan_item_id === HOTEL ? "hotel" : "flat"}:${g.member_id === BEN ? "ben" : g.member_id === CLEO ? "cleo" : g.member_id}`).sort();
const planText = async (as: string) => {
  const r = await call(harness.base, "GET", `/trips/${TRIP}/plan`, as);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return JSON.stringify(r.body);
};

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(tripsRouter); all.use(routePlanRouter); all.use(anchorSharesRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

const revoke = (as: string, member = BEN, trip = TRIP, item = HOTEL) => call(harness.base, "DELETE", `/trips/${trip}/anchors/${item}/shares/${member}`, as);

describe("R. revoke needs only: you created the item, and it is on this trip", () => {
  it("R1. after the item was made PUBLIC, its creator can still take a grant back", async () => {
    const s = seed(); (s.trip_plan_items[0] as any).location_is_private = false;
    const c = use(s);
    const r = await revoke(ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo"]);
  });
  it("R2. after the item was REMOVED, its creator can still take a grant back", async () => {
    const s = seed(); (s.trip_plan_items[0] as any).removed_at = "2026-10-05T10:00:00Z";
    const c = use(s);
    assert.equal((await revoke(ANA)).status, 200);
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo"]);
  });
  it("R3. after the creator LEFT the trip, they can still take a grant back", async () => {
    const s = seed(); s.trip_members = s.trip_members.filter((m) => m.user_id !== ANA);
    const c = use(s);
    assert.equal((await revoke(ANA)).status, 200);
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo"]);
  });
  it("R4. with sharing OFF, and with the setting UNREADABLE, a revoke still lands", async () => {
    let c = use(seed({ sharing: false }));
    assert.equal((await revoke(ANA)).status, 200);
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo"]);
    c = use(seed(), { errors: { feature_flags: { message: "flags unavailable", code: "57P01" } } });
    const r = await revoke(ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sharing, "unread", "the answer names the unreadable setting rather than reading it as off");
    assert.equal(r.body.sharingEnabled, false);
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo"]);
  });
  it("R5. the organizer cannot revoke Ana's grant, and nothing is removed", async () => {
    const c = use(seed());
    assert.equal((await revoke(ORGANIZER)).status, 403);
    assert.deepEqual(grants(c), ["flat:ben", "hotel:cleo", "hotel:ben"].sort());
  });
  it("R6. an item named under another trip is not found, and nothing is removed", async () => {
    const c = use(seed());
    assert.equal((await revoke(ANA, BEN, OTHER_TRIP)).status, 404);
    assert.equal(grants(c).length, 3);
  });
});

describe("V. a grant counts only while it is still true", () => {
  it("V0. CONTROL: Ben, granted, sees Ana's stay in the plan; Cleo's grant to him shows her flat", async () => {
    use(seed());
    const t = await planText(BEN);
    assert.match(t, SECRET);
    assert.match(t, /Cleo flat/);
  });
  it("V1. the grant's OWNER left the trip (row left behind): the crew no longer sees her place", async () => {
    const s = seed(); s.trip_members = s.trip_members.filter((m) => m.user_id !== ANA);
    use(s);
    const t = await planText(BEN);
    assert.doesNotMatch(t, SECRET);
    assert.match(t, /Cleo flat/, "the other grant, whose owner is still on the trip, still holds");
  });
  it("V2. the GRANTEE was removed (row left behind): his own route plan on the trip shows no stay", async () => {
    const s = seed(); s.trip_members = s.trip_members.filter((m) => m.user_id !== BEN);
    s.route_plans = [{ id: "dddddddd-0000-4000-8000-00000000000d", trip_id: TRIP, owner_user_id: BEN, status: "active", updated_at: "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z" }];
    (s.trip_plan_items[1] as any).removed_at = "2026-10-05T00:00:00Z"; // only Ana's stay is in play
    use(s);
    const r = await call(harness.base, "GET", `/route-plans/for-trip/${TRIP}`, BEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.plan?.tripAccommodationLocation ?? null, null, JSON.stringify(r.body));
  });
  it("V2b. CONTROL for V2: while Ben is a member, the same route plan shows the granted stay", async () => {
    const s = seed();
    s.route_plans = [{ id: "dddddddd-0000-4000-8000-00000000000d", trip_id: TRIP, owner_user_id: BEN, status: "active", updated_at: "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z" }];
    (s.trip_plan_items[1] as any).removed_at = "2026-10-05T00:00:00Z";
    use(s);
    const r = await call(harness.base, "GET", `/route-plans/for-trip/${TRIP}`, BEN);
    assert.equal(r.body?.plan?.tripAccommodationLocation?.label, "Casa Segreta");
  });
  it("V3. a grantee whose membership is no longer ACCEPTED (status invited) holds nothing", async () => {
    const s = seed(); (s.trip_members.find((m) => m.user_id === BEN) as any).status = "invited";
    const c = use(s);
    const a = await planItemAccessFor(c as never, TRIP, BEN);
    assert.equal(a.status, "ok");
    assert.equal(a.grants.size, 0);
  });
  it("V4. a grant row whose owner is not the item's creator is ignored", async () => {
    const s = seed();
    s.trip_private_anchor_shares = [{ plan_item_id: HOTEL, trip_id: TRIP, owner_id: CLEO, member_id: BEN, created_at: "2026-10-05T00:00:00Z" }];
    use(s);
    assert.doesNotMatch(await planText(BEN), SECRET);
  });
  it("V5. an UNREADABLE sharing setting is `unread` — the loader says so, the anchor layer is unread, no grant is honoured", async () => {
    const c = use(seed(), { errors: { feature_flags: { message: "flags unavailable", code: "57P01" } } });
    const a = await planItemAccessFor(c as never, TRIP, BEN);
    assert.equal(a.status, "unread");
    assert.equal(a.grants.size, 0);
    const layer = await visiblePrivateAnchorLayer(c as never, TRIP, BEN, [{ id: HOTEL, kind: "private_anchor", lat: 38.7, lng: -9.1, label: null, meta: { ownerId: ANA } } as never]);
    assert.equal(layer.status, "unread");
  });
  it("V6. sharing OFF is `ok` with no grants — off is not unread, and not on", async () => {
    const c = use(seed({ sharing: false }));
    const a = await planItemAccessFor(c as never, TRIP, BEN);
    assert.equal(a.status, "ok");
    assert.equal(a.grants.size, 0);
  });
});

describe("C. grants are cleared where they stop being true", () => {
  for (const kernel of [false, true]) {
    const k = kernel ? "kernel" : "legacy";
    it(`C1-${k}. removing BEN from the trip clears every grant TO him, and only those`, async () => {
      const c = use(seed({ kernel }), {}, kernel);
      const r = await call(harness.base, "DELETE", `/trips/${TRIP}/members/${BEN}`, ORGANIZER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      sentToKernel(c, kernel, "REMOVE_PARTICIPANT");
      assert.deepEqual(grants(c), ["hotel:cleo"]);
    });
    it(`C2-${k}. removing ANA clears every grant BY her, and only those`, async () => {
      const c = use(seed({ kernel }), {}, kernel);
      const r = await call(harness.base, "DELETE", `/trips/${TRIP}/members/${ANA}`, ORGANIZER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      sentToKernel(c, kernel, "REMOVE_PARTICIPANT");
      assert.deepEqual(grants(c), ["flat:ben"]);
    });
    it(`C3-${k}. Ana making her stay PUBLIC clears its grants first — and a later re-privatising revives none`, async () => {
      const c = use(seed({ kernel }), {}, kernel);
      let r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ANA, { locationIsPrivate: false });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      sentToKernel(c, kernel, "UPDATE_PLAN");
      assert.deepEqual(grants(c), ["flat:ben"]);
      r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ANA, { locationIsPrivate: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.doesNotMatch(await planText(BEN), SECRET, "the old grant did not come back with the privacy");
    });
    it(`C4-${k}. PATCH /remove clears the removed item's grants, and only those`, async () => {
      const c = use(seed({ kernel }), {}, kernel);
      const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}/remove`, ANA);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      sentToKernel(c, kernel, "REMOVE_PLAN");
      assert.deepEqual(grants(c), ["flat:ben"]);
    });
    it(`C5-${k}. DELETE of the item clears its grants, and only those`, async () => {
      const c = use(seed({ kernel }), {}, kernel);
      const r = await call(harness.base, "DELETE", `/trips/${TRIP}/plan/items/${HOTEL}`, ANA);
      assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body));
      sentToKernel(c, kernel, "REMOVE_PLAN");
      assert.deepEqual(grants(c), ["flat:ben"]);
    });
  }
  it("C6. CONTROL: an edit that keeps the item private (its time) clears nothing", async () => {
    const c = use(seed());
    const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ANA, { startsAt: "2026-10-06T21:00:00Z" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(grants(c).length, 3);
  });
  it("C7. if the grants cannot be cleared, the item is NOT made public — refused, retryable, nothing written", async () => {
    const c = use(seed(), { errors: { trip_private_anchor_shares: { message: "grants unavailable", code: "57P01", ops: ["delete"] } } });
    const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ANA, { locationIsPrivate: false });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal((c._store.trip_plan_items[0] as any).location_is_private, true);
  });
  it("C8. a member removal whose clearing fails still removes the member (logged), and the read-time rule still denies", async () => {
    const s = seed();
    s.route_plans = [{ id: "dddddddd-0000-4000-8000-00000000000d", trip_id: TRIP, owner_user_id: BEN, status: "active", updated_at: "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z" }];
    (s.trip_plan_items[1] as any).removed_at = "2026-10-05T00:00:00Z";
    const c = use(s, { errors: { trip_private_anchor_shares: { message: "grants unavailable", code: "57P01", ops: ["delete"] } } });
    const r = await call(harness.base, "DELETE", `/trips/${TRIP}/members/${BEN}`, ORGANIZER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(grants(c).length, 3, "vacuity guard: the clearing really failed");
    const rp = await call(harness.base, "GET", `/route-plans/for-trip/${TRIP}`, BEN);
    assert.equal(rp.body?.plan?.tripAccommodationLocation ?? null, null);
  });
});

describe("E. the organizer edits another member's private item only where it does not locate or name it", () => {
  it("E1. a change of place or title is refused, and the row is untouched", async () => {
    const c = use(seed());
    for (const body of [{ lat: 1, lng: 1 }, { title: "Renamed" }, { locationName: "Elsewhere" }, { notes: "x" }, { locationIsPrivate: false }]) {
      const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ORGANIZER, body);
      assert.equal(r.status, 403, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const row = c._store.trip_plan_items[0] as any;
    assert.deepEqual([row.title, row.lat, row.location_name, row.location_is_private], ["Casa Segreta", 38.70417, "Rua do Segredo 7", true]);
    assert.equal(grants(c).length, 3);
  });
  it("E2. a change of time is allowed, and the answer is the withheld slot, not the place", async () => {
    use(seed());
    const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ORGANIZER, { startsAt: "2026-10-06T21:00:00Z" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.doesNotMatch(JSON.stringify(r.body), SECRET);
    assert.equal(r.body.locationWithheld, true);
  });
  it("E3. on the kernel path the same refusal holds before any command is sent", async () => {
    const c = use(seed({ kernel: true }), {}, true);
    const r = await call(harness.base, "PATCH", `/trips/${TRIP}/plan/items/${HOTEL}`, ORGANIZER, { lat: 1, lng: 1 });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((c._store.trip_plan_items[0] as any).lat, 38.70417);
  });
});

describe("M. migration 3972, by its text", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.startsWith("3972_"))!;
  const raw = readFileSync(new URL(file, dir), "utf8");
  const sql = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const policy = sql.slice(sql.indexOf('CREATE POLICY "plan_items_select"'), sql.indexOf(";", sql.indexOf('CREATE POLICY "plan_items_select"')));
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION authz.private_anchor_granted"), sql.indexOf("$fn$;", sql.indexOf("CREATE OR REPLACE FUNCTION authz.private_anchor_granted")));

  it("M1. plan_items_select keeps 2337's two clauses and adds owner-only: non-private, own, or a live grant", () => {
    assert.match(policy, /trip_plan_items\.removed_at IS NULL/);
    assert.match(policy, /authz\.is_trip_crew\(trip_plan_items\.trip_id\)/);
    assert.match(policy, /trip_plan_items\.location_is_private IS NOT TRUE/);
    assert.match(policy, /trip_plan_items\.creator_id = auth\.uid\(\)/);
    assert.match(policy, /authz\.private_anchor_granted\(trip_plan_items\.id, trip_plan_items\.creator_id, trip_plan_items\.trip_id\)/);
  });
  it("M2. no unqualified column and no self-comparison (the `x.c = x.c` tautology) in the policy", () => {
    const pred = policy.slice(policy.indexOf("USING"));
    const cols = [...pred.matchAll(/\b(removed_at|trip_id|location_is_private|creator_id|id)\b/g)];
    for (const m of cols) assert.equal(pred.slice(m.index! - "trip_plan_items.".length, m.index!), "trip_plan_items.", `unqualified ${m[1]}`);
    assert.doesNotMatch(pred, /(\w+\.\w+)\s*=\s*\1\b/);
  });
  it("M3. the helper cannot recurse (reads no trip_plan_items), reads the viewer itself, is SECURITY DEFINER with a pinned search_path", () => {
    assert.doesNotMatch(fn, /trip_plan_items/);
    assert.match(fn, /g\.member_id = auth\.uid\(\)/);
    assert.match(fn, /SECURITY DEFINER/);
    assert.match(fn, /SET search_path TO 'public', 'pg_catalog'/);
    assert.match(fn, /trip_private_anchor_sharing_enabled/);
    assert.match(fn, /coalesce\(m\.status, 'accepted'\) = 'accepted'/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION authz\.private_anchor_granted\(uuid, uuid, uuid\) TO anon, authenticated, service_role;/);
  });
  it("M4. both clearing triggers exist, on the events that end (or begin) a grant's truth", () => {
    assert.match(sql, /AFTER INSERT OR DELETE OR UPDATE OF role, status, user_id, trip_id ON public\.trip_members/);
    assert.match(sql, /AFTER UPDATE OF location_is_private, removed_at ON public\.trip_plan_items/);
    assert.match(sql, /IF NEW\.location_is_private IS NOT TRUE OR NEW\.removed_at IS NOT NULL THEN/);
  });
  it("M5. postconditions assert the policy clauses and the triggers; the rollback refuses while sharing is on and says it reopens the read", () => {
    assert.match(raw, /POSTCONDITION FAILED \(3972\): plan_items_select does not carry the owner-only clause/);
    assert.match(raw, /expected 2 grant-clearing triggers/);
    const rb = readFileSync(new URL("../../../../db/rollback/2026-10-05-3972-trip-private-anchor-rls-and-grant-lifecycle-rollback.sql", import.meta.url), "utf8");
    assert.match(rb, /REOPENS A PRIVACY HOLE/);
    assert.match(rb, /ROLLBACK REFUSED \(3972\)/);
    assert.match(rb, /FOR SELECT USING \( removed_at IS NULL AND authz\.is_trip_crew\(trip_id\) \);/);
  });
});
