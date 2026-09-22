/**
 * Telegraph §13.2 — `availability.started` · `availability.expired` ·
 * `location.started` · `location.expired`, and the mechanism that fires the
 * two expiries.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §4.3   "Availability expires automatically and revokes across Telegraph,
 *          Discovery and Compass."
 *   §12    `location_shares` — "Purpose/audience/precision/expiry scoped
 *          location capability."
 *   §13.2  the four events above
 *   §13.3  "…consume asynchronously and idempotently."
 *   §15.1  a location capability is purpose- and time-bound
 *
 * census-telegraph T187–T190 scored all four "Not in the union", and T188 named
 * the reason expiry emitted nothing: it "is evaluated lazily on read
 * (`2260:38-42`)". This file's job is to prove the difference between a column
 * and a behaviour — that something RUNS, ends what has ended, and says so.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - The availability sweep's `error` left unchecked: the degraded test fails.
 *     A PostgREST rejection RESOLVES, so an unchecked delete reports `expired:
 *     0` for a database that refused it, and a revocation that has stopped
 *     looks exactly like one with nothing to do.
 *   - The availability delete left unqualified: the "qualified" test fails —
 *     and on the real database supautils' safeupdate guard rejects it outright.
 *   - `availability.*` published to anyone but the owner: the audience tests
 *     fail. Who may see a person's availability is §4's question and is not
 *     answered by a realtime bus.
 *   - `location.started` emitted for a pin with no expiry: the pin test fails
 *     and a client renders a live chip nothing will ever take down.
 *   - The half-open window made inclusive at `since`: the re-emit test fails
 *     and every tick forever re-announces the share on the boundary.
 *   - The watermark advanced after a FAILED tick: the recovery test fails, and
 *     every share that expired inside the broken window is lost silently.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLifecycleEvents.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import availabilityRouter from "../routes/availability.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import {
  LOCATION_SWEEP_HORIZON_HOURS,
  sharesExpiringIn,
  sweepExpiredAvailability,
  sweepExpiredLocationShares,
} from "../services/telegraph/lifecycleSweep.js";
import {
  SWEEP_INTERVAL_MS,
  _resetLifecycleSweepStatus,
  getLifecycleSweepStatus,
  tickOnce,
} from "../server/telegraph/lifecycleScheduler.js";
import {
  LOCATION_PRECISIONS,
  LocationPayload,
  MAX_LOCATION_SHARE_HOURS,
  TELEGRAPH_SHARE_PURPOSES,
} from "../services/telegraph/messageKinds.js";
import { LOCATION_PURPOSES } from "../lib/locationPurposes.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const NOW = Date.now();
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();

function env(kind: string, payload: unknown) {
  return JSON.stringify({ kind, envelopeVersion: "1", payload });
}

interface State {
  quick?: any[];
  messages?: any[];
  errorTable?: string;
  members?: any[];
  /**
   * Re-arms a signal between the sweep's SELECT and its DELETE — the race the
   * two-statement shape exists to survive. The owner set a new status in the
   * window between the two, and the expiry predicate on the DELETE is the only
   * thing that stops the sweep ending a signal that is live again.
   */
  rearmAfterSelect?: string;
  /**
   * Fails only the DELETE, leaving the candidate SELECT healthy. Without this
   * the two error checks are indistinguishable: injecting on the table breaks
   * the SELECT first, the sweep returns on its failure, and a mutation that
   * deleted the DELETE's own check stayed green.
   */
  deleteErrorOnly?: boolean;
}

/** Records every filter applied, so a test can assert the delete was QUALIFIED. */
interface Call { table: string; op: string; shape: string[] }

function makeClient(state: State = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "disable_messaging", enabled: false },
      { flag: "telegraph_history_bound_enabled", enabled: false },
      { flag: "open_to_plans_windows_enabled", enabled: false },
    ],
    message_threads: [{ id: THREAD, is_e2ee: false }],
    message_thread_members: state.members ?? [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
    ],
    blocks: [],
    quick_availability_status: [...(state.quick ?? [])],
    messages: [...(state.messages ?? [])],
  };
  const calls: Call[] = [];
  let seq = 0;

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const shape: string[] = [];
    let op = "select";
    let pending: any = null;
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () => {
      if (state.deleteErrorOnly && op === "delete" && table === "quick_availability_status") {
        return { message: "injected failure on the delete", code: "XX000" };
      }
      return state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;
    };
    const record = () => { calls.push({ table, op, shape: [...shape] }); };

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        op = "insert";
        seq += 1;
        pending = { id: `ins-${seq}`, ...row };
        (db[table] ??= []).push(pending);
        return proxy;
      },
      upsert(row: any) {
        op = "upsert";
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) {
          const hit = (db[table] ??= []).find((x) => x.user_id === r.user_id);
          if (hit) Object.assign(hit, r); else db[table]!.push({ ...r });
          pending = hit ?? db[table]![db[table]!.length - 1];
        }
        return proxy;
      },
      update(patch: any) { op = "update"; pending = { __update: patch }; return proxy; },
      delete() { op = "delete"; return proxy; },
      eq(col: string, val: any) { shape.push(`eq:${col}`); preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { shape.push(`neq:${col}`); preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { shape.push(`is:${col}`); preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { shape.push(`in:${col}`); preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { shape.push(`gte:${col}`); preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      lte(col: string, val: any) { shape.push(`lte:${col}`); preds.push((r) => Date.parse(r[col]) <= Date.parse(val)); return proxy; },
      lt(col: string, val: any) { shape.push(`lt:${col}`); preds.push((r) => Date.parse(r[col]) < Date.parse(val)); return proxy; },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        record();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pending && !pending.__update ? pending : rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        record();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pending && !pending.__update ? pending : rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        record();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (op === "delete") {
          const doomed = rowsNow();
          const ids = new Set(doomed);
          db[table] = (db[table] ?? []).filter((r) => !ids.has(r));
          return Promise.resolve({ data: doomed, error: null }).then(resolve, reject);
        }
        if (pending && pending.__update) {
          const patch = pending.__update; pending = null;
          for (const r of rowsNow()) Object.assign(r, patch);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        const rows = pending ? [pending] : rowsNow();
        // The re-arm happens AFTER this SELECT has read its rows and BEFORE the
        // DELETE runs — which is the race, and which is why the hook is here
        // rather than at the top of `then`. Placed there it fired before
        // `rowsNow()` and the row simply never entered the candidate list, so
        // the test passed for the wrong reason and a mutation dropping the
        // DELETE's expiry predicate stayed green.
        if (op === "select" && table === "quick_availability_status" && state.rearmAfterSelect) {
          const hit = (db[table] ?? []).find((r) => r.user_id === state.rearmAfterSelect);
          if (hit) hit.expires_at = min(240);
        }
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _calls: calls,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

let server: any;
let base = "";
let deliveries: Array<{ userId: string; event: TelegraphEvent }> = [];
let unsubs: Array<() => void> = [];

function recipientsOf(type: string): string[] {
  return [...new Set(deliveries.filter((d) => d.event.type === type).map((d) => d.userId))].sort();
}
function firstPayload(type: string): any {
  return deliveries.find((d) => d.event.type === type)?.event.payload ?? null;
}
function countDistinct(type: string): number {
  return new Set(
    deliveries.filter((d) => d.event.type === type).map((d) => String((d.event.payload as any)?.eventKey ?? "")),
  ).size;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

async function patch(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", availabilityRouter);
  app.use("/api", telegraphKindsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  for (const u of unsubs) u();
  _setTestClient(null, false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const u of unsubs) u();
  deliveries = [];
  unsubs = [ALICE, BOB, CAROL].map((u) => subscribe(u, (e) => { deliveries.push({ userId: u, event: e }); }));
  _resetLifecycleSweepStatus();
});

function locationMsg(id: string, sender: string, createdAt: string, payload: Record<string, unknown>) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: createdAt,
    deleted_at: null,
    msg_type: "location",
    subtype: String(payload.precision ?? "area"),
    body: env("LOCATION", { label: "Here", precision: "area", ...payload }),
  };
}

/* ─────────────────────────── §13.2 availability ───────────────────────────── */

describe("§13.2 availability.started", () => {
  it("is published when a quick status is set, to the OWNER and nobody else", async () => {
    const c = makeClient();
    _setTestClient(c, true);
    const r = await patch("/me/quick-availability", ALICE, { status: "free_now" });
    assert.equal(r.status, 200);
    await settle();
    assert.deepEqual(recipientsOf("availability.started"), [ALICE]);
    const p = firstPayload("availability.started");
    assert.equal(p.status, "free_now");
    assert.ok(p.expiresAt, "an availability signal with no expiry cannot revoke (§4.3)");
    assert.match(String(p.eventKey), /^availability\.started:/);
  });

  it("carries no place, no coordinate and no counterpart", async () => {
    _setTestClient(makeClient(), true);
    await patch("/me/quick-availability", ALICE, { status: "open_to_plans" });
    await settle();
    const p = firstPayload("availability.started");
    assert.deepEqual(
      Object.keys(p).sort(),
      ["eventKey", "expiresAt", "startedAt", "status"],
      "an availability event is a fact about a person's own status and nothing else",
    );
  });
});

describe("§13.2 availability.expired — §4.3's revocation, performed", () => {
  it("ends every signal past its window and tells each owner", async () => {
    const c = makeClient({
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: min(-10) },
        { user_id: BOB, status: "busy", expires_at: min(-1) },
        { user_id: CAROL, status: "open_to_plans", expires_at: min(120) },
      ],
    });
    const out = await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    assert.equal(out.expired, 2);
    assert.deepEqual(out.failures, []);
    assert.deepEqual(recipientsOf("availability.expired"), [ALICE, BOB].sort());
    assert.deepEqual(
      c._db.quick_availability_status.map((r: any) => r.user_id),
      [CAROL],
      "the live signal must survive the sweep",
    );
  });

  it("reports the SIGNAL's own expiry, not the sweep's clock", async () => {
    const c = makeClient({ quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-90) }] });
    await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    const p = firstPayload("availability.expired");
    assert.equal(p.expiredAt, min(-90), "a late sweep must not report a longer disclosure than happened");
    assert.equal(p.sweptAt, new Date(NOW).toISOString());
  });

  it("the DELETE is QUALIFIED — an unqualified one is refused by this database's safeupdate guard", async () => {
    const c = makeClient({ quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-5) }] });
    await sweepExpiredAvailability(c, new Date(NOW));
    const del = c._calls.find((x: Call) => x.table === "quick_availability_status" && x.op === "delete");
    assert.ok(del, "no delete was issued");
    assert.ok(del.shape.includes("lte:expires_at"),
      "a sweep that can ever be unqualified is a sweep that can delete everybody's availability");
  });

  it("re-running the sweep emits NOTHING — the deleted row is its own watermark", async () => {
    const c = makeClient({ quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-5) }] });
    await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    deliveries = [];
    const again = await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    assert.equal(again.expired, 0);
    assert.equal(countDistinct("availability.expired"), 0);
  });

  it("the DELETE names the candidate ids as well, so one pass is bounded", async () => {
    const c = makeClient({
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: min(-5) },
        { user_id: BOB, status: "busy", expires_at: min(-5) },
      ],
    });
    await sweepExpiredAvailability(c, new Date(NOW));
    const del = c._calls.find((x: Call) => x.table === "quick_availability_status" && x.op === "delete");
    assert.ok(del!.shape.includes("in:user_id"),
      "PostgREST refuses a limited DELETE with no order, so the bound is the candidate id list");
    assert.ok(del!.shape.includes("lte:expires_at"));
  });

  it("a signal RE-ARMED between the two statements survives the sweep", async () => {
    // The whole reason the expiry predicate stays on the DELETE. Without it the
    // sweep would say "delete the rows I saw a moment ago", and a person who
    // set FREE NOW in that window would have it revoked by a clock reading from
    // before they pressed it.
    const c = makeClient({
      rearmAfterSelect: BOB,
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: min(-5) },
        { user_id: BOB, status: "free_now", expires_at: min(-5) },
      ],
    });
    const out = await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    assert.equal(out.expired, 1);
    assert.deepEqual(recipientsOf("availability.expired"), [ALICE]);
    assert.deepEqual(
      c._db.quick_availability_status.map((r: any) => r.user_id),
      [BOB],
      "a signal that is live again must not be ended by a read from before it was set",
    );
  });

  it("a DELETE that FAILS is reported, even when the candidate read succeeded", async () => {
    const c = makeClient({
      deleteErrorOnly: true,
      quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-5) }],
    });
    const out = await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    assert.equal(out.expired, 0);
    assert.equal(out.failures.length, 1, "a delete that did not happen is not an expiry that did");
    assert.equal(countDistinct("availability.expired"), 0,
      "and nothing may be announced as expired on the strength of a read alone");
    assert.deepEqual(c._db.quick_availability_status.map((r: any) => r.user_id), [ALICE]);
  });

  it("an UNREADABLE table is a FAILURE, never 'nothing to expire'", async () => {
    const c = makeClient({
      errorTable: "quick_availability_status",
      quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-5) }],
    });
    const out = await sweepExpiredAvailability(c, new Date(NOW));
    await settle();
    assert.equal(out.expired, 0);
    assert.equal(out.failures.length, 1);
    assert.match(out.failures[0]!, /quick_availability_status/);
    assert.equal(countDistinct("availability.expired"), 0, "a broken sweep must not fabricate an expiry either");
  });
});

/* ───────────────────────────── §13.2 location ─────────────────────────────── */

describe("§12 location_shares — an expiry that is a bound, and §13.2 location.started", () => {
  it("every purpose a share may claim is an id the canonical registry publishes", () => {
    const known = new Set(LOCATION_PURPOSES.map((p) => p.id));
    for (const p of TELEGRAPH_SHARE_PURPOSES) {
      assert.ok(known.has(p), `${p} is not in lib/locationPurposes.ts — a purpose validated against nothing means nothing`);
    }
  });

  it("a share with an expiry publishes location.started to the conversation", async () => {
    _setTestClient(makeClient(), true);
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "The bar", precision: "venue", expiresAt: min(60), purpose: "presence_in_context" },
    });
    assert.equal(r.status, 201);
    await settle();
    assert.deepEqual(recipientsOf("location.started"), [ALICE, BOB].sort());
    const p = firstPayload("location.started");
    assert.equal(p.precision, "venue");
    assert.equal(p.purpose, "presence_in_context");
    assert.equal(p.expiresAt, min(60));
    assert.equal(p.lat, undefined);
    assert.equal(p.lng, undefined);
  });

  it("a PIN with no expiry publishes nothing — it has no lifecycle", async () => {
    _setTestClient(makeClient(), true);
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "The bar", precision: "venue" },
    });
    assert.equal(r.status, 201);
    await settle();
    assert.equal(countDistinct("location.started"), 0);
  });

  it("an expiry already in the past is REFUSED — it could never be taken down", async () => {
    _setTestClient(makeClient(), true);
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "The bar", expiresAt: min(-5) },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /already past/);
  });

  it("an expiry past the ceiling is REFUSED — §15.1 bounds a location capability", async () => {
    _setTestClient(makeClient(), true);
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "The bar", expiresAt: min(MAX_LOCATION_SHARE_HOURS * 60 + 30) },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /at most/);
  });

  it("a purpose the registry does not publish is REFUSED", async () => {
    _setTestClient(makeClient(), true);
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "The bar", expiresAt: min(60), purpose: "marketing" },
    });
    assert.equal(r.status, 400);
  });
});

describe("§13.2 location.expired — the window, and what a tick covers", () => {
  it("is half-open: (since, now]", () => {
    const shares = [
      { shareId: "before", threadId: THREAD, ownerUserId: ALICE, expiresAt: min(-20) },
      { shareId: "on-since", threadId: THREAD, ownerUserId: ALICE, expiresAt: min(-10) },
      { shareId: "inside", threadId: THREAD, ownerUserId: ALICE, expiresAt: min(-5) },
      { shareId: "on-now", threadId: THREAD, ownerUserId: ALICE, expiresAt: min(0) },
      { shareId: "after", threadId: THREAD, ownerUserId: ALICE, expiresAt: min(5) },
    ];
    const due = sharesExpiringIn(shares, NOW - 10 * 60_000, NOW).map((s) => s.shareId);
    // `on-since` is excluded because the PREVIOUS tick already emitted it;
    // `on-now` is included because the NEXT tick's `since` will be past it.
    assert.deepEqual(due, ["inside", "on-now"]);
  });

  it("emits for a share whose window closed, to the whole conversation", async () => {
    const c = makeClient({
      messages: [locationMsg("share-1", ALICE, min(-70), { expiresAt: min(-5) })],
    });
    const out = await sweepExpiredLocationShares(c, { now: new Date(NOW), since: new Date(NOW - 10 * 60_000) });
    await settle();
    assert.equal(out.expired, 1);
    assert.deepEqual(recipientsOf("location.expired"), [ALICE, BOB].sort());
    const p = firstPayload("location.expired");
    assert.equal(p.shareId, "share-1");
    assert.equal(p.ownerUserId, ALICE);
    assert.equal(p.expiredAt, min(-5));
    assert.match(String(p.eventKey), /^location\.expired:share-1$/);
  });

  it("does NOT exclude the owner — a clock performed this, not a person", async () => {
    const c = makeClient({
      messages: [locationMsg("share-1", ALICE, min(-70), { expiresAt: min(-5) })],
    });
    await sweepExpiredLocationShares(c, { now: new Date(NOW), since: new Date(NOW - 10 * 60_000) });
    await settle();
    assert.ok(recipientsOf("location.expired").includes(ALICE),
      "the sharer's own screen is the one most likely still showing it as live");
  });

  it("ignores a pin, and ignores a share still running", async () => {
    const c = makeClient({
      messages: [
        locationMsg("pin", ALICE, min(-70), {}),
        locationMsg("live", ALICE, min(-70), { expiresAt: min(60) }),
      ],
    });
    const out = await sweepExpiredLocationShares(c, { now: new Date(NOW), since: new Date(NOW - 10 * 60_000) });
    await settle();
    assert.equal(out.expired, 0);
    assert.equal(countDistinct("location.expired"), 0);
  });

  it("an UNREADABLE messages table is a FAILURE, not an empty sweep", async () => {
    const c = makeClient({ errorTable: "messages" });
    const out = await sweepExpiredLocationShares(c, { now: new Date(NOW), since: new Date(NOW - 10 * 60_000) });
    assert.equal(out.expired, 0);
    assert.equal(out.failures.length, 1);
    assert.match(out.failures[0]!, /messages/);
  });

  it("the sweep's subtype narrowing IS the payload's precision ladder", () => {
    // The sweep narrows on `subtype` to reach `idx_messages_subtype`, which is
    // the only index `messages` has that this query can use. Two copies of the
    // ladder would drift and the drift would be SILENT: a new precision would
    // produce shares the expiry sweep never looked at, and the only symptom
    // would be a live chip nothing takes down.
    const schemaValues = (LocationPayload.shape.precision as any)._def.innerType._def.values;
    assert.deepEqual([...LOCATION_PRECISIONS], [...schemaValues]);
  });

  it("a share the subtype filter would miss is not silently skipped — the filter is the ladder", async () => {
    const c = makeClient({
      messages: [locationMsg("share-1", ALICE, min(-70), { expiresAt: min(-5), precision: "exact" })],
    });
    const out = await sweepExpiredLocationShares(c, { now: new Date(NOW), since: new Date(NOW - 10 * 60_000) });
    await settle();
    assert.equal(out.expired, 1, "every precision in the ladder must be reachable by the sweep");
  });

  it("the scan is bounded by a horizon, stated rather than implied", () => {
    assert.ok(LOCATION_SWEEP_HORIZON_HOURS >= MAX_LOCATION_SHARE_HOURS,
      "a horizon shorter than the longest permitted share would silently never expire the longest shares");
  });
});

/* ─────────────────────────────── the scheduler ────────────────────────────── */

describe("the sweep runs, and a broken run does not look like an idle one", () => {
  it("a clean tick advances lastSuccessAt and the watermark", async () => {
    const c = makeClient({
      quick: [{ user_id: ALICE, status: "free_now", expires_at: min(-5) }],
      messages: [locationMsg("share-1", ALICE, min(-70), { expiresAt: min(-2) })],
    });
    const r = await tickOnce({ client: c, now: new Date(NOW) });
    await settle();
    assert.equal(r.ok, true);
    assert.equal(r.availabilityExpired, 1);
    assert.equal(r.locationExpired, 1);
    const s = getLifecycleSweepStatus();
    assert.equal(s.lastSuccessAt, s.lastRunAt);
    assert.equal(s.consecutiveFailures, 0);

    // The second tick's window starts where the first ended, so nothing is
    // re-emitted.
    deliveries = [];
    const r2 = await tickOnce({ client: c, now: new Date(NOW + 60_000) });
    await settle();
    assert.equal(r2.locationExpired, 0);
    assert.equal(r2.window!.since, new Date(NOW).toISOString());
  });

  it("a FAILED tick moves lastRunAt but NOT lastSuccessAt, and counts", async () => {
    const c = makeClient({ errorTable: "messages" });
    const r = await tickOnce({ client: c, now: new Date(NOW) });
    assert.equal(r.ok, false);
    const s = getLifecycleSweepStatus();
    assert.ok(s.lastRunAt);
    assert.equal(s.lastSuccessAt, null, "a job that could not read the table has not run successfully");
    assert.equal(s.consecutiveFailures, 1);
  });

  it("a FAILED tick does NOT advance the watermark — the broken window is retried", async () => {
    const good = makeClient({
      messages: [locationMsg("share-1", ALICE, min(-70), { expiresAt: min(-2) })],
    });
    const broken = makeClient({ errorTable: "messages" });

    // A broken tick first. Its window would have covered the share.
    await tickOnce({ client: broken, now: new Date(NOW) });
    await settle();
    deliveries = [];

    // The next tick, one minute later, must still reach back past the broken
    // one rather than starting from it.
    const r = await tickOnce({ client: good, now: new Date(NOW + 60_000) });
    await settle();
    assert.equal(r.locationExpired, 1, "the share that expired during the broken window was lost");
  });

  it("a cold start covers ONE interval, not the whole horizon", async () => {
    const c = makeClient({
      messages: [
        // Expired well before this process started. A cold start that reached
        // back to the epoch would re-announce it on every deploy.
        locationMsg("ancient", ALICE, min(-400), { expiresAt: min(-300) }),
        locationMsg("recent", ALICE, min(-70), { expiresAt: min(-1) }),
      ],
    });
    const r = await tickOnce({ client: c, now: new Date(NOW) });
    await settle();
    assert.equal(r.locationExpired, 1);
    assert.equal(firstPayload("location.expired").shareId, "recent");
    assert.equal(
      Date.parse(r.window!.now) - Date.parse(r.window!.since),
      SWEEP_INTERVAL_MS,
      "the cold-start window is exactly one interval",
    );
  });

  it("no service client is a FAILURE, not a silent skip", async () => {
    const r = await tickOnce({ client: null, now: new Date(NOW) });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.deepEqual(r.failures, ["no_service_client"]);
    assert.equal(getLifecycleSweepStatus().consecutiveFailures, 1);
  });
});
