/**
 * An admin-hidden layover recommendation stops being served to the traveller.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * THE DEFECT. `layover_recommendations.status` is CHECK-constrained to
 * ('active','hidden','flagged') (0127:132-134), and
 * `POST /admin/airport/reports/:id/resolve` with `action:"hide"` sets 'hidden'
 * for the express purpose of taking a reported card down. Two read paths did
 * not consult it:
 *
 *   1. `getRecommendations` selected `*` filtered only on session_id, so a
 *      hidden card was returned to its owner on the very next dashboard load.
 *   2. `POST /airport/sessions/:id/plan` fetched the recommendation by id with
 *      no status filter, so a client holding an id from before the hide could
 *      still add the hidden card to a plan.
 *
 * This is a moderation bug, not the L50 "unsafe ⇒ BLOCKED" question. Nothing
 * here decides what BLOCKED means; `flagged` stays visible on purpose, because
 * the admin contract offers `keep_flagged` as an outcome distinct from `hide`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverAdminHideVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeLayoverDb, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  getRecommendations,
  USER_HIDDEN_RECOMMENDATION_STATUS,
} from "../services/airport/LayoverRecommendationService.js";

// ── result-shape adapter ─────────────────────────────────────────────────────
/**
 * `generateRecommendations` / `getRecommendations` now answer
 * `{ ok: true, recommendations }` or `{ ok: false, message }`, because "the
 * table could not be read" and "this layover has nothing to offer" were the
 * same empty array before and are not the same answer. Every call in this file
 * expects the success arm, and says so out loud rather than reading
 * `undefined` off a refusal.
 */
function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

const SESSION_ID = "session-1";

function recRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: over.id ?? "rec-active",
    session_id: SESSION_ID,
    rec_type: "cafe",
    title: "Airside coffee",
    description: null,
    safety_rating: "safe",
    travel_time_min: 0,
    activity_time_min: 30,
    return_buffer_min: 60,
    hard_return_time: new Date(Date.now() + 3_600_000).toISOString(),
    warning_reason: null,
    inside_airport: true,
    location_label: "Terminal 1",
    city: null,
    neighborhood: null,
    sort_order: 0,
    place_id: null,
    plan_item_id: null,
    status: "active",
    ...over,
  };
}

/** The three states 0127's CHECK constraint permits. Pinned so a new state
 *  cannot be added to the column without this test being reconsidered. */
const DB_STATUSES = ["active", "hidden", "flagged"] as const;

describe("layover admin-hide visibility", () => {
  it("the suppressing status is 'hidden', and it is one of the states the column allows", () => {
    assert.equal(USER_HIDDEN_RECOMMENDATION_STATUS, "hidden");
    assert.ok(
      DB_STATUSES.includes(USER_HIDDEN_RECOMMENDATION_STATUS),
      "the filter must name a status the CHECK constraint actually permits",
    );
  });

  it("an active recommendation is returned", async () => {
    const tables = { layover_recommendations: [recRow({ id: "rec-active" })] };
    const db = makeLayoverDb(tables) as any;
    const out = cards(await getRecommendations(db, SESSION_ID));
    assert.equal(out.length, 1, "an active card must still reach the traveller");
    assert.equal(out[0]!.id, "rec-active");
  });

  it("a hidden recommendation is NOT returned — the defect", async () => {
    const tables = {
      layover_recommendations: [
        recRow({ id: "rec-active", sort_order: 0 }),
        recRow({ id: "rec-hidden", sort_order: 1, status: "hidden" }),
      ],
    };
    const db = makeLayoverDb(tables) as any;
    const out = cards(await getRecommendations(db, SESSION_ID));
    const ids = out.map((r) => r.id);
    assert.ok(!ids.includes("rec-hidden"), "an admin-hidden card must not be served to the traveller");
    assert.deepEqual(ids, ["rec-active"]);
  });

  it("a flagged recommendation IS still returned — keep_flagged is not hide", async () => {
    const tables = {
      layover_recommendations: [recRow({ id: "rec-flagged", status: "flagged" })],
    };
    const db = makeLayoverDb(tables) as any;
    const out = cards(await getRecommendations(db, SESSION_ID));
    assert.deepEqual(
      out.map((r) => r.id),
      ["rec-flagged"],
      "collapsing flagged into hidden would make 'leave it up while we review' mean 'take it down'",
    );
  });

  it("hiding every card yields an empty list, not the whole set", async () => {
    const tables = {
      layover_recommendations: [
        recRow({ id: "a", sort_order: 0, status: "hidden" }),
        recRow({ id: "b", sort_order: 1, status: "hidden" }),
      ],
    };
    const db = makeLayoverDb(tables) as any;
    assert.deepEqual(cards(await getRecommendations(db, SESSION_ID)), []);
  });

  it("admin/service inspection is unaffected: a direct query still sees hidden rows", async () => {
    const tables = {
      layover_recommendations: [
        recRow({ id: "rec-hidden", status: "hidden" }),
        recRow({ id: "rec-flagged", status: "flagged" }),
      ],
    };
    const db = makeLayoverDb(tables) as any;
    // This is the shape GET /admin/airport/reports uses: it does NOT go through
    // getRecommendations, so the traveller-facing filter cannot blind an admin.
    const { data: flagged } = await db
      .from("layover_recommendations").select("id, status").eq("status", "flagged");
    assert.deepEqual((flagged ?? []).map((r: any) => r.id), ["rec-flagged"]);
    // And the resolve route reads by id with no status filter, so a hidden row
    // remains reachable for un-hiding.
    const { data: byId } = await db
      .from("layover_recommendations").select("id, status").eq("id", "rec-hidden").maybeSingle();
    assert.equal((byId as any)?.status, "hidden", "an admin must still be able to reach a hidden row to approve it");
  });

  it("a read error REFUSES — it does not serve everything, and it does not claim an empty layover", async () => {
    // supabase-js RESOLVES on a database error, so this read comes back
    // `{ data: null, error }` rather than throwing. Serving `[]` was the
    // fail-closed direction for the moderation filter and the WRONG answer for
    // the traveller: "we could not look" rendered as "there is nothing to do
    // on your layover". The refusal is now explicit and carries the reason.
    const tables = { layover_recommendations: [recRow({ id: "rec-active" })] };
    const db = makeLayoverDb(tables, {
      failures: { "layover_recommendations:select": { message: "boom" } },
    }) as any;
    const r = await getRecommendations(db, SESSION_ID);
    assert.equal(r.ok, false, "an unreadable table must not answer with a card list at all");
    assert.match((r as any).message, /boom/);
  });

  it("the filter is in the source, not only in this test's expectations", () => {
    // Guards against the filter being removed while the table-backed fake keeps
    // some other behaviour green.
    const src = readFileSync(
      new URL("../services/airport/LayoverRecommendationService.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /\.neq\("status",\s*USER_HIDDEN_RECOMMENDATION_STATUS\)/,
      "getRecommendations must filter on status in the query, not in JS after the fact",
    );
    const route = readFileSync(new URL("../routes/airport.ts", import.meta.url), "utf8");
    assert.match(
      route,
      /\.neq\("status",\s*USER_HIDDEN_RECOMMENDATION_STATUS\)/,
      "the plan-add read must apply the same moderation boundary",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The SECOND read path, exercised over HTTP rather than by regex.
//
// The moderation boundary on `POST /airport/sessions/:id/stops/from-recommendation`
// was pinned above only by a source match. A regex proves the characters are
// present; it does not prove the route refuses. This drives the real router.
// ═══════════════════════════════════════════════════════════════════════════
import { before as _before, after as _after } from "node:test";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
// `sessionRow` is already imported at the top of this file from the same
// module; re-importing it here declared the identifier twice.
import { airportRow } from "./helpers/fakeLayoverDb.js";

const HIDE_TOKEN = "hide-route-token";
const HIDE_USER = "user-1";
let hideServer: http.Server;
let hideBase = "";

function post(p: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, hideBase);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: {
          authorization: `Bearer ${HIDE_TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

function stageRoute(status: string) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: HIDE_USER })],
    layover_recommendations: [recRow({ id: "rec-1", status })],
    layover_plan_stops: [],
    layover_events: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [HIDE_TOKEN]: HIDE_USER } }) as any, true);
  return tables;
}

_before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    hideServer = app.listen(0, "127.0.0.1", () => {
      hideBase = `http://127.0.0.1:${(hideServer.address() as any).port}`;
      resolve();
    });
  });
});
_after(() => new Promise<void>((resolve) => hideServer.close(() => resolve())));

describe("POST /stops/from-recommendation — the hide is not one API call wide", () => {
  it("positive control: an ACTIVE recommendation can be added to the plan", async () => {
    const tables = stageRoute("active");
    const r = await post("/api/airport/sessions/session-1/stops/from-recommendation", { recommendationId: "rec-1" });
    assert.equal(r.status, 200);
    assert.equal(tables.layover_plan_stops!.length, 1, "vacuity: the allowed path must actually write a stop");
    assert.equal(tables.layover_plan_stops![0]!.recommendation_id, "rec-1");
  });

  it("a HIDDEN recommendation is refused 404 and NOTHING is written", async () => {
    // A client holding an id from before the hide is exactly the case: it has
    // a valid id for a row that still exists. The row must not be reachable.
    const tables = stageRoute("hidden");
    const r = await post("/api/airport/sessions/session-1/stops/from-recommendation", { recommendationId: "rec-1" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
    assert.equal(tables.layover_plan_stops!.length, 0, "an admin-hidden card must not be addable to a plan");
  });

  it("a FLAGGED recommendation is still addable — keep_flagged is not hide", async () => {
    const tables = stageRoute("flagged");
    const r = await post("/api/airport/sessions/session-1/stops/from-recommendation", { recommendationId: "rec-1" });
    assert.equal(r.status, 200);
    assert.equal(tables.layover_plan_stops!.length, 1);
  });
});
