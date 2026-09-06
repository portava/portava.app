/**
 * RED-PROOF — a failed READ must never become a WRITE.
 *
 * supabase-js RESOLVES `{ data, error }` instead of throwing. Code written as
 *
 *     const { data } = await sc.from(X).select(...).maybeSingle();
 *     const merged = { ...DEFAULTS, ...(data ?? {}) };
 *     await sc.from(X).upsert(merged);
 *
 * therefore cannot tell "the database is unreachable" from "there is no row",
 * substitutes a default for the former, and PERSISTS it. The user's real data
 * is gone, and it stays gone after the outage ends — the outage wrote over it.
 *
 * Three sites in this codebase had exactly that shape. Each test below injects
 * a read failure at the failing table, drives the REAL handler / engine, and
 * asserts the stored row was left alone. Every one of them fails against the
 * pre-fix code (which writes the default) and passes against the fix (which
 * aborts).
 *
 *   1. PATCH /api/me/privacy   — PRIVACY_DEFAULTS (maximally permissive) were
 *                                merged over a failed read of
 *                                profile_privacy_settings and upserted, resetting
 *                                every hidden field to public.
 *   2. POST /api/airport/sessions — a failed read of airport_profiles was
 *                                indistinguishable from "not in the DB", so the
 *                                static fallback (generic buffers,
 *                                verified:false) was upserted with
 *                                onConflict:"iata_code" over an admin-curated
 *                                airport.
 *   3. StampAwardEngine        — a failed read of stamp_progress yielded
 *                                newCount = 0 + 1 and upserted 1 over a real
 *                                progress count.
 *
 * Run: node --import tsx/esm --test src/test/failedReadNeverWrites.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";
import airportRouter from "../routes/airport.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";

// ── Shared HTTP plumbing ──────────────────────────────────────────────────────

const TOKEN   = "failed-read-token";
const USER_ID = "b0b0b0b0-0000-4000-8000-00000000beef";

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const fakeAuth = {
  getUser: async (t: string) =>
    t === TOKEN
      ? { data: { user: { id: USER_ID } }, error: null }
      : { data: { user: null }, error: { message: "bad token" } },
};

/**
 * Minimal in-memory PostgREST stand-in.
 *
 * `failSelectOn` names the tables whose SELECTs resolve as `{ data: null,
 * error }` — the exact shape supabase-js produces for an unreachable table.
 * WRITES on those tables still succeed, which is the whole point: the pre-fix
 * code reaches the write and lands the default, so the assertion has something
 * real to catch.
 */
function makeStore(
  tables: Record<string, any[]>,
  opts: { failSelectOn?: string[]; conflictKey?: Record<string, string> } = {},
) {
  const failSelect = new Set(opts.failSelectOn ?? []);
  const conflictKey = opts.conflictKey ?? {};
  const writes: Array<{ table: string; op: string; row: any }> = [];

  function builder(table: string) {
    const rows: any[] = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let pendingWrite: { op: "insert" | "upsert" | "update"; row: any } | null = null;

    const readError = () => ({
      data: null,
      error: { message: `relation "${table}" is unavailable`, code: "57P01" },
      count: null,
    });

    function matches(r: any) { return filters.every((f) => f(r)); }

    function applyWrite() {
      const w = pendingWrite!;
      const incoming = Array.isArray(w.row) ? w.row : [w.row];
      if (w.op === "update") {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, w.row);
        writes.push({ table, op: "update", row: w.row });
        return { data: hit[0] ?? null, error: null };
      }
      let last: any = null;
      for (const row of incoming) {
        writes.push({ table, op: w.op, row: { ...row } });
        const key = conflictKey[table];
        const existingIdx = key
          ? rows.findIndex((r) => r[key] === row[key])
          : -1;
        if (w.op === "upsert" && existingIdx >= 0) {
          // Real onConflict semantics: the incoming row REPLACES the stored one.
          rows[existingIdx] = { ...rows[existingIdx], ...row };
          last = rows[existingIdx];
        } else {
          const created = { id: row.id ?? `gen-${rows.length + 1}`, ...row };
          rows.push(created);
          last = created;
        }
      }
      return { data: last, error: null };
    }

    function settle(single: boolean) {
      if (pendingWrite) return applyWrite();
      if (failSelect.has(table)) return readError();
      const hit = rows.filter(matches);
      if (single) return { data: hit[0] ?? null, error: null, count: hit.length };
      return { data: hit, error: null, count: hit.length };
    }

    const b: any = {
      select() { return b; },
      insert(row: any) { pendingWrite = { op: "insert", row }; return b; },
      upsert(row: any) { pendingWrite = { op: "upsert", row }; return b; },
      update(row: any) { pendingWrite = { op: "update", row }; return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      ilike(col: string, val: any) {
        const needle = String(val).replace(/%/g, "").toLowerCase();
        filters.push((r) => typeof r[col] === "string" && r[col].toLowerCase().includes(needle));
        return b;
      },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      not() { return b; }, or() { return b; }, order() { return b; },
      limit() { return b; }, range() { return b; }, head() { return b; },
      maybeSingle() { return Promise.resolve(settle(true)); },
      single() { return Promise.resolve(settle(true)); },
      then(onF: any, onR: any) { return Promise.resolve(settle(false)).then(onF, onR); },
    };
    return b;
  }

  return {
    tables,
    writes,
    client: {
      from: (t: string) => builder(t),
      auth: fakeAuth,
      rpc: async () => ({ data: null, error: null }),
    } as any,
  };
}

function install(store: { client: any }) {
  _setTestClient(store.client, true);
  _setTestServiceClient(store.client);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PATCH /api/me/privacy — the decisive one
// ─────────────────────────────────────────────────────────────────────────────

/** Everything this user deliberately turned OFF. All are `true` in PRIVACY_DEFAULTS. */
const RESTRICTIONS = {
  show_current_city:       false,
  show_home_country:       false,
  show_visited_places:     false,
  show_upcoming_trips:     false,
  show_past_trips:         false,
  show_stamps:             false,
  show_posts:              false,
  show_friends:            false,
  show_followers:          false,
  allow_profile_discovery: false,
  allow_friend_requests:   false,
  allow_follow:            false,
  allow_tagging:           false,
} as const;

function restrictiveRow() {
  return {
    user_id: USER_ID,
    profile_visibility: "followers_only",
    allow_messages_from: "friends",
    ...RESTRICTIONS,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("1. PATCH /api/me/privacy — a failed settings read must not persist PRIVACY_DEFAULTS", () => {
  it("leaves every restriction intact when the existing-settings read fails", async () => {
    const store = makeStore(
      {
        profile_privacy_settings: [restrictiveRow()],
        user_privacy_settings:    [],
        profiles:                 [{ id: USER_ID, is_private: false, show_profile_picture_publicly: false }],
      },
      { failSelectOn: ["profile_privacy_settings"], conflictKey: { profile_privacy_settings: "user_id" } },
    );
    install(store);

    // One unrelated switch. Nothing here mentions city, trips, stamps or discovery.
    const r = await req("PATCH", "/api/me/privacy", { delayed_posting_default: true });

    // The request must be REFUSED, not silently "succeed" with a rewritten row.
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);

    const stored = store.tables.profile_privacy_settings[0];
    for (const [field, want] of Object.entries(RESTRICTIONS)) {
      assert.equal(
        stored[field], want,
        `${field} must survive a failed read — a transient DB error republished it as ${stored[field]}`,
      );
    }
    assert.equal(stored.profile_visibility, "followers_only", "profile_visibility must survive a failed read");
    assert.equal(stored.allow_messages_from, "friends", "allow_messages_from must survive a failed read");
  });

  it("writes nothing at all to profile_privacy_settings when the read fails", async () => {
    const store = makeStore(
      {
        profile_privacy_settings: [restrictiveRow()],
        user_privacy_settings:    [],
        profiles:                 [{ id: USER_ID, is_private: false }],
      },
      { failSelectOn: ["profile_privacy_settings"], conflictKey: { profile_privacy_settings: "user_id" } },
    );
    install(store);

    await req("PATCH", "/api/me/privacy", { show_real_name: true });
    await new Promise((r) => setTimeout(r, 60)); // let fire-and-forget syncs settle

    const privacyWrites = store.writes.filter((w) => w.table === "profile_privacy_settings");
    assert.deepEqual(
      privacyWrites, [],
      `no write may follow a read that failed; got ${JSON.stringify(privacyWrites)}`,
    );
  });

  it("still merges and saves normally when the read SUCCEEDS (fix is not a blanket refusal)", async () => {
    const store = makeStore(
      {
        profile_privacy_settings: [restrictiveRow()],
        user_privacy_settings:    [],
        profiles:                 [{ id: USER_ID, is_private: false }],
      },
      { conflictKey: { profile_privacy_settings: "user_id" } },
    );
    install(store);

    const r = await req("PATCH", "/api/me/privacy", { delayed_posting_default: true });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const stored = store.tables.profile_privacy_settings[0];
    assert.equal(stored.delayed_posting_default, true, "the requested change must be applied");
    assert.equal(stored.show_current_city, false, "unrelated restrictions must be preserved by the merge");
    assert.equal(stored.allow_profile_discovery, false, "unrelated restrictions must be preserved by the merge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/airport/sessions — curated airport must survive a failed read
// ─────────────────────────────────────────────────────────────────────────────

/** An admin-curated TPE: verified, with buffers deliberately raised above the generic ones. */
function curatedTpe() {
  return {
    id:                       "airport-tpe-curated",
    iata_code:                "TPE",
    name:                     "Taiwan Taoyuan International Airport",
    city:                     "Taoyuan",
    country:                  "Taiwan",
    country_code:             "TW",
    timezone:                 "Asia/Taipei",
    lat:                      25.0797,
    lng:                      121.2342,
    domestic_buffer_min:      95,
    domestic_buffer_max:      140,
    international_buffer_min: 240,
    international_buffer_max: 300,
    immigration_extra_min:    55,
    checked_bags_extra_min:   35,
    traffic_extra_min:        45,
    verified:                 true,
  };
}

function airportStore(failSelect: boolean) {
  return makeStore(
    {
      feature_flags: [
        { flag: "airport_mode_enabled",          key: "airport_mode_enabled",          enabled: true },
        { flag: "layover_safety_engine_enabled", key: "layover_safety_engine_enabled", enabled: true },
      ],
      airport_profiles: [curatedTpe()],
      layover_sessions: [],
      layover_events:   [],
    },
    {
      // feature_flags must stay readable, or the fail-closed gate short-circuits
      // the route before it ever reaches the code under test.
      failSelectOn: failSelect ? ["airport_profiles"] : [],
      conflictKey:  { airport_profiles: "iata_code" },
    },
  );
}

function sessionBody() {
  const arrival   = new Date(Date.now() + 3_600_000).toISOString();
  const departure = new Date(Date.now() + 6 * 3_600_000).toISOString();
  return {
    iata: "TPE",
    arrivalTime: arrival,
    departureTime: departure,
    flightType: "international",
  };
}

describe("2. POST /api/airport/sessions — a failed airport read must not seed the static fallback", () => {
  it("does not overwrite the curated airport_profiles row when the read fails", async () => {
    const store = airportStore(true);
    install(store);

    const r = await req("POST", "/api/airport/sessions", sessionBody());
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);

    const stored = store.tables.airport_profiles.find((a: any) => a.iata_code === "TPE");
    assert.ok(stored, "the curated row must still exist");
    assert.equal(stored.verified, true, "verified:true must not be flattened to false by a failed read");
    assert.equal(stored.international_buffer_min, 240, "curated international buffer must survive");
    assert.equal(stored.international_buffer_max, 300, "curated international buffer must survive");
    assert.equal(stored.domestic_buffer_min, 95, "curated domestic buffer must survive");
    assert.equal(stored.immigration_extra_min, 55, "curated immigration allowance must survive");
    assert.equal(stored.city, "Taoyuan", "curated city must not be replaced by the static dataset's value");
  });

  it("writes nothing at all to airport_profiles when the read fails", async () => {
    const store = airportStore(true);
    install(store);

    await req("POST", "/api/airport/sessions", sessionBody());

    const profileWrites = store.writes.filter((w) => w.table === "airport_profiles");
    assert.deepEqual(
      profileWrites, [],
      `no airport_profiles write may follow a failed read; got ${JSON.stringify(profileWrites)}`,
    );
  });

  // resolveByCity has the identical shape and reaches the identical upsert, so
  // it gets the identical proof — via manualCity, the only path that uses it.
  it("does not seed a static profile via manualCity when the read fails", async () => {
    const store = airportStore(true);
    install(store);

    const { iata, ...rest } = sessionBody();
    const r = await req("POST", "/api/airport/sessions", { ...rest, manualCity: "Taipei" });
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);

    const stored = store.tables.airport_profiles.find((a: any) => a.iata_code === "TPE");
    assert.equal(stored.verified, true, "the curated row must survive a failed city lookup too");
    assert.equal(stored.international_buffer_min, 240);
    assert.deepEqual(
      store.writes.filter((w) => w.table === "airport_profiles"), [],
      "no airport_profiles write may follow a failed city lookup",
    );
  });

  it("GET /api/airport/search surfaces the failure instead of serving the static fallback (iata)", async () => {
    const store = airportStore(true);
    install(store);

    const r = await req("GET", "/api/airport/search?iata=TPE");
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      !Array.isArray(r.body?.airports) || r.body.airports.length === 0,
      "a failed read must not return airports at all",
    );
  });

  // resolveByGps has the identical shape; cover it through the same route.
  it("GET /api/airport/search surfaces the failure instead of serving the static fallback (gps)", async () => {
    const store = airportStore(true);
    install(store);

    const r = await req("GET", "/api/airport/search?lat=25.0777&lng=121.2327");
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("GET /api/airport/search surfaces the failure instead of serving the static fallback (city)", async () => {
    const store = airportStore(true);
    install(store);

    const r = await req("GET", "/api/airport/search?city=Taipei");
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("still resolves and serves the curated airport when the read SUCCEEDS", async () => {
    const store = airportStore(false);
    install(store);

    const r = await req("GET", "/api/airport/search?iata=TPE");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.airports.length, 1);
    assert.equal(r.body.airports[0].verified, true);
    assert.equal(r.body.airports[0].internationalBufferMin, 240);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. StampAwardEngine — a failed stamp_progress read must not reset the count
// ─────────────────────────────────────────────────────────────────────────────

const DEF_ID  = "dddddddd-0000-4000-8000-0000000000aa";
const TRIP_ID = "f1f1f1f1-0000-4000-8000-0000000000bb";

const REPEATABLE_DEF = {
  id:                  DEF_ID,
  slug:                "city_visited",
  name:                "City Visited",
  stamp_type:          "city",
  is_active:           true,
  is_repeatable:       true,
  max_awards_per_user: null,
  visibility_default:  "public",
  criteria_type:       "automatic",
};

/**
 * The legacy read-modify-write path in step 8 is only reached when the atomic
 * RPC is missing (PGRST202 — migration 2071 not applied). Force exactly that,
 * then fail the stamp_progress SELECT underneath it.
 */
function stampStore(opts: { failProgressRead: boolean }) {
  const store = makeStore(
    {
      feature_flags: [
        { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true },
      ],
      stamp_definitions:  [REPEATABLE_DEF],
      user_stamps:        [],
      stamp_award_events: [],
      stamp_progress:     [{ user_id: USER_ID, stamp_definition_id: DEF_ID, progress_count: 47 }],
      stamp_milestones:   [],
      profiles:           [{ id: USER_ID }],
      trips:              [{ id: TRIP_ID, status: "completed" }],
      stamp_catalog:      [],
    },
    {
      failSelectOn: opts.failProgressRead ? ["stamp_progress"] : [],
    },
  );
  store.client.rpc = async () => ({
    data: null,
    error: { message: "function increment_stamp_progress does not exist", code: "PGRST202" },
  });
  return store;
}

describe("3. StampAwardEngine — a failed stamp_progress read must not overwrite the count", () => {
  it("leaves an existing progress_count of 47 untouched when the read fails", async () => {
    const store = stampStore({ failProgressRead: true });

    const result = await awardStamp(store.client as SupabaseClient, {
      userId:         USER_ID,
      definitionSlug: "city_visited",
      sourceType:     "trips",
      sourceId:       TRIP_ID,
      awardReason:    "visited a city",
    });
    assert.equal(result.awarded, true, "the stamp award itself must still succeed");

    // Step 8 is fire-and-forget — give it room to do the damage if it is going to.
    await new Promise((r) => setTimeout(r, 120));

    const row = store.tables.stamp_progress.find(
      (p: any) => p.user_id === USER_ID && p.stamp_definition_id === DEF_ID,
    );
    assert.ok(row, "the progress row must still exist");
    assert.equal(
      row.progress_count, 47,
      `a failed read must not reset progress; it became ${row.progress_count}`,
    );

    const progressWrites = store.writes.filter((w) => w.table === "stamp_progress");
    assert.deepEqual(
      progressWrites, [],
      `no stamp_progress write may follow a failed read; got ${JSON.stringify(progressWrites)}`,
    );
  });

  it("still increments 47 -> 48 when the read SUCCEEDS (fallback path stays functional)", async () => {
    const store = stampStore({ failProgressRead: false });

    const result = await awardStamp(store.client as SupabaseClient, {
      userId:         USER_ID,
      definitionSlug: "city_visited",
      sourceType:     "trips",
      sourceId:       TRIP_ID,
      awardReason:    "visited a city",
    });
    assert.equal(result.awarded, true);

    await new Promise((r) => setTimeout(r, 120));

    const progressWrites = store.writes.filter((w) => w.table === "stamp_progress");
    assert.equal(progressWrites.length, 1, "the legacy fallback must still write once");
    assert.equal(progressWrites[0].row.progress_count, 48, "47 + 1");
  });
});

// ── Harness lifecycle ─────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  // Production installs pino-http (src/app.ts), so every handler can rely on
  // req.log. Mirror that guarantee here, silently.
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", profileRouter);
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});
