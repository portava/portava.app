/**
 * Live Pulse "Near You" gems must not disclose a non-public gem.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `GET /pulse/live?context=nearMe` read
 *
 *     .from("hidden_gems")
 *     .select("id, name, city, category, save_count, latitude, longitude")
 *     .eq("status", "active")            // and NOTHING about sensitivity_level
 *
 * and then emitted, per gem, its NAME and `"<n> km away"` computed by haversine
 * from the caller's own lat/lng to those EXACT coordinates. Neither half of
 * HiddenGemPrivacyGuard was reachable from this path:
 *
 *   - `mayDiscloseGemIdentity` says a gem may be NAMED only when it is active
 *     AND `sensitivity_level = 'public'` (or the viewer is the submitter) —
 *     the `hidden_gems_public_read` RLS policy of migration 0043, which the
 *     service client bypasses. This path named every active gem.
 *   - `resolveGemCoords` says a `protected` gem's coordinates are "NEVER
 *     returned publicly". A distance to a caller-CHOSEN point is those
 *     coordinates in another coordinate system: three requests from three
 *     positions trilaterate the gem. This path published one per request.
 *
 * The two sibling gem rails on the same endpoint (city gems, Compass picks)
 * name gems without reading sensitivity either; they emit no distance, so the
 * leak there is identity only.
 *
 * ── WHAT THE FIX IS ──────────────────────────────────────────────────────────
 * The query filters `sensitivity_level = 'public'`, and every row is put through
 * `mayDiscloseGemIdentity` in code before it becomes an item — so the guard is
 * reachable from this path rather than reimplemented next to it, and a future
 * change to the query alone cannot re-open it.
 *
 * Each case has a CONTROL with a public gem at the SAME coordinates, so a fix
 * that simply stopped returning gems cannot pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/livePulseGemDisclosure.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { _setTestClient } from "../lib/http.js";
import pulseRouter from "../routes/pulse.js";

const TOKEN  = "live-pulse-gem-token";
const VIEWER = "50000000-0000-4000-a000-000000000001";
const OWNER  = "50000000-0000-4000-a000-000000000002";

// Manila. Every gem below sits on this exact point, so radius is never the
// reason a gem is missing — sensitivity is.
const LAT = 14.5995;
const LNG = 120.9842;

const FLAGS = [
  { flag: "hidden_gems_enabled", enabled: true },
  { flag: "safe_return_enabled", enabled: false },
  { flag: "find_your_circle_enabled", enabled: false },
];

function gem(id: string, name: string, sensitivity: string, submittedBy: string | null = OWNER) {
  return {
    id, name,
    city: "Manila",
    category: "cafe",
    save_count: 5,
    status: "active",
    sensitivity_level: sensitivity,
    submitted_by: submittedBy,
    latitude: LAT,
    longitude: LNG,
    approx_latitude: 14.6,
    approx_longitude: 121.0,
  };
}

function client(gems: any[], callerId = VIEWER) {
  return makeFailClosedClient({
    rows: {
      feature_flags: FLAGS,
      hidden_gems: gems,
      blocks: [],
      events: [],
      event_rsvps: [],
      event_saves: [],
      trips: [],
      trip_members: [],
      trip_join_requests: [],
      buddy_bookings: [],
      rent_buddy_profiles: [],
      compass_user_profiles: [],
      profiles: [{ id: callerId }],
    },
    users: { [TOKEN]: callerId },
  });
}

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
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
    r.end();
  });
}

const NEAR_ME = `/api/pulse/live?context=nearMe&lat=${LAT}&lng=${LNG}`;

function gemItems(body: any): any[] {
  return ((body?.items as any[]) ?? []).filter((i) => i.item_type === "hidden_gem");
}

before(async () => {
  const app = express();
  app.use(express.json());
  // The `req.log` shim the real server installs — without it a route that logs
  // CRASHES and the 500-from-crash would masquerade as a deliberate refusal.
  app.use((req: any, _res, next) => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
    req.log = noop;
    next();
  });
  app.use("/api", pulseRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object", "server must be listening on a TCP port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  // _setTestClient also installs/clears the SERVICE client (lib/http.ts), so
  // there is nothing else to reset — and no second, differently-typed handle to
  // the fake to keep in sync.
  _setTestClient(null, false);
});

describe("GET /pulse/live?context=nearMe — gem disclosure", () => {
  it("CONTROL: a PUBLIC gem in range is still named and still carries its distance", async () => {
    const sc = client([gem("60000000-0000-4000-a000-000000000001", "Public Gem", "public")]);
    _setTestClient(sc, true);

    const r = await get(NEAR_ME);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const items = gemItems(r.body);
    assert.equal(items.length, 1, "vacuity guard: the rail must actually produce a gem");
    assert.equal(items[0].title, "Public Gem");
    assert.match(String(items[0].subtitle), /km away/, "the public gem's distance is legitimate");
  });

  for (const level of ["protected", "reveal_after_save", "reveal_after_acceptance", "approximate"]) {
    it(`a ${level} gem at the same point is neither named nor ranged`, async () => {
      const sc = client([
        gem("60000000-0000-4000-a000-000000000002", "Secret Gem", level),
        // A public gem alongside it, so "the rail returned nothing at all"
        // cannot be mistaken for "the rail withheld the right one".
        gem("60000000-0000-4000-a000-000000000003", "Public Gem", "public"),
      ]);
      _setTestClient(sc, true);
  
      const r = await get(NEAR_ME);
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      const titles = gemItems(r.body).map((i) => i.title);
      assert.ok(titles.includes("Public Gem"), `the rail still works: ${JSON.stringify(titles)}`);
      assert.ok(
        !titles.includes("Secret Gem"),
        `a ${level} gem must not be named on a public rail: ${JSON.stringify(titles)}`,
      );
      const leaked = gemItems(r.body).filter((i) => String(i.item_id).endsWith("002"));
      assert.equal(
        leaked.length, 0,
        "no item may carry a distance measured from a non-public gem's exact coordinates",
      );
    });
  }

  it("the SUBMITTER still sees their own non-public gem (the owner bypass survives)", async () => {
    const sc = client(
      [gem("60000000-0000-4000-a000-000000000004", "My Own Secret", "protected", VIEWER)],
      VIEWER,
    );
    _setTestClient(sc, true);

    const r = await get(NEAR_ME);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const titles = gemItems(r.body).map((i) => i.title);
    assert.ok(
      titles.includes("My Own Secret"),
      `the submitter already knows their own gem: ${JSON.stringify(titles)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The CITY and COMPASS gem rails — identity disclosure with no distance
//
// The nearMe cases above are also caught by the coordinate half of the guard
// (`resolveGemCoords` refuses to hand out exact coordinates for any non-public
// gem, so no distance can be computed). That makes them a poor witness for the
// IDENTITY half: hand-reverting mayDiscloseGemIdentity on the nearMe rail leaves
// them green. These two rails publish no distance at all, so naming the gem is
// the entire disclosure and the identity predicate is the only thing standing
// in the way.
//
// They filter with `.ilike("city", …)`, which `failClosedSupabase` deliberately
// does not model (and which is not mine to add). So this section uses a small
// local double in the style of livePulse.test.ts. It models only `{ error: null }`
// — fine here, because nothing in this section is about error handling.
// ─────────────────────────────────────────────────────────────────────────────

const CITY_TOKEN = "live-pulse-city-token";

function ilikeCapableClient(gems: any[], callerId = VIEWER) {
  const db: Record<string, any[]> = {
    feature_flags: FLAGS,
    hidden_gems: gems,
    blocks: [], events: [], event_rsvps: [], event_saves: [],
    trips: [], trip_members: [], trip_join_requests: [],
    buddy_bookings: [], rent_buddy_profiles: [],
    compass_user_profiles: [{ user_id: callerId, current_city: "Manila", preferred_cities: [] }],
    profiles: [{ id: callerId }],
  };
  function builder(table: string, seed: any[]): any {
    let rows = seed.map((r) => ({ ...r }));
    const b: any = {
      select: () => builder(table, rows),
      eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: any) => { rows = rows.filter((r) => r[c] !== v); return b; },
      in: (c: string, v: any[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      gt: (c: string, v: any) => { rows = rows.filter((r) => r[c] > v); return b; },
      lt: () => b,
      is: (c: string, v: any) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      or: () => b,
      order: () => b,
      limit: (n: number) => { rows = rows.slice(0, n); return b; },
      ilike: (c: string, pattern: string) => {
        const rx = new RegExp("^" + pattern.replace(/%/g, ".*") + "$", "i");
        rows = rows.filter((r) => typeof r[c] === "string" && rx.test(r[c]));
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: any) => res({ data: [...rows], error: null }),
    };
    return b;
  }
  return {
    auth: {
      getUser: async (token: string) =>
        token === CITY_TOKEN
          ? { data: { user: { id: callerId } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from: (t: string) => builder(t, db[t] ?? []),
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "no function" } }),
  };
}

function getAs(path: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { authorization: `Bearer ${token}` },
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
    r.end();
  });
}

const CITY_RAIL = "/api/pulse/live?context=currentCity&citySlug=manila";

describe("GET /pulse/live?context=currentCity — gem identity disclosure", () => {
  it("CONTROL: a PUBLIC Manila gem is named on the city rail", async () => {
    const sc = ilikeCapableClient([gem("70000000-0000-4000-a000-000000000001", "Public Gem", "public")]);
    _setTestClient(sc, true);

    const r = await getAs(CITY_RAIL, CITY_TOKEN);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const titles = ((r.body.items as any[]) ?? []).map((i) => i.title);
    assert.ok(titles.includes("Public Gem"), `vacuity guard — the rail must produce a gem: ${JSON.stringify(titles)}`);
  });

  for (const level of ["protected", "reveal_after_save", "reveal_after_acceptance", "approximate"]) {
    it(`a ${level} Manila gem is NOT named on the city rail`, async () => {
      const sc = ilikeCapableClient([
        gem("70000000-0000-4000-a000-000000000002", "Secret Gem", level),
        gem("70000000-0000-4000-a000-000000000003", "Public Gem", "public"),
      ]);
      _setTestClient(sc, true);
  
      const r = await getAs(CITY_RAIL, CITY_TOKEN);
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      const titles = ((r.body.items as any[]) ?? []).map((i) => i.title);
      assert.ok(titles.includes("Public Gem"), `the rail still works: ${JSON.stringify(titles)}`);
      assert.ok(
        !titles.includes("Secret Gem"),
        `naming a ${level} gem IS the disclosure — no coordinate needs to leave for it to be one: ${JSON.stringify(titles)}`,
      );
    });
  }

  it("the SUBMITTER is still shown their own non-public gem on the city rail", async () => {
    const sc = ilikeCapableClient(
      [gem("70000000-0000-4000-a000-000000000004", "My Own Secret", "protected", VIEWER)],
    );
    _setTestClient(sc, true);

    const r = await getAs(CITY_RAIL, CITY_TOKEN);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const titles = ((r.body.items as any[]) ?? []).map((i) => i.title);
    assert.ok(titles.includes("My Own Secret"), `owner bypass: ${JSON.stringify(titles)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The coordinate gate, stated honestly
//
// The nearMe rail applies BOTH halves of the guard, but given the identity half
// the coordinate half is currently redundant: mayDiscloseGemIdentity admits only
// public-or-owned gems and resolveGemCoords returns "exact" for exactly those,
// so no row can be admitted by one and refused by the other. Hand-reverting the
// coordinate check alone leaves every case above green — measured, fail 0 -> 0 —
// and this file does not pretend otherwise.
//
// What the coordinate check is actually for is the case where the identity
// predicate is later widened. So what is asserted here is the property the rail
// depends on, directly against the guard: for every sensitivity level a widened
// predicate might admit, resolveGemCoords still refuses "exact" — which is the
// condition the rail ranges on.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveGemCoords } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";

describe("resolveGemCoords — only a public (or own) gem yields rangeable coordinates", () => {
  const OTHER_VIEWER = "50000000-0000-4000-a000-000000000009";

  it("CONTROL: a public gem yields exact coordinates, which is what makes a distance legitimate", async () => {
    const r = await resolveGemCoords(gem("g1", "n", "public") as any, null, OTHER_VIEWER, OWNER, null);
    assert.equal(r.coordsPrecision, "exact");
    assert.equal(r.lat, LAT, "vacuity guard: it really returned the exact point");
  });

  it("CONTROL: the submitter's own protected gem still yields exact coordinates", async () => {
    const r = await resolveGemCoords(gem("g2", "n", "protected", OWNER) as any, null, OWNER, OWNER, null);
    assert.equal(r.coordsPrecision, "exact");
  });

  for (const level of ["protected", "approximate", "reveal_after_save", "reveal_after_acceptance"]) {
    it(`a ${level} gem never yields "exact" to a non-submitter, so it can never be ranged`, async () => {
      const r = await resolveGemCoords(gem("g3", "n", level) as any, null, OTHER_VIEWER, OWNER, null);
      assert.notEqual(
        r.coordsPrecision, "exact",
        `a ${level} gem's exact position must not be derivable from a distance`,
      );
    });
  }
});
