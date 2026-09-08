/**
 * Layover admin moderation state survives recommendation regeneration.
 *
 * node:test + node:assert (NOT vitest). Real router, fake table-backed DB.
 * Judge by EXIT CODE.
 *
 * THE DEFECT. `GET /api/airport/sessions/:id/recommendations` regenerates the
 * card set on every call while `layover_safety_engine_enabled` is TRUE (it is,
 * in production). Regeneration was DELETE-all-then-INSERT-fresh, so a card an
 * admin had hidden came back as a brand-new row with the column default
 * 'active': an upheld report un-upheld itself on the traveller's next dashboard
 * load. And because generateRecommendations returns the rows it just BUILT, not
 * the rows as they now STAND in the table, even the stable-identity path — which
 * does preserve `status` in the database — still handed the hidden card back to
 * the traveller in the same response.
 *
 * THE CHAIN THESE TESTS HOLD DOWN, end to end:
 *
 *   generated -> stable rec_key -> admin hide -> regeneration
 *     -> logical recommendation reconstructed BY KEY
 *     -> prior moderation state reapplied
 *     -> hidden card stays hidden from ordinary user reads
 *
 * IDENTITY IS `rec_key` AND ONLY `rec_key`. Nothing here matches a stored row to
 * a generated card by comparing display text; two cards that read identically
 * but are genuinely different (two discovery places with the same name) get
 * different keys and do not share moderation state. That is the trap migration
 * 2410 exists to avoid and it has its own test below.
 *
 * NULLs ARE DISTINCT in `layover_recs_session_key_uidx`, which is why legacy
 * (rec_key NULL) rows coexist under a NON-partial unique index. That is load
 * bearing, not an oversight, and is pinned here so a future "fix" that makes the
 * index partial or collapses NULL keys fails.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverModerationDurability.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  generateRecommendations,
  recommendationKey,
  USER_HIDDEN_RECOMMENDATION_STATUS,
} from "../services/airport/LayoverRecommendationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

const SESSION_ID = "session-1";
const USER_ID = "user-1";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: SESSION_ID, userId: USER_ID, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 535,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

/**
 * TWIN-NAMED PLACES. `place-twin-a` and `place-twin-b` carry BYTE-IDENTICAL
 * display text — same name, same type, same neighborhood, same blurb — and
 * differ only in their primary key. They are the control for "text similarity
 * is not identity": hiding one must not hide the other.
 */
const PLACES = [
  { id: "place-1",      name: "Night Market",   place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true,  city: "Taoyuan", status: "active" },
  { id: "place-twin-a", name: "Riverside Cafe", place_type: "cafe",       category: "food", neighborhood: "Zhongli", blurb: "Coffee", verified: false, city: "Taoyuan", status: "active" },
  { id: "place-twin-b", name: "Riverside Cafe", place_type: "cafe",       category: "food", neighborhood: "Zhongli", blurb: "Coffee", verified: false, city: "Taoyuan", status: "active" },
];

function tables(): Record<string, any[]> {
  return {
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

/** The stored row carrying a given key, or undefined. */
function rowFor(t: Record<string, any[]>, key: string): any {
  return t.layover_recommendations.find((r) => r.rec_key === key);
}

/** Set moderation status on the stored row with this key — what the admin
 *  resolve route does (`UPDATE ... SET status = 'hidden' WHERE id = ...`). */
function moderate(t: Record<string, any[]>, key: string, status: string): string {
  const row = rowFor(t, key);
  assert.ok(row, `positive control: no stored row for key ${key}`);
  row.status = status;
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY 5 — rec_key is stable but collision-free
// ─────────────────────────────────────────────────────────────────────────────

describe("rec_key: stable across generations, distinct across cards", () => {
  it("every card in one session gets a DIFFERENT key", async () => {
    const t = tables();
    const recs = await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(recs.length >= 6, `positive control: expected inside + 3 discovery + escape cards, got ${recs.length}`);
    const keys = t.layover_recommendations.map((r) => r.rec_key);
    assert.equal(keys.length, recs.length, "every returned card must have a stored row");
    assert.equal(new Set(keys).size, keys.length, `rec_key collision among ${JSON.stringify(keys)}`);
    for (const k of keys) assert.equal(typeof k, "string", "a stored card has no key");
  });

  it("two places with byte-identical display text get different keys — text is not identity", async () => {
    const t = tables();
    await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds: true });
    const a = rowFor(t, "place:place-twin-a");
    const b = rowFor(t, "place:place-twin-b");
    assert.ok(a && b, "positive control: both twin cards must be generated");
    assert.equal(a.title, b.title, "positive control: the twins must actually read alike");
    assert.notEqual(a.rec_key, b.rec_key, "identical text produced identical identity");
    assert.notEqual(a.id, b.id);
  });

  it("the same logical card keeps its key across regenerations, even as the window moves", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const before = new Map(t.layover_recommendations.map((r) => [r.rec_key, r.id]));
    await generateRecommendations(db, AIRPORT, session(), Date.now() + 47 * 60_000, { stableIds: true });
    const after = new Map(t.layover_recommendations.map((r) => [r.rec_key, r.id]));
    assert.equal(after.size, before.size);
    for (const [k, id] of before) assert.equal(after.get(k), id, `key ${k} changed row identity`);
  });

  it("the derivation is a pure function of the card's own fields, and placeId wins over text", () => {
    const k = (over: any) => recommendationKey({ recType: "food", title: "Riverside Cafe", insideAirport: false, city: "Taoyuan", ...over });
    assert.equal(k({ placeId: "p1" }), "place:p1");
    assert.equal(k({ placeId: "p1" }), k({ placeId: "p1", title: "COMPLETELY DIFFERENT TEXT" }),
      "the key of a place-backed card must not move when its display text changes");
    assert.notEqual(k({ placeId: "p1" }), k({ placeId: "p2" }),
      "two different places must never share a key however alike they read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MECHANISM — the upsert must not carry `status`
// ─────────────────────────────────────────────────────────────────────────────

describe("the write itself leaves moderation state standing", () => {
  it("the upsert payload never contains `status`", async () => {
    const t = tables();
    const db: any = makeLayoverDb(t);
    const seen: any[][] = [];
    const origFrom = db.from.bind(db);
    db.from = (table: string) => {
      const b = origFrom(table);
      if (table === "layover_recommendations") {
        const origUpsert = b.upsert.bind(b);
        b.upsert = (rows: any, o: any) => { seen.push(Array.isArray(rows) ? rows : [rows]); return origUpsert(rows, o); };
      }
      return b;
    };
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.equal(seen.length, 1, "positive control: exactly one upsert of the card set");
    assert.ok(seen[0]!.length >= 6, "positive control: the payload carried the cards");
    for (const row of seen[0]!) {
      assert.ok(!("status" in row),
        `the upsert payload carries \`status\` — PostgREST would write it and reset every moderated card to 'active': ${JSON.stringify(row)}`);
      assert.equal(typeof row.rec_key, "string", "every upserted row must carry its key");
    }
  });

  it("an admin hide is still in the table after a regeneration", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const hiddenId = moderate(t, "place:place-twin-a", USER_HIDDEN_RECOMMENDATION_STATUS);

    await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });

    const row = rowFor(t, "place:place-twin-a");
    assert.ok(row, "the moderated row was deleted by regeneration");
    assert.equal(row.id, hiddenId, "the moderated row was replaced by a new one");
    assert.equal(row.status, USER_HIDDEN_RECOMMENDATION_STATUS, "regeneration reset the admin's decision");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTIES 1-4 — hide survives; active stays visible; the right card inherits
// ─────────────────────────────────────────────────────────────────────────────

describe("a hide survives regeneration (flag ON)", () => {
  it("PROPERTY 1: the hidden card is withheld from the regenerated set", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const first = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(first.some((r) => r.placeId === "place-twin-a"), "positive control: the card was served before the hide");
    moderate(t, "place:place-twin-a", USER_HIDDEN_RECOMMENDATION_STATUS);

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    assert.ok(!second.some((r) => r.placeId === "place-twin-a"),
      "the admin-hidden card was served to the traveller again after regeneration");
  });

  it("PROPERTY 2: an active card is still visible after regeneration, with its id", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const keptId = rowFor(t, "place:place-1").id;
    moderate(t, "place:place-twin-a", USER_HIDDEN_RECOMMENDATION_STATUS);

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    const kept = second.find((r) => r.placeId === "place-1");
    assert.ok(kept, "hiding one card suppressed an unrelated active one");
    assert.equal(kept.id, keptId, "the surviving card must keep the id the client already holds");
    assert.ok(second.length >= 5, `only ${second.length} cards survived a single hide`);
  });

  it("PROPERTY 3: the twin with identical text does NOT inherit the hide", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    moderate(t, "place:place-twin-a", USER_HIDDEN_RECOMMENDATION_STATUS);

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    const twinB = second.find((r) => r.placeId === "place-twin-b");
    assert.ok(twinB, "the untouched twin was suppressed — identity was inferred from display text");
    assert.equal(rowFor(t, "place:place-twin-b").status, undefined,
      "the untouched twin's stored row was moderated by association");
    assert.ok(!second.some((r) => r.placeId === "place-twin-a"), "positive control: the hidden twin is still hidden");
  });

  it("PROPERTY 4: the SAME card inherits the hide across many regenerations", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    moderate(t, "inside:rest:rest-sleep-pod", USER_HIDDEN_RECOMMENDATION_STATUS);

    for (let i = 1; i <= 3; i++) {
      const out = await generateRecommendations(db, AIRPORT, session(), Date.now() + i * 60_000, { stableIds: true });
      assert.ok(!out.some((r) => r.title === "Rest & Sleep Pod"),
        `the hide leaked back on regeneration #${i}`);
      assert.equal(rowFor(t, "inside:rest:rest-sleep-pod").status, USER_HIDDEN_RECOMMENDATION_STATUS);
    }
  });

  it("'flagged' stays visible — keep_flagged is a different admin outcome from hide", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    moderate(t, "place:place-1", "flagged");

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    assert.ok(second.some((r) => r.placeId === "place-1"),
      "collapsing flagged into hidden would make 'leave it up while we review' mean 'take it down'");
  });

  it("the suppression is auditable: recommendation_generated records how many were withheld", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    moderate(t, "place:place-twin-a", USER_HIDDEN_RECOMMENDATION_STATUS);
    t.layover_events.length = 0;

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
    assert.ok(evt, "no recommendation_generated event");
    assert.equal(evt.metadata.moderationHidden, 1, "the withheld card is invisible in the audit record");
    assert.equal(evt.metadata.count - evt.metadata.moderationHidden, second.length,
      "written minus withheld must equal what the traveller was served");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY 6 — legacy rows (rec_key NULL)
// ─────────────────────────────────────────────────────────────────────────────

describe("legacy rows with rec_key NULL are handled safely", () => {
  /** Three legacy rows, deliberately alike, in one session. Production holds 30
   *  such rows (measured 2026-09-08), all rec_key NULL. */
  function seedLegacy(t: Record<string, any[]>) {
    t.layover_recommendations.push(
      { id: "legacy-hidden", session_id: SESSION_ID, rec_key: null, rec_type: "food", title: "Airport Dining", inside_airport: true, city: null, place_id: null, safety_rating: "safe", sort_order: 0, status: "hidden" },
      { id: "legacy-active", session_id: SESSION_ID, rec_key: null, rec_type: "food", title: "Airport Dining", inside_airport: true, city: null, place_id: null, safety_rating: "safe", sort_order: 1, status: "active" },
      { id: "legacy-other",  session_id: SESSION_ID, rec_key: null, rec_type: "rest", title: "Rest & Sleep Pod", inside_airport: true, city: null, place_id: null, safety_rating: "safe", sort_order: 2, status: "active" },
    );
  }

  it("NULL-keyed rows coexist — they do not collide with each other", () => {
    const t = tables();
    seedLegacy(t);
    const nulls = t.layover_recommendations.filter((r) => r.rec_key === null);
    assert.equal(nulls.length, 3, "three legacy rows must be able to sit in one session at once");
    assert.equal(new Set(nulls.map((r) => r.id)).size, 3);
    // NULLs are distinct in a unique index; the index must therefore NOT be
    // partial (PostgREST's on_conflict cannot express a predicate) and must NOT
    // treat the three above as one row.
    const sql = readFileSync(join(MIGRATIONS_DIR, "2410_layover_recommendation_identity.sql"), "utf8");
    const idx = sql.match(/CREATE UNIQUE INDEX[^;]*layover_recs_session_key_uidx[^;]*;/i);
    assert.ok(idx, "2410 must declare layover_recs_session_key_uidx");
    assert.ok(!/\bWHERE\b/i.test(idx[0]),
      "the unique index must stay NON-partial: a predicate makes it unusable as an ON CONFLICT target");
    assert.match(idx[0], /\(\s*session_id\s*,\s*rec_key\s*\)/i);
  });

  it("no legacy row inherits another legacy row's moderation state", async () => {
    const t = tables();
    seedLegacy(t);
    const db = makeLayoverDb(t);
    const out = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });

    // 'legacy-hidden' and 'legacy-active' have IDENTICAL rec_type/title/
    // inside_airport. If identity were inferred from display text, the hide
    // would have spread to the sibling and to the freshly generated
    // "Airport Dining" card. It must not.
    assert.ok(out.some((r) => r.title === "Airport Dining"),
      "a keyed card inherited a NULL-keyed row's hide by looking like it");
    assert.ok(out.some((r) => r.title === "Rest & Sleep Pod"));

    // The keyed rows the generation produced are all unmoderated, and none of
    // the legacy ids survived to lend their status to anything.
    for (const r of t.layover_recommendations) {
      assert.equal(typeof r.rec_key, "string", `row ${r.id} survived the sweep without a key`);
      assert.ok(!String(r.id).startsWith("legacy-"), `legacy row ${r.id} was adopted rather than swept`);
      assert.notEqual(r.status, USER_HIDDEN_RECOMMENDATION_STATUS, `row ${r.id} inherited a legacy hide`);
    }
  });

  it("the migration that would carry legacy moderation across the cutover exists, is gated, and flips no flag", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "2411_layover_recommendation_rec_key_backfill.sql"), "utf8");
    // It refuses to run once the capability is already ON.
    assert.match(sql, /layover_stable_recommendation_ids_enabled'\s+AND\s+enabled\s*=\s*TRUE/i,
      "the backfill must refuse to run after the cutover");
    assert.match(sql, /PRECONDITION FAILED/);
    // It only ever writes rows that have no key: idempotent, never a re-key.
    assert.match(sql, /rec_key IS NULL/);
    // And it must not become a flag flip in disguise.
    assert.ok(!/UPDATE\s+public\.feature_flags/i.test(sql), "the backfill must not write feature_flags");
    assert.ok(!/INSERT\s+INTO\s+public\.feature_flags/i.test(sql), "the backfill must not seed feature_flags");
    assert.ok(!/DELETE\s+FROM\s+public\.layover_recommendations/i.test(sql), "the backfill must delete nothing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLAG OFF — byte-identical to today
// ─────────────────────────────────────────────────────────────────────────────

describe("flag OFF: the legacy path is unchanged", () => {
  it("delete+insert, no rec_key written, no ids returned, no status read", async () => {
    const t = tables();
    const db: any = makeLayoverDb(t);
    const ops: string[] = [];
    const origFrom = db.from.bind(db);
    db.from = (table: string) => {
      const b = origFrom(table);
      if (table === "layover_recommendations") {
        for (const op of ["select", "insert", "upsert", "update", "delete"] as const) {
          const orig = b[op].bind(b);
          b[op] = (...args: any[]) => { ops.push(op); return orig(...args); };
        }
      }
      return b;
    };

    const first = await generateRecommendations(db, AIRPORT, session(), Date.now());
    for (const r of first) assert.equal(r.id, undefined, `legacy path leaked an id on "${r.title}"`);
    assert.ok(!t.layover_recommendations.some((r) => "rec_key" in r), "legacy path must not write rec_key");
    assert.deepEqual(ops, ["delete", "insert"],
      `the legacy path must be exactly delete-then-insert, got ${JSON.stringify(ops)}`);

    const idsA = new Set(t.layover_recommendations.map((r) => r.id));
    await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000);
    for (const id of t.layover_recommendations.map((r) => r.id)) {
      assert.ok(!idsA.has(id), "legacy path is delete+insert: ids must not survive");
    }
  });

  it("a hide does NOT survive with the flag off — the unfixed status quo the flag exists to change", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now());
    const target = t.layover_recommendations.find((r) => r.place_id === "place-twin-a");
    assert.ok(target, "positive control: the card was generated");
    target.status = USER_HIDDEN_RECOMMENDATION_STATUS;

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000);
    // Documented, NOT fixed: on the legacy path a card has no identity that
    // outlives the DELETE, so there is nothing to reapply the status to. This
    // assertion is what makes the flag's value measurable, and it fails if
    // anyone changes the OFF path.
    assert.ok(second.some((r) => r.placeId === "place-twin-a"),
      "the legacy path changed behaviour — flag OFF must stay byte-identical to today");
    assert.ok(!t.layover_recommendations.some((r) => r.status === USER_HIDDEN_RECOMMENDATION_STATUS),
      "the legacy path deletes and re-inserts, so the hide is gone from the table too");
  });

  it("the audit record reports zero withheld when the flag is off", async () => {
    const t = tables();
    await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now());
    const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
    assert.ok(evt);
    assert.equal(evt.metadata.stableIds, false);
    assert.equal(evt.metadata.moderationHidden, 0);
    assert.equal(evt.metadata.count, t.layover_recommendations.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE LEVEL — the traveller's own dashboard read
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const TOKEN = "mod-token";

function req(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function stage(stableIds: boolean) {
  const t: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: stableIds },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SESSION_ID, user_id: USER_ID })],
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: USER_ID } }), true);
  return t;
}

before(() => {
  const app = express();
  app.use(express.json());
  // The req.log shim the real server installs. Without it these routes CRASH
  // and a 500-from-crash would masquerade as "the card was not served".
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("GET /api/airport/sessions/:id/recommendations — the hide reaches the traveller's read", () => {
  it("flag ON: the hidden card is gone on the next dashboard load, the rest keep their ids", async () => {
    const t = stage(true);

    const first = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.featureEnabled, true);
    const before: any[] = first.body.recommendations;
    assert.ok(before.length >= 6, `positive control: got ${before.length} cards`);
    for (const c of before) assert.ok(c.id, `card "${c.title}" reached the client with no id — "Add to plan" cannot render`);

    // The admin upholds a report on one card.
    const victim = before.find((c) => c.placeId === "place-twin-a");
    assert.ok(victim, "positive control: the twin card was served");
    const row = t.layover_recommendations.find((r) => r.id === victim.id);
    assert.ok(row, "positive control: the served id must resolve to a stored row");
    row.status = USER_HIDDEN_RECOMMENDATION_STATUS;

    const second = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const after: any[] = second.body.recommendations;
    assert.ok(!after.some((c) => c.id === victim.id),
      "the admin-hidden card was served again after regeneration");
    assert.ok(!after.some((c) => c.placeId === "place-twin-a"), "the hidden card came back under a new id");
    assert.equal(after.length, before.length - 1, `expected exactly one card withheld, got ${before.length} -> ${after.length}`);
    // The twin that merely READS the same is untouched.
    assert.ok(after.some((c) => c.placeId === "place-twin-b"), "the identically-titled twin was suppressed too");
    // And every surviving card kept the id the client already holds.
    const beforeIds = new Map(before.filter((c) => c.id !== victim.id).map((c) => [c.placeId ?? c.title, c.id]));
    for (const c of after) assert.equal(c.id, beforeIds.get(c.placeId ?? c.title), `"${c.title}" changed id across the reload`);
  });

  it("flag ON: an admin can still reach the hidden row to un-hide it, and it comes back", async () => {
    const t = stage(true);
    const first = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(first.status, 200);
    const victim = (first.body.recommendations as any[]).find((c) => c.placeId === "place-1");
    assert.ok(victim);
    const row = t.layover_recommendations.find((r) => r.id === victim.id)!;

    row.status = USER_HIDDEN_RECOMMENDATION_STATUS;
    const hiddenRead = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.ok(!(hiddenRead.body.recommendations as any[]).some((c) => c.id === victim.id));
    // The row is still there for the admin surfaces, which query the table
    // directly — suppression is not deletion.
    assert.ok(t.layover_recommendations.some((r) => r.id === victim.id), "hiding a card destroyed it");

    row.status = "active";
    const restored = await req("GET", "/api/airport/sessions/session-1/recommendations");
    const back = (restored.body.recommendations as any[]).find((c) => c.id === victim.id);
    assert.ok(back, "approving the report did not bring the card back");
    assert.equal(back.placeId, "place-1");
  });

  it("flag OFF: today's behaviour, unchanged — every card returns, none with an id", async () => {
    stage(false);
    const r = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs: any[] = r.body.recommendations;
    assert.ok(recs.length >= 6, `positive control: got ${recs.length} cards`);
    for (const c of recs) {
      assert.equal(c.id, undefined, `flag OFF must return cards without ids, "${c.title}" had one`);
    }
  });
});
