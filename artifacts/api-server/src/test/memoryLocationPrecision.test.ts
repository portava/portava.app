/**
 * §10 / §23 — the owner's location precision is a ceiling on publication.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §4  LocationPrecision = EXACT, VENUE, NEIGHBORHOOD, CITY, COUNTRY, HIDDEN
 *   §10 "Publishing location must never exceed the owner's selected precision."
 *   §23 "Exact location and private notes require tighter policies than
 *        public-safe summary data."  /  canSeeExactLocation(userId, memoryId)
 *
 * Before migration 2338 a Memory's stored coordinate reached every permitted
 * viewer at full precision. The only clamp on the path was the Hidden-Gem
 * ceiling, which asks a question about the PLACE ("is a protected gem here?").
 * §10 asks a question about the OWNER ("how precisely may this be published?").
 * A Memory at an ordinary address had no answer to the second question at all.
 *
 * WHY MOST OF THIS FILE EXERCISES THE FLAG IN BOTH POSITIONS
 * ----------------------------------------------------------
 * `memory_location_precision_enabled` is a SCHEMA-PRESENCE gate, not a rollout
 * dial: production has not run 2338 and one unknown column fails an entire
 * PostgREST statement. So "flag off behaves exactly as before" is not a nicety,
 * it is the property that keeps the 80 live production Memories readable, and
 * it is asserted here rather than assumed.
 *
 * Run: node --import tsx/esm --test src/test/memoryLocationPrecision.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import {
  normalizeMemoryPrecision,
  normalizeMemoryPrecisionForWrite,
  publicationPrecision,
  isMemoryLocationPrecision,
  stricterPrecision,
  precisionToMediaTier,
  canSeeExactLocation,
  resolveMemoryLocationCeiling,
  MEMORY_LOCATION_PRECISIONS,
  MEMORY_LOCATION_PRECISION_SCHEMA_DEFAULT,
} from "../lib/memoryLocationPrecision.js";

const OWNER  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEM    = "11111111-1111-1111-1111-111111111111";

// Somewhere unambiguous, with enough decimals that a coarsened value is
// obviously not the stored one.
const LAT = 16.047079;
const LNG = 108.20623;

// ── The ladder itself ────────────────────────────────────────────────────────

describe("§4 LocationPrecision — the ladder", () => {
  it("carries exactly the spec's six rungs, in the spec's order", () => {
    assert.deepEqual([...MEMORY_LOCATION_PRECISIONS],
      ["exact", "venue", "neighborhood", "city", "country", "hidden"]);
  });

  it("treats an UNSELECTED column as 'exact', and NULL / EMPTY / CORRUPT as 'hidden'", () => {
    // Only `undefined` — the column was not selected, because the flag is off
    // and the database may not have it — resolves to the status quo 'exact'.
    // A SELECTED column that is null or empty cannot happen on a database with
    // 2338 (NOT NULL DEFAULT 'exact' stamps every pre-existing row), so it is an
    // anomaly, and an anomaly in a privacy control must not widen disclosure.
    assert.equal(normalizeMemoryPrecision(undefined), "exact");
    assert.equal(normalizeMemoryPrecision(null), "hidden", "a selected-but-null rung is a defect, read privately");
    assert.equal(normalizeMemoryPrecision(""), "hidden");
    assert.equal(normalizeMemoryPrecision("EXACT"), "hidden", "the ladder is lowercase; a near-miss is not a match");
    assert.equal(normalizeMemoryPrecision("street"), "hidden");
    assert.equal(normalizeMemoryPrecision(7), "hidden");
    for (const rung of MEMORY_LOCATION_PRECISIONS) assert.equal(normalizeMemoryPrecision(rung), rung);
  });

  it("publicationPrecision: gate off is the status quo; gate on never serves an unreadable policy as 'exact'", () => {
    // Gate OFF: the column is not named in the request. Whatever the row
    // carries (or does not), the pre-2338 behaviour is reproduced exactly.
    assert.equal(publicationPrecision({}, false), "exact");
    assert.equal(publicationPrecision({ location_precision: "hidden" }, false), "exact");
    assert.equal(publicationPrecision(null, false), "exact");
    // Gate ON: the row's rung, faithfully…
    for (const rung of MEMORY_LOCATION_PRECISIONS) {
      assert.equal(publicationPrecision({ location_precision: rung }, true), rung);
    }
    // …and 'hidden' whenever the rung is unavailable: absent key, null, junk.
    assert.equal(publicationPrecision({}, true), "hidden", "a reader that forgot to select the column must not leak exact");
    assert.equal(publicationPrecision({ location_precision: null }, true), "hidden");
    assert.equal(publicationPrecision({ location_precision: "" }, true), "hidden");
    assert.equal(publicationPrecision({ location_precision: "EXACT" }, true), "hidden");
    assert.equal(publicationPrecision(null, true), "hidden");
    assert.equal(publicationPrecision(undefined, true), "hidden");
  });

  it("write-side normalization names only a ladder value, and never substitutes a default of its own", () => {
    for (const rung of MEMORY_LOCATION_PRECISIONS) assert.equal(normalizeMemoryPrecisionForWrite(rung), rung);
    assert.equal(normalizeMemoryPrecisionForWrite(undefined), undefined);
    assert.equal(normalizeMemoryPrecisionForWrite(null), undefined, "null is 'say nothing', not 'write hidden' and not 'write exact'");
    assert.equal(normalizeMemoryPrecisionForWrite(""), undefined);
    assert.equal(normalizeMemoryPrecisionForWrite("EXACT"), undefined);
    assert.equal(normalizeMemoryPrecisionForWrite("street"), undefined);
    assert.equal(isMemoryLocationPrecision("venue"), true);
    assert.equal(isMemoryLocationPrecision("Venue"), false);
  });

  it("the schema DEFAULT the code mirrors is the one migration 2338 actually wrote", () => {
    // If the owner changes the DEFAULT (a decision this file does not take),
    // the constant must move with it, or the two describe different systems.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(path.join(here, "..", "migrations", "2338_memory_location_precision.sql"), "utf8");
    const m = sql.match(/ADD COLUMN IF NOT EXISTS location_precision text NOT NULL DEFAULT '([a-z_]+)'/);
    assert.ok(m, "2338 must declare the column with an explicit DEFAULT");
    assert.equal(m![1], MEMORY_LOCATION_PRECISION_SCHEMA_DEFAULT);
    assert.ok(isMemoryLocationPrecision(MEMORY_LOCATION_PRECISION_SCHEMA_DEFAULT));
  });

  it("stricterPrecision never widens", () => {
    assert.equal(stricterPrecision("exact", "city"), "city");
    assert.equal(stricterPrecision("city", "exact"), "city");
    assert.equal(stricterPrecision("country", "hidden"), "hidden");
    assert.equal(stricterPrecision("venue", "venue"), "venue");
  });

  it("maps 'exact' to no constraint and every other rung to a media tier", () => {
    assert.equal(precisionToMediaTier("exact"), null);
    assert.equal(precisionToMediaTier("venue"), "place");
    assert.equal(precisionToMediaTier("neighborhood"), "neighborhood");
    assert.equal(precisionToMediaTier("city"), "city");
    assert.equal(precisionToMediaTier("country"), "country");
    assert.equal(precisionToMediaTier("hidden"), "hidden");
  });
});

// ── §23 canSeeExactLocation ──────────────────────────────────────────────────

describe("§23 canSeeExactLocation(userId, memoryId)", () => {
  it("is always true for the owner, whatever rung they chose", () => {
    for (const p of MEMORY_LOCATION_PRECISIONS) {
      assert.equal(canSeeExactLocation(OWNER, { owner_id: OWNER, location_precision: p }), true, p);
    }
  });

  it("is false for a non-owner when the rung is null or empty — a defect reads privately", () => {
    assert.equal(canSeeExactLocation(VIEWER, { owner_id: OWNER, location_precision: null }), false);
    assert.equal(canSeeExactLocation(VIEWER, { owner_id: OWNER, location_precision: "" }), false);
    assert.equal(canSeeExactLocation(OWNER, { owner_id: OWNER, location_precision: null }), true, "the owner always can");
  });

  it("is true for a non-owner only at 'exact'", () => {
    assert.equal(canSeeExactLocation(VIEWER, { owner_id: OWNER, location_precision: "exact" }), true);
    for (const p of ["venue", "neighborhood", "city", "country", "hidden"]) {
      assert.equal(canSeeExactLocation(VIEWER, { owner_id: OWNER, location_precision: p }), false, p);
    }
  });

  it("is false for an anonymous viewer and for a missing memory", () => {
    assert.equal(canSeeExactLocation(null, { owner_id: OWNER, location_precision: "venue" }), false);
    assert.equal(canSeeExactLocation(VIEWER, null), false);
    assert.equal(canSeeExactLocation(null, null), false);
  });
});

// ── Composition with the Hidden-Gem ceiling ──────────────────────────────────

describe("§10 — the effective ceiling is the STRICTER of owner policy and gem ceiling", () => {
  it("returns null (serve unchanged) only when neither constrains", () => {
    assert.equal(resolveMemoryLocationCeiling("exact", null), null);
  });

  it("uses the gem ceiling when the owner set none", () => {
    assert.equal(resolveMemoryLocationCeiling("exact", "city"), "city");
  });

  it("uses the owner's rung when there is no gem", () => {
    assert.equal(resolveMemoryLocationCeiling("country", null), "country");
  });

  it("never lets one widen the other", () => {
    // A permissive owner rung cannot loosen a gem ceiling …
    assert.equal(resolveMemoryLocationCeiling("venue", "city"), "city");
    // … and a permissive gem ceiling cannot loosen the owner's rung.
    assert.equal(resolveMemoryLocationCeiling("country", "neighborhood"), "country");
    assert.equal(resolveMemoryLocationCeiling("hidden", "city"), "hidden");
  });
});

// ── Route behaviour ──────────────────────────────────────────────────────────

interface State {
  memories: any[]; blocks: any[]; feature_flags: any[]; profiles: any[];
  /** Every insert payload the route sent, per table — the wire shape under test. */
  inserts: Array<{ table: string; payload: any }>;
}

function makeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: any = null;
    let pendingInsert: any = null;
    let countMode = false;
    const builder: any = {
      select(_c?: string, o?: any) { if (o?.count === "exact" && o?.head) countMode = true; return builder; },
      update(p: any) { pendingUpdate = p; return builder; },
      insert(p: any) { pendingInsert = p; state.inserts.push({ table, payload: p }); return builder; },
      upsert() { return builder; }, delete() { return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      lt() { return builder; }, gt() { return builder; }, is() { return builder; },
      not() { return builder; }, order() { return builder; }, limit() { return builder; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    async function resolve(single: boolean) {
      if (pendingInsert) {
        const row = { id: "new-row", created_at: "2026-01-01T00:00:00.000Z", ...pendingInsert };
        const arr: any[] | undefined = (state as any)[table];
        if (Array.isArray(arr)) arr.push(row);
        return { data: single ? row : [row], error: null, count: 1 };
      }
      const src: any[] = (state as any)[table] ?? [];
      const rows = src.filter((r) => filters.every((f) => f(r)));
      if (pendingUpdate) { rows.forEach((r) => Object.assign(r, pendingUpdate)); }
      if (countMode) return { data: null, error: null, count: rows.length };
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    }
    return builder;
  }
  return {
    from,
    async rpc() { return { data: [], error: null }; },
    auth: {
      getUser: async (t: string) => {
        const map: Record<string, string> = { "owner-tok": OWNER, "viewer-tok": VIEWER };
        const id = map[t];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "no" } };
      },
    },
  };
}

function stateWith(precision: string | undefined, flagOn: boolean): State {
  const mem: any = {
    id: MEM, owner_id: OWNER, title: "Dinner", caption: null,
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null,
    location_city: "Da Nang", location_country: "Vietnam",
    location_lat: LAT, location_lng: LNG, canonical_location_id: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
  if (precision !== undefined) mem.location_precision = precision;
  return {
    memories: [mem],
    blocks: [],
    inserts: [],
    feature_flags: flagOn ? [{ flag: "memory_location_precision_enabled", enabled: true }] : [],
    profiles: [
      { id: OWNER,  account_status: "active", name: "Owner",  handle: "owner",  avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
    ],
  };
}

async function startApp(state: State) {
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; state: State; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, state,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

/** The serialized shape mapMemory() emits, narrowed to what this file asserts. */
interface MemoryView {
  locationLat: number | null;
  locationLng: number | null;
  locationCity: string | null;
  locationCountry: string | null;
  locationPrecision?: string;
}
interface MemoryBody { memory?: MemoryView }

async function getMemory(base: string, tok: string): Promise<{ status: number; body: MemoryBody | null }> {
  const res = await fetch(`${base}/api/memories/${MEM}`, {
    headers: { connection: "close", Authorization: `Bearer ${tok}` },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as MemoryBody | null };
}

describe("GET /memories/:id — publication never exceeds the owner's rung", () => {
  it("serves the exact stored coordinate to a non-owner at 'exact' (the status quo)", async () => {
    const app = await startApp(stateWith("exact", true));
    try {
      const { body } = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(body?.memory?.locationLat, LAT);
      assert.equal(body?.memory?.locationLng, LNG);
    } finally { await app.close(); }
  });

  it("never serves the exact coordinate to a non-owner at 'city'", async () => {
    const app = await startApp(stateWith("city", true));
    try {
      const { body } = await getMemory(app.baseUrl, "viewer-tok");
      const m = body?.memory;
      assert.notEqual(m?.locationLat, LAT, "the stored latitude must not survive a city-level rung");
      assert.notEqual(m?.locationLng, LNG, "the stored longitude must not survive a city-level rung");
      assert.equal(m?.locationCity, "Da Nang", "city level still discloses the city");
      assert.equal(m?.locationCountry, "Vietnam");
    } finally { await app.close(); }
  });

  it("discloses no location at all at 'hidden'", async () => {
    const app = await startApp(stateWith("hidden", true));
    try {
      const { body } = await getMemory(app.baseUrl, "viewer-tok");
      const m = body?.memory;
      assert.equal(m?.locationLat, null);
      assert.equal(m?.locationLng, null);
      assert.equal(m?.locationCity, null);
      assert.equal(m?.locationCountry, null);
    } finally { await app.close(); }
  });

  it("keeps only the country at 'country'", async () => {
    const app = await startApp(stateWith("country", true));
    try {
      const { body } = await getMemory(app.baseUrl, "viewer-tok");
      const m = body?.memory;
      assert.equal(m?.locationCountry, "Vietnam");
      assert.equal(m?.locationCity, null, "country level must not disclose the city");
      assert.notEqual(m?.locationLat, LAT);
    } finally { await app.close(); }
  });

  it("always gives the OWNER their own exact coordinate, whatever the rung", async () => {
    for (const rung of ["hidden", "country", "city", "venue"]) {
      const app = await startApp(stateWith(rung, true));
      try {
        const { body } = await getMemory(app.baseUrl, "owner-tok");
        assert.equal(body?.memory?.locationLat, LAT, `owner lost their own coordinate at rung ${rung}`);
        assert.equal(body?.memory?.locationCity, "Da Nang", rung);
      } finally { await app.close(); }
    }
  });

  it("returns the rung to the owner and to nobody else", async () => {
    const app = await startApp(stateWith("city", true));
    try {
      const owner = await getMemory(app.baseUrl, "owner-tok");
      assert.equal(owner.body?.memory?.locationPrecision, "city");
      const viewer = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(viewer.body?.memory?.locationPrecision, undefined,
        "the rung is the owner's audience choice — telling a viewer it was narrowed for them is itself a disclosure");
    } finally { await app.close(); }
  });
});

describe("GET /memories/:id — the null / missing rung is safe without deciding the default", () => {
  it("flag ON and the stored rung is NULL: a non-owner gets NO coordinate, the owner still gets theirs", async () => {
    // Cannot happen on a database with 2338 as written (NOT NULL). If a later
    // migration relaxes that, or a projection omits the field, the read side
    // must fail closed rather than fabricate 'exact'.
    const app = await startApp(stateWith(null as any, true));
    try {
      const viewer = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(viewer.status, 200);
      assert.equal(viewer.body?.memory?.locationLat, null);
      assert.equal(viewer.body?.memory?.locationLng, null);
      assert.equal(viewer.body?.memory?.locationCity, null);
      assert.equal(viewer.body?.memory?.locationCountry, null);
      assert.equal(viewer.body?.memory?.locationPrecision, undefined, "the rung is the owner's private choice");
      const owner = await getMemory(app.baseUrl, "owner-tok");
      assert.equal(owner.status, 200);
      assert.equal(owner.body?.memory?.locationLat, LAT);
      assert.equal(owner.body?.memory?.locationLng, LNG);
      assert.equal(owner.body?.memory?.locationPrecision, "hidden", "the owner is told what the world sees");
    } finally { await app.close(); }
  });

  it("flag ON and the stored rung is junk: same — nothing widens on corruption", async () => {
    const app = await startApp(stateWith("EXACT", true));
    try {
      const viewer = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(viewer.status, 200);
      assert.equal(viewer.body?.memory?.locationLat, null);
      assert.equal(viewer.body?.memory?.locationLng, null);
    } finally { await app.close(); }
  });

  it("flag OFF and the stored rung is NULL: byte-for-byte pre-2338 — the exact coordinate is served (status quo, not a recommendation)", async () => {
    const app = await startApp(stateWith(null as any, false));
    try {
      const viewer = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(viewer.status, 200);
      assert.equal(viewer.body?.memory?.locationLat, LAT);
      assert.equal(viewer.body?.memory?.locationLng, LNG);
    } finally { await app.close(); }
  });
});

describe("the flag is a schema-presence gate: OFF must be the pre-2338 behaviour", () => {
  it("serves the exact coordinate even on a row whose stored rung says 'hidden'", async () => {
    // The row carries location_precision='hidden', but the flag is off, which
    // means "this database does not have the column" — the route must not read
    // it, and must behave exactly as it did before the column existed.
    const app = await startApp(stateWith("hidden", false));
    try {
      const { body } = await getMemory(app.baseUrl, "viewer-tok");
      assert.equal(body?.memory?.locationLat, LAT);
      assert.equal(body?.memory?.locationCity, "Da Nang");
      assert.equal(body?.memory?.locationPrecision, undefined,
        "with the column unselected, nothing may be serialized for it — not even a fabricated 'exact'");
    } finally { await app.close(); }
  });

  it("drops a client-supplied locationPrecision on PATCH rather than naming an absent column", async () => {
    const state = stateWith(undefined, false);
    const app = await startApp(state);
    try {
      const res = await fetch(`${app.baseUrl}/api/memories/${MEM}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ locationPrecision: "city" }),
      });
      assert.equal(res.status, 200);
      assert.equal(state.memories[0].location_precision, undefined,
        "with the flag off the column must never appear in the update payload (PGRST204 fails the whole statement)");
    } finally { await app.close(); }
  });

  it("persists the rung on PATCH when the flag is on", async () => {
    const state = stateWith("exact", true);
    const app = await startApp(state);
    try {
      const res = await fetch(`${app.baseUrl}/api/memories/${MEM}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ locationPrecision: "neighborhood" }),
      });
      assert.equal(res.status, 200);
      assert.equal(state.memories[0].location_precision, "neighborhood");
    } finally { await app.close(); }
  });

  it("never names location_precision in a CREATE payload while the flag is off", async () => {
    // This is the failure mode that matters most: PostgREST rejects the WHOLE
    // insert on one unknown key (PGRST204), so naming a column production does
    // not have would take Memory creation to 100% failure — not a degraded
    // field, an outage. Measured on the wire, an `undefined` property is
    // dropped from both the JSON body and any `columns=` parameter; this
    // asserts the route relies on exactly that.
    const state = stateWith(undefined, false);
    const app = await startApp(state);
    try {
      const res = await fetch(`${app.baseUrl}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ title: "New", visibility: "public", locationPrecision: "city" }),
      });
      assert.equal(res.status, 201);
      const insert = state.inserts.find((i) => i.table === "memories");
      assert.ok(insert, "the route must have inserted a memory");
      assert.equal(insert!.payload.location_precision, undefined,
        "with the flag off the key must carry undefined so supabase-js omits it entirely");
    } finally { await app.close(); }
  });

  it("carries the rung in a CREATE payload when the flag is on", async () => {
    const state = stateWith(undefined, true);
    const app = await startApp(state);
    try {
      const res = await fetch(`${app.baseUrl}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ title: "New", visibility: "public", locationPrecision: "city" }),
      });
      assert.equal(res.status, 201);
      const insert = state.inserts.find((i) => i.table === "memories");
      assert.equal(insert!.payload.location_precision, "city");
    } finally { await app.close(); }
  });

  it("leaves the column to its DEFAULT when the flag is on but the client says nothing", async () => {
    const state = stateWith(undefined, true);
    const app = await startApp(state);
    try {
      const res = await fetch(`${app.baseUrl}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ title: "New", visibility: "public" }),
      });
      assert.equal(res.status, 201);
      const insert = state.inserts.find((i) => i.table === "memories");
      assert.equal(insert!.payload.location_precision, undefined,
        "an unstated precision must fall to the column DEFAULT, not to a value this route picked");
    } finally { await app.close(); }
  });

  it("rejects a rung that is not on the ladder", async () => {
    const app = await startApp(stateWith("exact", true));
    try {
      const res = await fetch(`${app.baseUrl}/api/memories/${MEM}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
        body: JSON.stringify({ locationPrecision: "street" }),
      });
      assert.equal(res.status, 400);
    } finally { await app.close(); }
  });
});
