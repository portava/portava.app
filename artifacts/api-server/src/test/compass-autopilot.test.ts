/**
 * Trip Autopilot (Phase 13) route + engine tests.
 *
 * Covers:
 *   - auth required, COMPASS_ENABLED off → honest fallback envelope,
 *     non-members rejected on every surface
 *   - timing conflicts caught with concrete reasons (gap vs travel estimate)
 *   - partial re-planner: proposals touch ONLY affected items; a simulated
 *     day-anchor cancellation yields a recovery proposal that cancels the
 *     broken item and pulls the next movable item up — other days untouched
 *   - fixed-item immunity: fixed items are never included in a proposal,
 *     and are re-checked (and refused) at confirm time even if the proposal
 *     predates the re-typing
 *   - permission bounds: allowMoveFlexible=false blocks flexible moves;
 *     autopilot disabled → issues still reported, zero proposals
 *   - propose-never-execute: check creates pending rows only; nothing changes
 *     until an explicit confirm; decline resolves with zero writes
 *   - dedupe: re-running a check never duplicates a pending proposal
 *   - Trip Heartbeat: healthy / attention / at_risk states, item-type counts,
 *     pending-proposal count, weather risk surfacing
 *
 * Runtime: node:test + node:assert (no vitest, no real DB, no network)
 * Run: node --import tsx/esm --test src/test/compass-autopilot.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import compassAutopilotRouter, { _setTestNowMs } from "../routes/compassAutopilot.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ID = "00000000-0000-0000-0000-000000000002";
const TRIP_ID = "10000000-0000-0000-0000-000000000001";

/* ── Permissive fake Supabase client (same pattern as compass-live tests) ──── */
type Row = Record<string, unknown>;

let idCounter = 0;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;
    let _lastWritten: Row[] | null = null;
    let _pendingUpdate: Row | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    function applyPendingUpdate(): void {
      if (!_pendingUpdate) return;
      for (const r of tbl(tableName)) {
        if (filters.every((f) => f(r))) Object.assign(r, _pendingUpdate);
      }
      _lastWritten = null;
      _pendingUpdate = null;
    }

    function result(): Row[] {
      return _lastWritten ?? rows();
    }

    const passthrough = new Set([
      "select", "order", "or", "like", "ilike", "not",
      "contains", "overlaps", "range", "textSearch", "filter", "match",
    ]);

    const b: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => {
            applyPendingUpdate();
            resolve({ data: result(), error: null });
          };
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            applyPendingUpdate();
            return Promise.resolve({ data: result()[0] ?? null, error: result()[0] ? null : (prop === "single" ? { code: "PGRST116" } : null) });
          };
        }
        if (prop === "limit") return (n: number) => { _limit = n; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "in")  return (k: string, vs: unknown[]) => { filters.push((r) => (vs as unknown[]).includes(r[k])); return b; };
        if (prop === "is")  return (k: string, v: unknown) => { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return b; };
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "lte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") <= String(v)); return b; };
        if (prop === "gt")  return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") > String(v)); return b; };
        if (prop === "insert") {
          return (payload: Row | Row[]) => {
            const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
              id: `20000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`,
              created_at: new Date().toISOString(),
              ...r,
            }));
            tbl(tableName).push(...arr);
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "upsert") {
          return (payload: Row | Row[], opts?: { onConflict?: string }) => {
            const keys = (opts?.onConflict ?? "id").split(",");
            const arr = Array.isArray(payload) ? payload : [payload];
            for (const r of arr) {
              const existing = tbl(tableName).find((e) => keys.every((k) => e[k] === r[k]));
              if (existing) Object.assign(existing, r);
              else tbl(tableName).push({ ...r });
            }
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "update") {
          return (payload: Row) => { _pendingUpdate = { ...payload }; return b; };
        }
        if (prop === "delete") return (..._a: unknown[]) => b;
        if (passthrough.has(prop)) return (..._a: unknown[]) => b;
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
            : token === "other-token"
            ? Promise.resolve({ data: { user: { id: OTHER_ID } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store,
  };
}

/* ── Mini express app ─────────────────────────────────────────────────────── */

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassAutopilotRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestNowMs(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

const TODAY = new Date().toISOString().slice(0, 10);
const BASE_MS = new Date(`${TODAY}T06:00:00.000Z`).getTime();

beforeEach(() => {
  invalidateFlagsCache();
  _setTestNowMs(BASE_MS);
});

async function api(method: string, path: string, body?: unknown, token = "valid-token") {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

/* ── Seed helpers ─────────────────────────────────────────────────────────── */

function enabledFlag(): Row {
  return { flag: "COMPASS_ENABLED", enabled: true };
}

let citySeq = 0;

/** Each trip gets a unique city so weatherCache's in-memory layer never
 *  bleeds a forecast from a previous test. */
function seedTrip(store: Record<string, Row[]>, opts: { rainyToday?: boolean } = {}): string {
  const city = `Testville${++citySeq}`;
  store.trips = [{
    id: TRIP_ID, owner_id: USER_ID, destination_city: city,
    start_date: null, end_date: null, status: "in_progress",
  }];
  store.trip_members = [{ trip_id: TRIP_ID, user_id: USER_ID, role: "owner" }];
  store.weather_cache = [{
    destination: city.toLowerCase(),
    date_key: `${TODAY}:${TODAY}`,
    fetched_at: new Date().toISOString(),
    brief_summary: "seeded",
    forecasts_json: [
      opts.rainyToday
        ? { date: TODAY, weatherCode: 61, summary: "Rain", maxTempC: 27, minTempC: 22, precipMm: 12 }
        : { date: TODAY, weatherCode: 1, summary: "Partly cloudy", maxTempC: 30, minTempC: 24, precipMm: 0 },
    ],
  }];
  return city;
}

function at(h: number, m = 0): string {
  return new Date(BASE_MS + ((h - 6) * 60 + m) * 60_000).toISOString();
}

interface SeedItemOpts {
  lockType?: string;
  category?: string;
  endsAt?: string | null;
  dayDate?: string | null;
  lat?: number | null;
  lng?: number | null;
  sourceType?: string;
  sourceId?: string | null;
}

function seedItem(
  store: Record<string, Row[]>,
  id: string,
  title: string,
  startsAt: string | null,
  o: SeedItemOpts = {},
): void {
  store.trip_plan_items ??= [];
  store.trip_plan_items.push({
    id, trip_id: TRIP_ID, title,
    category: o.category ?? "activity",
    status: "confirmed",
    lock_type: o.lockType ?? "flexible",
    day_date: o.dayDate === undefined ? TODAY : o.dayDate,
    starts_at: startsAt,
    ends_at: o.endsAt ?? null,
    location_name: null,
    lat: o.lat ?? null,
    lng: o.lng ?? null,
    source_type: o.sourceType ?? "manual",
    source_id: o.sourceId ?? null,
    sort_order: 0,
    removed_at: null,
  });
}

const I1 = "30000000-0000-0000-0000-000000000001";
const I2 = "30000000-0000-0000-0000-000000000002";
const I3 = "30000000-0000-0000-0000-000000000003";
const I4 = "30000000-0000-0000-0000-000000000004";

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("Trip Autopilot", () => {
  it("requires auth", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    _setTestClient(fakeClient, true);
    const r = await api("GET", `/trips/${TRIP_ID}/heartbeat`, undefined, "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns the honest fallback envelope when COMPASS_ENABLED is off", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [{ flag: "COMPASS_ENABLED", enabled: false }] });
    seedTrip(store);
    _setTestClient(fakeClient, true);
    const r = await api("GET", `/trips/${TRIP_ID}/heartbeat`);
    assert.equal(r.status, 200);
    assert.equal(r.json.compassEnabled, false);
    assert.equal(r.json.fallback, true);
  });

  it("rejects non-members on check, heartbeat, and proposals", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    _setTestClient(fakeClient, true);
    for (const [method, path] of [
      ["POST", `/trips/${TRIP_ID}/autopilot/check`],
      ["GET", `/trips/${TRIP_ID}/heartbeat`],
      ["GET", `/trips/${TRIP_ID}/autopilot/proposals`],
    ] as const) {
      const r = await api(method, path, method === "POST" ? {} : undefined, "other-token");
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  });

  it("catches a timing conflict with a concrete reason and proposes moving only the affected flexible item", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    // Tour ends 17:30; dinner at 18:00 but ~40 min walk away (about 3 km).
    seedItem(store, I1, "Harbor tour", at(16), { endsAt: at(17, 30), lockType: "fixed", lat: 10.0, lng: 123.0 });
    seedItem(store, I2, "Dinner at Luz", at(18), { endsAt: at(19, 30), lockType: "flexible", lat: 10.027, lng: 123.0 });
    seedItem(store, I3, "Morning museum (other item)", at(9), { endsAt: at(10), lockType: "flexible" });
    _setTestClient(fakeClient, true);

    const r = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.equal(r.status, 200);
    const conflict = r.json.issues.find((i: any) => i.type === "timing_conflict");
    assert.ok(conflict, "timing conflict detected");
    assert.match(conflict.reason, /Harbor tour/);
    assert.match(conflict.reason, /Dinner at Luz/);
    assert.match(conflict.reason, /min/);

    assert.equal(r.json.proposalsCreated.length, 1);
    const p = r.json.proposalsCreated[0];
    assert.equal(p.issueType, "timing_conflict");
    // Only the dinner (flexible) moves; the fixed tour and the unrelated
    // morning item are untouched.
    assert.equal(p.changes.length, 1);
    assert.equal(p.changes[0].itemId, I2);
    assert.ok(new Date(p.changes[0].after.startsAt).getTime() > new Date(at(18)).getTime());

    // Propose, never execute: the item row itself is unchanged.
    const dinner = store.trip_plan_items!.find((i) => i.id === I2)!;
    assert.equal(dinner.starts_at, at(18));
  });

  it("fixed items are immune: conflict between two fixed items is flagged but yields zero proposals", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Flight check-in", at(10), { endsAt: at(11), lockType: "fixed" });
    seedItem(store, I2, "Visa appointment", at(11, 5), { lockType: "fixed" });
    _setTestClient(fakeClient, true);

    const r = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.ok(r.json.issues.some((i: any) => i.type === "timing_conflict"));
    assert.equal(r.json.proposalsCreated.length, 0);
  });

  it("permission bounds: allowMoveFlexible=false blocks flexible-item proposals", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Walking tour", at(10), { endsAt: at(11), lockType: "fixed" });
    seedItem(store, I2, "Coffee stop", at(11, 2), { lockType: "flexible" });
    _setTestClient(fakeClient, true);

    const s = await api("PUT", `/trips/${TRIP_ID}/autopilot/settings`, { allowMoveFlexible: false });
    assert.equal(s.json.settings.allowMoveFlexible, false);

    const r = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.ok(r.json.issues.some((i: any) => i.type === "timing_conflict"), "conflict still reported");
    assert.equal(r.json.proposalsCreated.length, 0, "no proposal without permission");
  });

  it("autopilot disabled: issues still reported, zero proposals created", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11) });
    seedItem(store, I2, "Gallery", at(11, 3));
    _setTestClient(fakeClient, true);

    await api("PUT", `/trips/${TRIP_ID}/autopilot/settings`, { enabled: false });
    const r = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.ok(r.json.issues.length > 0);
    assert.equal(r.json.proposalsCreated.length, 0);
    assert.equal((store.trip_autopilot_proposals ?? []).length, 0);
  });

  it("simulated day-anchor cancellation → partial recovery plan touching only affected items", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    const tomorrow = new Date(BASE_MS + 86_400_000).toISOString().slice(0, 10);
    seedItem(store, I1, "Island-hopping day tour", at(9), { endsAt: at(15), lockType: "flexible" });
    seedItem(store, I2, "Sunset dinner", at(18), { endsAt: at(20), lockType: "flexible" });
    seedItem(store, I3, "Hotel breakfast (fixed)", at(7), { endsAt: at(8), lockType: "fixed" });
    seedItem(store, I4, "Tomorrow's museum", null, { dayDate: tomorrow });
    _setTestClient(fakeClient, true);

    const r = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {
      simulate: [{ kind: "item_cancelled", itemId: I1, note: "operator cancelled due to weather" }],
    });
    assert.equal(r.status, 200);
    const recovery = r.json.proposalsCreated.find((p: any) => p.issueType === "disruption_recovery");
    assert.ok(recovery, "recovery proposal created");
    assert.match(recovery.reason, /cancelled/);
    // Touches ONLY the cancelled anchor + the same-day flexible successor.
    const touched = recovery.changes.map((c: any) => c.itemId).sort();
    assert.deepEqual(touched, [I1, I2].sort());
    // Fixed breakfast and tomorrow's item are preserved untouched.
    assert.ok(!touched.includes(I3));
    assert.ok(!touched.includes(I4));
    // Before/after reasoning present.
    const cancelChange = recovery.changes.find((c: any) => c.itemId === I1);
    assert.equal(cancelChange.before.status, "confirmed");
    assert.equal(cancelChange.after.status, "cancelled");
  });

  it("dedupe: re-running the check skips existing pending proposals", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11) });
    seedItem(store, I2, "Gallery", at(11, 3));
    _setTestClient(fakeClient, true);

    const r1 = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.equal(r1.json.proposalsCreated.length, 1);
    const r2 = await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    assert.equal(r2.json.proposalsCreated.length, 0);
    assert.equal(r2.json.proposalsSkipped, 1);
    assert.equal((store.trip_autopilot_proposals ?? []).length, 1);
  });

  it("confirm applies the change; decline applies nothing", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11) });
    seedItem(store, I2, "Gallery", at(11, 3));
    _setTestClient(fakeClient, true);

    await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    const list = await api("GET", `/trips/${TRIP_ID}/autopilot/proposals`);
    const proposal = list.json.proposals[0];
    assert.equal(proposal.status, "pending");

    const c = await api("POST", `/autopilot/proposals/${proposal.id}/confirm`, {});
    assert.equal(c.status, 200);
    assert.equal(c.json.applied, 1);
    const gallery = store.trip_plan_items!.find((i) => i.id === I2)!;
    assert.notEqual(gallery.starts_at, at(11, 3), "confirmed change applied");

    // Second confirm → already resolved.
    const again = await api("POST", `/autopilot/proposals/${proposal.id}/confirm`, {});
    assert.equal(again.status, 409);
  });

  it("confirm re-verifies lock type: an item re-typed to fixed after proposing is refused", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11) });
    seedItem(store, I2, "Gallery", at(11, 3));
    _setTestClient(fakeClient, true);

    await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    const list = await api("GET", `/trips/${TRIP_ID}/autopilot/proposals`);
    const proposal = list.json.proposals[0];

    // User re-types the gallery to fixed before confirming.
    store.trip_plan_items!.find((i) => i.id === I2)!.lock_type = "fixed";

    const c = await api("POST", `/autopilot/proposals/${proposal.id}/confirm`, {});
    assert.equal(c.json.applied, 0);
    assert.equal(c.json.blocked.length, 1);
    assert.match(c.json.blocked[0], /Fixed/);
    const gallery = store.trip_plan_items!.find((i) => i.id === I2)!;
    assert.equal(gallery.starts_at, at(11, 3), "fixed item untouched");
  });

  it("decline resolves the proposal with zero plan changes", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11) });
    seedItem(store, I2, "Gallery", at(11, 3));
    _setTestClient(fakeClient, true);

    await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    const list = await api("GET", `/trips/${TRIP_ID}/autopilot/proposals`);
    const d = await api("POST", `/autopilot/proposals/${list.json.proposals[0].id}/decline`, {});
    assert.equal(d.json.status, "declined");
    const gallery = store.trip_plan_items!.find((i) => i.id === I2)!;
    assert.equal(gallery.starts_at, at(11, 3));
    assert.equal(store.trip_autopilot_proposals![0].status, "declined");
  });

  it("heartbeat: healthy with a clean plan", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    seedItem(store, I1, "Brunch", at(10), { endsAt: at(11), lockType: "fixed" });
    seedItem(store, I2, "Gallery", at(14), { lockType: "optional" });
    _setTestClient(fakeClient, true);

    const r = await api("GET", `/trips/${TRIP_ID}/heartbeat`);
    assert.equal(r.status, 200);
    const hb = r.json.heartbeat;
    assert.equal(hb.status, "healthy");
    assert.deepEqual(hb.itemCounts, { fixed: 1, flexible: 0, optional: 1, total: 2 });
    assert.equal(hb.pendingProposals, 0);
    assert.equal(hb.nextItem.id, I1, "next upcoming item surfaced");
  });

  it("heartbeat: at_risk on a cancelled linked meetup (social change), with pending proposals counted", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store);
    const MEETUP = "40000000-0000-0000-0000-000000000001";
    seedItem(store, I1, "Group hike", at(10), { sourceType: "meetup", sourceId: MEETUP });
    store.meetups = [{ id: MEETUP, status: "cancelled" }];
    _setTestClient(fakeClient, true);

    await api("POST", `/trips/${TRIP_ID}/autopilot/check`, {});
    const r = await api("GET", `/trips/${TRIP_ID}/heartbeat`);
    const hb = r.json.heartbeat;
    assert.equal(hb.status, "at_risk");
    assert.ok(hb.issues.some((i: any) => i.type === "social_change" && /cancelled/.test(i.reason)));
    assert.equal(hb.pendingProposals, 1);
  });

  it("heartbeat: rainy forecast surfaces a weather risk and outdoor-item clash", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    seedTrip(store, { rainyToday: true });
    seedItem(store, I1, "Beach picnic", at(12), { category: "activity" });
    _setTestClient(fakeClient, true);

    const r = await api("GET", `/trips/${TRIP_ID}/heartbeat`);
    const hb = r.json.heartbeat;
    assert.equal(hb.status, "attention");
    assert.ok(hb.risks.some((x: any) => x.type === "weather"));
    assert.ok(hb.issues.some((i: any) => i.type === "weather_clash" && /Beach picnic/.test(i.reason)));
  });
});
