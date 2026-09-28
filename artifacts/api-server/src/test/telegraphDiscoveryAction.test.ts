/**
 * census-discovery §81 (lane W10-S2) — A21: Telegraph registers an executable
 * action on a Discovery object. Register: D-W10S2-5.
 *
 * node:test + node:assert. Real router (`routes/telegraphCommands.ts`), fake
 * table-backed DB, no network.
 *
 * Telegraph `:607` — *"Every executable Telegraph action registers authorize,
 * preview, execute, and optional compensate behavior. Telegraph orchestrates;
 * … Discovery … retain[s] canonical business truth."* `:610` — *"Rich-card
 * actions follow tap -> command -> owning domain authorization/write"*.
 *
 * WHAT IS PINNED
 *   T1  flag OFF (the seed): the command answers `feature_disabled`, nothing is
 *       stored, and authorize refuses at confirmation too.
 *   T2  flag ON: tap → command (one `discovery_save_place`, derived from the
 *       current capability) → confirm → Discovery's OWN save writes exactly the
 *       row `POST /api/wishlist` writes, and the answer names `discovery` as
 *       the owner of the truth.
 *   T3  a place the person may not save is not OFFERED: unknown, inactive, a
 *       blocked submitter, an id Discovery does not serve, an unreadable place.
 *   T4  authorize is re-derived at confirmation: a place deactivated between
 *       the tap and the confirmation is refused and nothing is written.
 *   T5  the post-write recheck fails → compensate removes the save THIS action
 *       made, and keeps a save the person already had.
 *   T6  the owning domain's write fails → 503, not "confirmed".
 *   T7  another person cannot confirm someone's command.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/telegraphDiscoveryAction.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import telegraphCommandsRouter from "../routes/telegraphCommands.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { registrationFor, TELEGRAPH_DISCOVERY_ACTIONS_FLAG } from "../services/telegraph/actionRegistry.js";

const ALICE = "alice-0000";
const BOB = "bob-0000";
const PLACE = "11111111-2222-4333-8444-555555555555";
const SUBMITTER = "submitter-0000";

type Rows = Record<string, Array<Record<string, unknown>>>;

let server: http.Server;
let base = "";
let tables: Rows = {};

function stage(opts: {
  flag: boolean;
  place?: Record<string, unknown> | null;
  blocks?: Array<Record<string, unknown>>;
  saves?: Array<Record<string, unknown>>;
  failures?: Record<string, { message: string }>;
  /** Turn the capability off right after the canonical write — the §30A.11 race. */
  flagOffAfterWrite?: boolean;
  /** Deactivate the place right after the command is proposed. */
  deactivateAfterPropose?: boolean;
}) {
  tables = {
    feature_flags: opts.flag ? [{ flag: TELEGRAPH_DISCOVERY_ACTIONS_FLAG, enabled: true }] : [],
    discovery_places: opts.place === null ? [] : [{ id: PLACE, status: "active", submitted_by: SUBMITTER, name: "Night Market", ...(opts.place ?? {}) }],
    blocks: opts.blocks ?? [],
    wishlist_places: opts.saves ?? [],
    user_preference_events: [],
  };
  const fake = makeLayoverDb(tables, { users: { [ALICE]: ALICE, [BOB]: BOB }, failures: opts.failures ?? {} });
  const from = fake.from.bind(fake);
  let wrote = false;
  fake.from = (t: string) => {
    if (t === "feature_flags" && wrote && opts.flagOffAfterWrite) tables.feature_flags!.length = 0;
    const q = from(t);
    if (t === "wishlist_places") {
      const up = q.upsert.bind(q);
      q.upsert = (...a: unknown[]) => { wrote = true; return up(...a); };
    }
    return q;
  };
  _setTestClient(fake, true);
  return {
    client: fake as unknown as import("@supabase/supabase-js").SupabaseClient,
    deactivate: () => { for (const p of tables.discovery_places ?? []) p.status = "removed"; },
  };
}

function send(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api${path}`, base);
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (raw !== null) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(raw)); }
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let acc = ""; res.setEncoding("utf8");
      res.on("data", (c) => { acc += c; });
      res.on("end", () => { let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    r.on("error", reject);
    if (raw !== null) r.write(raw);
    r.end();
  });
}

const CARD = { placeId: PLACE, title: "Night Market", category: "food", type: "market", city: "Taipei" };

async function propose(token = ALICE, card: Record<string, unknown> = CARD) {
  return send(token, "POST", "/telegraph/commands/discovery-card", card);
}
async function confirm(token: string, commandId: string, actionId: string) {
  return send(token, "POST", `/telegraph/commands/${commandId}/confirm-action`, { actionId });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { Object.assign(r, { log: { error() {}, info() {}, warn() {}, debug() {} } }); next(); });
  app.use("/api", telegraphCommandsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
});
after(() => { server?.close(); _setTestClient(null, false); });

describe("T1 — flag OFF (the seed)", () => {
  it("the command is not available and nothing is stored or written", async () => {
    stage({ flag: false });
    const r = await propose();
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(tables.wishlist_places?.length, 0);
  });

  it("authorize itself refuses while the flag is off", async () => {
    const { client } = stage({ flag: false });
    const reg = registrationFor("discovery_save_place");
    assert.ok(reg, "discovery_save_place must be registered");
    const a = await reg!.authorize({
      client, userId: ALICE, tripId: null, commandId: "cmd", actionId: "cmd_a1",
      label: "Save", params: { placeId: PLACE }, category: "food",
    });
    assert.equal(a.authorized, false);
  });
});

describe("T2 — flag ON: tap → command → owning-domain write", () => {
  it("one proposed action, then Discovery's own save, then the owner named", async () => {
    stage({ flag: true });
    const p = await propose();
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.proposedActions.length, 1);
    assert.equal(p.body.proposedActions[0].kind, "discovery_save_place");
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.confirmed, true);
    assert.equal(c.body.orchestration.canonicalOwner.domain, "discovery");
    assert.match(c.body.orchestration.preview, /Night Market/);
    const rows = tables.wishlist_places ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, ALICE);
    assert.equal(rows[0]!.place_id, PLACE);
    assert.equal(rows[0]!.list_id, "global");
    assert.deepEqual(rows[0]!.place_data, { id: PLACE, name: "Night Market", category: "food", type: "market", address: "Taipei" },
      "the payload is the client card's own Save payload");
    assert.equal((tables.user_preference_events ?? []).length, 0, "no Telegraph-owned write stands in for the canonical one");
  });

  it("an OSM element id is saveable too (no curated row to check)", async () => {
    stage({ flag: true, place: null });
    const p = await propose(ALICE, { placeId: "node/4242", title: "Pier" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 200);
    assert.equal(tables.wishlist_places?.[0]?.place_id, "node/4242");
  });
});

describe("T3 — a place the person may not save is not offered", () => {
  for (const [name, opts, card] of [
    ["an unknown place", { flag: true, place: null }, CARD],
    ["an inactive place", { flag: true, place: { status: "removed" } }, CARD],
    ["a submitter the person blocked", { flag: true, blocks: [{ blocker_id: ALICE, blocked_id: SUBMITTER }] }, CARD],
    ["a submitter who blocked the person", { flag: true, blocks: [{ blocker_id: SUBMITTER, blocked_id: ALICE }] }, CARD],
    ["an id Discovery does not serve", { flag: true }, { placeId: "db/not-a-uuid" }],
    ["an unreadable discovery_places", { flag: true, failures: { "discovery_places:select": { message: "down" } } }, CARD],
  ] as const) {
    it(name, async () => {
      stage(opts);
      const r = await propose(ALICE, card);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(tables.wishlist_places?.length, 0);
    });
  }
});

describe("T4 — authorize is re-derived at confirmation", () => {
  it("a place deactivated after the tap is refused, and nothing is written", async () => {
    const s = stage({ flag: true });
    const p = await propose();
    assert.equal(p.status, 201);
    s.deactivate();
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 403, JSON.stringify(c.body));
    assert.equal(tables.wishlist_places?.length, 0);
  });
});

describe("T5 — the recheck fails after the write: compensate", () => {
  it("removes the save THIS action created", async () => {
    stage({ flag: true, flagOffAfterWrite: true });
    const p = await propose();
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.equal(c.body.compensated, true);
    assert.equal(c.body.compensation.undone, true);
    assert.equal(tables.wishlist_places?.length, 0, "the save survived the compensate");
  });

  it("keeps a save the person already had", async () => {
    const prior = { user_id: ALICE, place_id: PLACE, list_id: "global", place_data: { id: PLACE, name: "Mine" }, saved_at: "2026-09-01T00:00:00.000Z" };
    stage({ flag: true, flagOffAfterWrite: true, saves: [prior] });
    const p = await propose();
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.equal(tables.wishlist_places?.length, 1, "a save the person already had was removed");
    assert.match(c.body.compensation.what, /already saved/);
  });
});

describe("T6 — the owning domain's write fails", () => {
  it("503, not confirmed", async () => {
    stage({ flag: true, failures: { "wishlist_places:upsert": { message: "down" } } });
    const p = await propose();
    const c = await confirm(ALICE, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 503, JSON.stringify(c.body));
    assert.notEqual(c.body.confirmed, true);
  });
});

describe("T7 — cross-user", () => {
  it("Bob cannot confirm Alice's command", async () => {
    stage({ flag: true });
    const p = await propose(ALICE);
    const c = await confirm(BOB, p.body.commandId, p.body.proposedActions[0].id);
    assert.equal(c.status, 403);
    assert.equal(tables.wishlist_places?.length, 0);
  });
});
