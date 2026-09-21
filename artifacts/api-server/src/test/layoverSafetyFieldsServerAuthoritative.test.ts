/**
 * `safety_rating`, `return_buffer_min` and `hard_return_time` are produced by
 * the LayoverSafetyEngine and by nothing else.
 *
 * node:test + node:assert/strict (NOT vitest). The verdict is the EXIT CODE.
 *
 * WHY THIS EXISTS. Migration 2335 closed the DATABASE half of this. Before it,
 * `layover_recs_owner` was FOR ALL with `with_check` NULL, so its USING clause
 * doubled as the write check and a session's OWNER could UPDATE their own
 * `safety_rating`, `return_buffer_min` and `hard_return_time` — the three
 * columns that tell a traveller when to head back for a flight. After 2335 the
 * policy is FOR SELECT, `authenticated` holds SELECT and nothing else, and the
 * same UPDATE is refused 42501.
 *
 * That migration rests entirely on the claim that every writer in this tree
 * reaches the table through `getServiceClient()`, which is BYPASSRLS. So the
 * database boundary closing one door means the SERVER boundary now carries the
 * whole weight: a route that copied a request body into those columns under
 * the service key would walk straight past 2335. This file pins both halves —
 * that no request payload can reach those columns, and that the service client
 * really is the only receiver of a write to that table.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test \
 *      src/test/layoverSafetyFieldsServerAuthoritative.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  generateRecommendations,
  USER_HIDDEN_RECOMMENDATION_STATUS,
} from "../services/airport/LayoverRecommendationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** The three engine outputs 2335 took away from the end-user token. */
const ENGINE_FIELDS = ["safety_rating", "return_buffer_min", "hard_return_time"] as const;
const ENGINE_FIELDS_CAMEL = ["safetyRating", "returnBufferMin", "hardReturnTime"] as const;

const TOKEN = "authoritative-token";
const USER_ID = "user-1";

let server: http.Server;
let base: string;

function call(method: string, p: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
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
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(opts: { recs?: any[]; failures?: Record<string, { message: string }> } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: false },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID })],
    layover_recommendations: opts.recs ?? [],
    layover_plan_stops: [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures ?? {} }),
    true,
  );
  return tables;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── source walking ───────────────────────────────────────────────────────────

function productFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "test" || name === "__tests__" || name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** Strip // and /* *\/ comments so a sentence about a column is not a write. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ═══════════════════════════════════════════════════════════════════════════

describe("no request payload can reach the engine fields", () => {
  it("no zod schema in routes/airport.ts declares one of them", () => {
    const src = stripComments(readFileSync(path.join(SRC, "routes", "airport.ts"), "utf8"));
    // Every request body on this router is parsed by a zod object literal, so
    // a field the client can send must appear as a key in one of them.
    const schemaBlocks = src.match(/z\.object\(\{[\s\S]*?\n\}\)/g) ?? [];
    assert.ok(schemaBlocks.length >= 8, `vacuity: expected the router's request schemas, found ${schemaBlocks.length}`);
    for (const block of schemaBlocks) {
      for (const f of [...ENGINE_FIELDS, ...ENGINE_FIELDS_CAMEL]) {
        assert.ok(
          !new RegExp(`(^|[^A-Za-z_])${f}\\s*:`).test(block),
          `a request schema accepts ${f} — the engine's output would become client input`,
        );
      }
    }
  });

  it("the only place the engine fields are built into a write payload is the engine's own output", () => {
    let payloadSites = 0;
    for (const file of productFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      if (!text.includes("layover_recommendations") && !text.includes("safety_rating")) continue;
      for (const f of ENGINE_FIELDS) {
        const re = new RegExp(`(^|[^A-Za-z_])${f}\\s*:\\s*([^,\\n]+)`, "g");
        for (const m of text.matchAll(re)) {
          payloadSites += 1;
          const value = m[2]!.trim();
          assert.ok(
            !/\b(req|request)\b|parsed\.data|\bbody\b|payload\./.test(value),
            `${path.relative(SRC, file)} builds ${f} from a request value (${value}) — that is the door 2335 did not close`,
          );
        }
      }
    }
    assert.ok(payloadSites > 0, "vacuity: no write payload naming the engine fields was found at all");
  });

  it("POST /stops silently drops injected engine fields — zod strips what it does not declare", async () => {
    const tables = stage();
    const r = await call("POST", "/api/airport/sessions/session-1/stops", {
      title: "A very long lunch",
      durationMin: 240,
      travelMin: 60,
      // The client trying its luck:
      safetyRating: "safe",
      returnBufferMin: 0,
      hardReturnTime: "2099-01-01T00:00:00.000Z",
      safety_rating: "safe",
      return_buffer_min: 0,
      hard_return_time: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(r.status, 200);
    assert.equal(tables.layover_plan_stops.length, 1);
    const row = tables.layover_plan_stops[0]!;
    for (const f of [...ENGINE_FIELDS, ...ENGINE_FIELDS_CAMEL]) {
      assert.equal(row[f], undefined, `${f} reached a persisted row from a request body`);
    }
    // And the plan-fit verdict is still computed from the server's window.
    assert.equal(typeof r.body.planFit.backByTime, "string");
    assert.equal(r.body.planFit.fitsWindow, false, "240 + 60 + 60 minutes does not fit — the server said so, not the client");
  });

  it("PATCH /sessions/:id cannot smuggle them onto the session either", async () => {
    const tables = stage();
    const before = { ...tables.layover_sessions[0]! };
    const r = await call("PATCH", "/api/airport/sessions/session-1", {
      comfortLevel: "safe_only",
      safety_rating: "safe",
      return_buffer_min: 1,
      hard_return_time: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(r.status, 200);
    const after = tables.layover_sessions[0]!;
    assert.equal(after.comfort_level, "safe_only", "vacuity: the legitimate field must actually have been applied");
    for (const f of ENGINE_FIELDS) {
      assert.equal(after[f], before[f], `${f} was written onto the session by a request body`);
    }
  });
});

describe("the 2335 claim: every writer reaches the table through the service client", () => {
  it("every `.from(\"layover_recommendations\")` receiver in product code is `sc` or `db`, never a user-token client", () => {
    const receivers: Array<{ file: string; receiver: string }> = [];
    for (const file of productFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      if (!text.includes('.from("layover_recommendations")')) continue;
      // The receiver is the last identifier before `.from(` — allowing the
      // chained form where `.from` sits on its own line.
      const re = /([A-Za-z_$][\w$.]*)\s*\r?\n?\s*\.from\("layover_recommendations"\)/g;
      for (const m of text.matchAll(re)) {
        receivers.push({ file: path.relative(SRC, file), receiver: m[1]! });
      }
    }
    assert.ok(receivers.length >= 6, `vacuity: expected the known write/read sites, found ${receivers.length}`);
    const ALLOWED = new Set(["sc", "db"]);
    for (const r of receivers) {
      assert.ok(
        ALLOWED.has(r.receiver),
        `${r.file} reaches layover_recommendations through \`${r.receiver}\` — 2335 assumes every writer is the BYPASSRLS service client`,
      );
    }
  });

  it("routes/airport.ts binds `sc` only from getServiceClient() or requireAdmin", () => {
    const src = stripComments(readFileSync(path.join(SRC, "routes", "airport.ts"), "utf8"));
    const binds = [...src.matchAll(/\bconst\s+(?:\{[^}]*\bsc\b[^}]*\}|sc)\s*=\s*([^;\n]+)/g)].map((m) => m[1]!.trim());
    assert.ok(binds.length > 0, "vacuity: no `sc` binding found — re-anchor this test");
    for (const b of binds) {
      assert.ok(
        /getServiceClient\(\)|\badmin\b|\bctx\b/.test(b),
        `\`sc\` is bound from \`${b}\` — anything but the service client (or requireAdmin's, which is the service client where available) breaks the 2335 premise`,
      );
    }
    // And the user-token client is never handed to the recommendation writer.
    assert.ok(
      !/generateRecommendations\(\s*(auth\.)?client\b/.test(src),
      "the recommendation writer must never be handed the caller's user-token client",
    );
  });

  it("the recommendation service's writes all go through its injected `db` parameter", () => {
    const src = stripComments(
      readFileSync(path.join(SRC, "services", "airport", "LayoverRecommendationService.ts"), "utf8"),
    );
    assert.ok(
      !src.includes("getServiceClient"),
      "the service must not reach for a client of its own — the caller's choice of client is the auditable one",
    );
    const writes = [...src.matchAll(/\.from\("layover_recommendations"\)\s*\r?\n?\s*\.(upsert|insert|update|delete)/g)];
    assert.ok(writes.length >= 3, `vacuity: expected the upsert/delete/insert sites, found ${writes.length}`);
  });
});

// ── the moderation state is not optional ─────────────────────────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport",
  city: "Taoyuan", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: true,
};

function svcSession(): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: USER_ID, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 8 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 475,
    flightType: "international", immigrationRequired: true, checkedBags: false,
    loungeAccess: false, wantsToLeave: false, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
    status: "active", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };
}

describe("an unreadable moderation state does not re-serve admin-hidden cards", () => {
  it("positive control: with the state readable, a hidden card is dropped from a regeneration", async () => {
    const tables: Record<string, any[]> = { layover_recommendations: [], layover_events: [], discovery_places: [] };
    const db = makeLayoverDb(tables) as any;
    // Seed: generate once so rows exist under their rec_keys, then hide one.
    const first = await generateRecommendations(db, AIRPORT, svcSession(), Date.now(), { stableIds: true });
    assert.equal(first.ok, true);
    assert.ok(tables.layover_recommendations!.length > 0, "vacuity: the seeding pass must have written rows");
    const victim = tables.layover_recommendations![0]!;
    victim.status = USER_HIDDEN_RECOMMENDATION_STATUS;

    const second = await generateRecommendations(db, AIRPORT, svcSession(), Date.now() + 60_000, { stableIds: true });
    assert.equal(second.ok, true);
    const titles = (second as any).recommendations.map((r: any) => r.title);
    assert.ok(!titles.includes(victim.title), "an admin-hidden card must not come back through regeneration");
  });

  it("with the state UNREADABLE, the call REFUSES — it does not serve the hidden card, and it does not serve nothing", async () => {
    const tables: Record<string, any[]> = { layover_recommendations: [], layover_events: [], discovery_places: [] };
    const seed = makeLayoverDb(tables) as any;
    const first = await generateRecommendations(seed, AIRPORT, svcSession(), Date.now(), { stableIds: true });
    assert.equal(first.ok, true);
    tables.layover_recommendations![0]!.status = USER_HIDDEN_RECOMMENDATION_STATUS;

    // The stale scan is the ONLY `select` this path makes on the table (the
    // upsert's own `.select()` is part of an `upsert` op), so failing
    // `layover_recommendations:select` fails exactly the read that carries the
    // moderation state — leaving `statusByKey` empty, which used to mean
    // "nothing is hidden".
    const blind = makeLayoverDb(tables, {
      failures: { "layover_recommendations:select": { message: "permission denied" } },
    }) as any;
    const out = await generateRecommendations(blind, AIRPORT, svcSession(), Date.now() + 60_000, { stableIds: true });
    assert.equal(out.ok, false, "cards whose hidden/flagged state is unknown must not be served at all");
    assert.match((out as any).message, /permission denied/);
  });
});
