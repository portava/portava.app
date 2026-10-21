/**
 * §3.6 `memory_visibility_policies` — "Audience and location precision policy"
 * (migration 3997, census H33), and §28.7 "Never allow public location
 * precision above the owner's publication policy".
 *
 * What is asserted:
 *   - the owner sets, reads and clears a ceiling per audience, for themself only;
 *   - every non-owner Memory read honours it, composed STRICTER-WINS with the
 *     Memory's own rung (2338) — neither can widen the other;
 *   - it is audience-specific: a ceiling for followers does not touch a public
 *     Memory;
 *   - a policy that cannot be read, or a flag that cannot be read, clamps to
 *     hidden; a flag that is off is today's behaviour exactly;
 *   - the owner is never clamped.
 *
 * Run: node --import tsx/esm --test src/test/memoryVisibilityPolicies.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import policyRouter from "../routes/memoryVisibilityPolicies.js";
import {
  audienceCeilingFor,
  audienceOfVisibility,
  loadAudienceCeilings,
  withAudienceCeiling,
} from "../services/memory/memoryVisibilityPolicies.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LAT = 16.0544;
const LNG = 108.2022;
const FLAG = "memory_visibility_policies_enabled";
const POLICY = "memory_visibility_policies";

interface Store {
  [table: string]: any[];
}
interface Opts {
  failTables?: Set<string>;
  throwTables?: Set<string>;
  /** An upsert that resolves with no row (an unconfirmed write). */
  swallowWrites?: boolean;
}

function makeClient(store: Store, opts: Opts = {}) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const described: string[] = [];
    let mode: "read" | "upsert" | "delete" | "update" | "insert" = "read";
    let payload: any = null;
    let conflict: string[] = [];
    let single = false;
    let head = false;
    let selectedAfterWrite = false;
    const obj: any = {
      select(_c?: string, o?: any) { if (mode !== "read") selectedAfterWrite = true; head = o?.head === true; return obj; },
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; conflict = String(o?.onConflict ?? "id").split(","); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq(c: string, v: any) { described.push(`${c}=${v}`); filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { described.push(`${c} in ${vs.join(",")}`); filters.push((r) => vs.includes(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      contains() { return obj; }, not() { return obj; }, or() { return obj; }, filter() { return obj; },
      ilike() { return obj; }, order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (opts.throwTables?.has(table)) throw new Error(`${table} exploded`);
      if (opts.failTables?.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (store[table] ??= []);
      if (mode === "read") reads.push({ table, filters: described });
      if (mode === "upsert" || mode === "insert") {
        if (opts.swallowWrites) return { data: [], error: null, count: 0 };
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const out: any[] = [];
        for (const r of rows) {
          const existing = mode === "upsert" ? all.find((e) => conflict.every((c) => e[c] === r[c])) : undefined;
          if (existing) { Object.assign(existing, r); out.push(existing); } else { all.push(r); out.push(r); }
        }
        return { data: single ? out[0] : out, error: null, count: out.length };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        store[table] = all.filter((r) => !matched.includes(r));
        return { data: selectedAfterWrite ? matched : null, error: null, count: matched.length };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return { data: selectedAfterWrite ? matched : null, error: null, count: matched.length };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: matched.length };
      return { data: head ? null : matched, error: null, count: matched.length };
    }
    return obj;
  }
  return {
    reads,
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "no rpc here" } }),
    auth: {
      getUser: async (t: string) => {
        const id = ({ "owner-tok": OWNER, "viewer-tok": VIEWER } as Record<string, string>)[t];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "no" } };
      },
    },
  };
}

function world(over: { visibility?: string; rung?: string; precisionGate?: boolean; policyOn?: boolean; policies?: any[] } = {}): Store {
  const mem: any = {
    id: MEM, owner_id: OWNER, title: "Dinner by the river", caption: null,
    visibility: over.visibility ?? "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: "fsq-river-house",
    location_city: "Da Nang", location_country: "Vietnam",
    location_lat: LAT, location_lng: LNG, canonical_location_id: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
  if (over.rung !== undefined) mem.location_precision = over.rung;
  const flags: any[] = [];
  if (over.precisionGate) flags.push({ flag: "memory_location_precision_enabled", enabled: true });
  if (over.policyOn !== false) flags.push({ flag: FLAG, enabled: over.policyOn ?? true });
  return {
    memories: [mem],
    memory_items: [],
    memory_tags: [],
    memory_likes: [],
    memory_saves: [],
    blocks: [],
    feature_flags: flags,
    [POLICY]: over.policies ?? [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
    ],
  };
}

async function startApp(store: Store, opts: Opts = {}) {
  const client = makeClient(store, opts);
  _setTestClient(client as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", policyRouter);
  app.use("/api", memoriesRouter);
  return new Promise<{ base: string; client: ReturnType<typeof makeClient>; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        base: `http://127.0.0.1:${port}`, client,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function call(base: string, method: string, path: string, tok: string, body?: unknown) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { connection: "close", Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const memoryOf = (b: any) => b?.memory ?? null;

/* ═══════════════════════════════════════════════════════════════════════════
 * The pure reader
 * ═════════════════════════════════════════════════════════════════════════ */

describe("H33 the policy reader: audience mapping and fail-closed states", () => {
  it("maps each stored audience to the policy audience it is published to", () => {
    assert.equal(audienceOfVisibility("public"), "public");
    assert.equal(audienceOfVisibility("friends_only"), "followers");
    assert.equal(audienceOfVisibility("trip_crew"), "trip_crew");
    assert.equal(audienceOfVisibility("circle_only"), "selected_people");
    assert.equal(audienceOfVisibility("custom"), "selected_people");
    assert.equal(audienceOfVisibility("only_me"), null);
    assert.equal(audienceOfVisibility("everyone!"), undefined);
  });

  it("off is no constraint, unreadable is hidden, and an unknown audience is hidden", () => {
    const row = { owner_id: OWNER, visibility: "public" };
    assert.equal(audienceCeilingFor({ state: "off" }, row), "exact");
    assert.equal(audienceCeilingFor(undefined, row), "exact");
    assert.equal(audienceCeilingFor({ state: "unreadable" }, row), "hidden");
    const on = { state: "on" as const, byOwner: new Map([[OWNER, { public: "city" as const }]]) };
    assert.equal(audienceCeilingFor(on, row), "city");
    assert.equal(audienceCeilingFor(on, { owner_id: OWNER, visibility: "friends_only" }), "exact", "no ceiling for that audience");
    assert.equal(audienceCeilingFor(on, { owner_id: OWNER, visibility: "mystery" }), "hidden");
    assert.equal(audienceCeilingFor(on, { owner_id: VIEWER, visibility: "public" }), "exact", "another owner's policy never applies");
  });

  it("composes stricter-wins: the policy never widens the Memory's own rung, and the rung never widens the policy", () => {
    const on = { state: "on" as const, byOwner: new Map([[OWNER, { public: "city" as const }]]) };
    const row = { owner_id: OWNER, visibility: "public" };
    assert.equal(withAudienceCeiling("exact", on, row), "city");
    assert.equal(withAudienceCeiling("country", on, row), "country");
    assert.equal(withAudienceCeiling("hidden", on, row), "hidden");
  });

  it("reads only the owners on the page, and only while the flag is on", async () => {
    const store = world({ policies: [{ owner_id: OWNER, audience: "public", location_precision: "city" }] });
    const c = makeClient(store);
    const on = await loadAudienceCeilings(c, [{ owner_id: OWNER }, { owner_id: OWNER }]);
    assert.equal(on.state, "on");
    const policyReads = c.reads.filter((r) => r.table === POLICY);
    assert.deepEqual(policyReads.map((r) => r.filters), [[`owner_id in ${OWNER}`]]);

    const offStore = world({ policyOn: false, policies: [{ owner_id: OWNER, audience: "public", location_precision: "city" }] });
    const c2 = makeClient(offStore);
    assert.deepEqual(await loadAudienceCeilings(c2, [{ owner_id: OWNER }]), { state: "off" });
    assert.equal(c2.reads.filter((r) => r.table === POLICY).length, 0, "a dark feature never touches the table");
  });

  it("a stored rung off the ladder is hidden, never exact", async () => {
    const store = world({ policies: [{ owner_id: OWNER, audience: "public", location_precision: "EXACT" }] });
    const ceilings = await loadAudienceCeilings(makeClient(store), [{ owner_id: OWNER }]);
    assert.equal(audienceCeilingFor(ceilings, { owner_id: OWNER, visibility: "public" }), "hidden");
  });

  it("a failed or throwing policy read, or an unreadable flag, is 'unreadable' (clamp), never 'no policy'", async () => {
    const store = world();
    assert.deepEqual(await loadAudienceCeilings(makeClient(store, { failTables: new Set([POLICY]) }), [{ owner_id: OWNER }]), { state: "unreadable" });
    assert.deepEqual(await loadAudienceCeilings(makeClient(store, { throwTables: new Set([POLICY]) }), [{ owner_id: OWNER }]), { state: "unreadable" });
    assert.deepEqual(await loadAudienceCeilings(makeClient(store, { failTables: new Set(["feature_flags"]) }), [{ owner_id: OWNER }]), { state: "unreadable" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Every non-owner read honours it
 * ═════════════════════════════════════════════════════════════════════════ */

describe("H33 GET /memories/:id — a non-owner never sees finer than the owner's audience ceiling", () => {
  it("public ceiling 'city': no exact coordinate and no place id for a non-owner; the owner keeps theirs", async () => {
    const app = await startApp(world({ policies: [{ owner_id: OWNER, audience: "public", location_precision: "city" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.ok(viewer, "the Memory is still served");
      assert.notEqual(viewer.locationLat, LAT);
      assert.notEqual(viewer.locationLng, LNG);
      assert.equal(viewer.locationCity, "Da Nang");
      assert.equal(viewer.placeId ?? null, null, "a venue id is a location at venue precision");
      const owner = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "owner-tok")).body);
      assert.equal(owner.locationLat, LAT, "the owner is never clamped by their own policy");
      assert.equal(owner.locationLng, LNG);
    } finally { await app.close(); }
  });

  it("public ceiling 'hidden' applies even with the per-Memory precision gate OFF", async () => {
    const app = await startApp(world({ precisionGate: false, policies: [{ owner_id: OWNER, audience: "public", location_precision: "hidden" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationLat, null);
      assert.equal(viewer.locationLng, null);
      assert.equal(viewer.locationCity, null);
      assert.equal(viewer.locationCountry, null);
    } finally { await app.close(); }
  });

  it("is audience-specific: a followers ceiling does not touch a public Memory", async () => {
    const app = await startApp(world({ policies: [{ owner_id: OWNER, audience: "followers", location_precision: "hidden" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationLat, LAT);
      assert.equal(viewer.locationCity, "Da Nang");
    } finally { await app.close(); }
  });

  it("stricter wins against the Memory's own rung: rung 'city' + ceiling 'country' => country only", async () => {
    const app = await startApp(world({ precisionGate: true, rung: "city", policies: [{ owner_id: OWNER, audience: "public", location_precision: "country" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationCity, null);
      assert.equal(viewer.locationCountry, "Vietnam");
    } finally { await app.close(); }
  });

  it("and the policy cannot widen the rung: rung 'country' + ceiling 'city' => country only", async () => {
    const app = await startApp(world({ precisionGate: true, rung: "country", policies: [{ owner_id: OWNER, audience: "public", location_precision: "city" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationCity, null);
      assert.equal(viewer.locationCountry, "Vietnam");
    } finally { await app.close(); }
  });

  it("an unreadable policy clamps a non-owner to hidden (fail closed)", async () => {
    const app = await startApp(world({ policies: [] }), { failTables: new Set([POLICY]) });
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationLat, null);
      assert.equal(viewer.locationCity, null);
      const owner = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "owner-tok")).body);
      assert.equal(owner.locationLat, LAT);
    } finally { await app.close(); }
  });

  it("flag off: the stored policy is not consulted — today's behaviour exactly", async () => {
    const app = await startApp(world({ policyOn: false, policies: [{ owner_id: OWNER, audience: "public", location_precision: "hidden" }] }));
    try {
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationLat, LAT);
      assert.equal(viewer.locationCity, "Da Nang");
    } finally { await app.close(); }
  });
});

describe("H33 GET /users/:userId/memories — the list door honours it too", () => {
  it("public ceiling 'country' => the profile list serves country only", async () => {
    const app = await startApp(world({ policies: [{ owner_id: OWNER, audience: "public", location_precision: "country" }] }));
    try {
      const r = await call(app.base, "GET", `/users/${OWNER}/memories`, "viewer-tok");
      assert.equal(r.status, 200);
      const [m] = r.body.memories;
      assert.ok(m, "the Memory is listed");
      assert.equal(m.locationCity, null);
      assert.equal(m.locationLat, null);
      assert.equal(m.locationCountry, "Vietnam");
    } finally { await app.close(); }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The owner's writer
 * ═════════════════════════════════════════════════════════════════════════ */

describe("H33 /me/memory-visibility-policy — the owner sets, reads and clears their own ceilings", () => {
  it("PUT then GET round-trips, written under the signed-in owner only", async () => {
    const store = world();
    const app = await startApp(store);
    try {
      const put = await call(app.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "city" });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, { audience: "public", locationPrecision: "city" });
      assert.deepEqual(store[POLICY].map((r) => [r.owner_id, r.audience, r.location_precision]), [[OWNER, "public", "city"]]);
      const get = await call(app.base, "GET", "/me/memory-visibility-policy", "owner-tok");
      assert.equal(get.status, 200);
      assert.deepEqual(get.body.policy, { public: "city", followers: null, trip_crew: null, selected_people: null });
      const theirs = await call(app.base, "GET", "/me/memory-visibility-policy", "viewer-tok");
      assert.deepEqual(theirs.body.policy, { public: null, followers: null, trip_crew: null, selected_people: null }, "another person never reads it");
    } finally { await app.close(); }
  });

  it("a set ceiling reaches the next non-owner read", async () => {
    const app = await startApp(world());
    try {
      assert.equal((await call(app.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "hidden" })).status, 200);
      const viewer = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(viewer.locationCity, null);
      assert.equal((await call(app.base, "DELETE", "/me/memory-visibility-policy/public", "owner-tok")).body.cleared, true);
      const again = memoryOf((await call(app.base, "GET", `/memories/${MEM}`, "viewer-tok")).body);
      assert.equal(again.locationCity, "Da Nang", "cleared = no ceiling");
    } finally { await app.close(); }
  });

  it("refuses an audience or a rung off the list, and writes nothing", async () => {
    const store = world();
    const app = await startApp(store);
    try {
      assert.equal((await call(app.base, "PUT", "/me/memory-visibility-policy/private", "owner-tok", { locationPrecision: "city" })).status, 400);
      assert.equal((await call(app.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "EXACT" })).status, 400);
      assert.equal((await call(app.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "city", ownerId: VIEWER })).status, 400, "no owner id is taken from the body");
      assert.equal(store[POLICY].length, 0);
    } finally { await app.close(); }
  });

  it("an unconfirmed write is a refusal, not a success", async () => {
    const app = await startApp(world(), { swallowWrites: true });
    try {
      const put = await call(app.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "city" });
      assert.equal(put.status, 503);
    } finally { await app.close(); }
  });

  it("flag off answers feature_disabled; an unreadable flag or table answers 503, never an empty policy", async () => {
    const off = await startApp(world({ policyOn: false }));
    try {
      assert.equal((await call(off.base, "GET", "/me/memory-visibility-policy", "owner-tok")).status, 404);
      assert.equal((await call(off.base, "PUT", "/me/memory-visibility-policy/public", "owner-tok", { locationPrecision: "city" })).status, 404);
    } finally { await off.close(); }
    const flagDown = await startApp(world(), { failTables: new Set(["feature_flags"]) });
    try {
      assert.equal((await call(flagDown.base, "GET", "/me/memory-visibility-policy", "owner-tok")).status, 503);
    } finally { await flagDown.close(); }
    const tableDown = await startApp(world(), { failTables: new Set([POLICY]) });
    try {
      assert.equal((await call(tableDown.base, "GET", "/me/memory-visibility-policy", "owner-tok")).status, 503);
    } finally { await tableDown.close(); }
  });
});
