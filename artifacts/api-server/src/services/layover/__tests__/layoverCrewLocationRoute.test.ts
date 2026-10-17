/**
 * census-layover L132 / L158 / L166 / L203 / L124 / L277 — the crew location
 * share, end to end over `routes/layoverCrewLocation.ts`:
 *
 *   GET    /api/airport/sessions/:id/crew/location
 *   POST   /api/airport/sessions/:id/crew/location
 *   DELETE /api/airport/sessions/:id/crew/location
 *   PUT    /api/airport/sessions/:id/crew/location/precise-control
 *
 * Against `fakeLayoverDb`: no RLS, FK or trigger is modelled here — those are
 * 3996's and are executed on PGlite in src/test/layoverCrewLocationMigration.test.ts.
 * What this proves is that the ROUTE never relies on them: every rule the
 * schema enforces is enforced in the route as well, and fails closed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewLocationRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import crewLocationRouter from "../../../routes/layoverCrewLocation.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;

const TOKENS = { a: "tok-a", b: "tok-b", c: "tok-c", d: "tok-d" } as const;
const USERS = { a: "user-a", b: "user-b", c: "user-c", d: "user-d" } as const;
const SESS = { a: "session-a", b: "session-b", c: "session-c", d: "session-d" } as const;
const CREW = "crew-1";
const OTHER_CREW = "crew-2";
const H = 3_600_000;
const MIN = 60_000;

type Reply = { status: number; body: any };

function call(token: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const loc = (session: string, suffix = "") => `/api/airport/sessions/${session}/crew/location${suffix}`;
const iso = (ms: number) => new Date(ms).toISOString();

interface StageOpts {
  flagOn?: boolean;
  grants?: Record<string, any>[];
  controls?: Record<string, any>[];
  blocks?: Record<string, any>[];
  failures?: Record<string, { message: string; code?: string }>;
  memberOver?: Partial<Record<keyof typeof USERS, Record<string, any>>>;
  sessionOver?: Partial<Record<keyof typeof USERS, Record<string, any>>>;
  paused?: Array<keyof typeof USERS>;
  zones?: Record<string, any>[];
}

function stage(o: StageOpts = {}) {
  const now = Date.now();
  const s = (k: keyof typeof USERS, departH: number) =>
    sessionRow({ id: SESS[k], user_id: USERS[k], departure_time: iso(now + departH * H), ...(o.sessionOver?.[k] ?? {}) });
  const member = (k: keyof typeof USERS, crew: string, role: string) =>
    ({ crew_id: crew, user_id: USERS[k], session_id: SESS[k], role, joined_at: iso(now - 30 * MIN), left_at: null, ...(o.memberOver?.[k] ?? {}) });
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_crew_location_enabled", enabled: o.flagOn ?? true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [s("a", 9), s("b", 5), s("c", 6), s("d", 7)],
    layover_crews: [
      { id: CREW, city: "taoyuan", airport_ref: "TPE", created_by: USERS.a, created_session_id: SESS.a, title: "Ramen", meeting_point_label: "T2 food court", status: "open", max_members: 6, expires_at: iso(now + 8 * H), created_at: iso(now - H), updated_at: iso(now - H) },
      { id: OTHER_CREW, city: "taoyuan", airport_ref: "TPE", created_by: USERS.c, created_session_id: SESS.c, title: "Temples", meeting_point_label: null, status: "open", max_members: 6, expires_at: iso(now + 8 * H), created_at: iso(now - H), updated_at: iso(now - H) },
    ],
    layover_crew_members: [member("a", CREW, "owner"), member("b", CREW, "member"), member("c", OTHER_CREW, "owner")],
    layover_crew_location_grants: o.grants ?? [],
    layover_crew_location_controls: o.controls ?? [],
    layover_events: [],
    blocks: o.blocks ?? [],
    profiles: [
      { id: USERS.a, handle: "ann", name: "Ann", avatar_url: null },
      { id: USERS.b, handle: "bo", name: "Bo", avatar_url: null },
      { id: USERS.c, handle: "cy", name: "Cy", avatar_url: null },
    ],
    profile_privacy_settings: [{ user_id: USERS.a, show_real_name: true }],
    location_preferences: (["a", "b", "c", "d"] as const).map((k) => ({ user_id: USERS[k], location_mode: "city", sharing_paused: (o.paused ?? []).includes(k) })),
    protected_zones: o.zones ?? [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [TOKENS.a]: USERS.a, [TOKENS.b]: USERS.b, [TOKENS.c]: USERS.c, [TOKENS.d]: USERS.d },
      failures: o.failures ?? {},
    }),
    true,
  );
  return { tables, now };
}

function grantRow(k: "a" | "b", over: Record<string, any> = {}) {
  const now = Date.now();
  return {
    crew_id: CREW, user_id: USERS[k], session_id: SESS[k], purpose: "presence_in_context", precision: "area",
    label: k === "a" ? "Night market" : "Gate B12", lat: null, lng: null,
    granted_at: iso(now - 5 * MIN), expires_at: iso(now + 50 * MIN), ...over,
  };
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", crewLocationRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("the flag: seeded OFF, and stopping a share is never gated", () => {
  it("OFF: the read says the surface does not exist; the writes refuse; stop still works", async () => {
    const { tables } = stage({ flagOn: false, grants: [grantRow("a")] });
    const read = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.available, false);
    assert.equal(JSON.stringify(read.body).includes("Night market"), false);
    const share = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town", expiresAt: iso(Date.now() + 30 * MIN) });
    assert.equal(share.status, 404);
    assert.equal(share.body.error, "feature_disabled");
    const control = await call(TOKENS.a, "PUT", loc(SESS.a, "/precise-control"), { enabled: true });
    assert.equal(control.status, 404);
    const stop = await call(TOKENS.a, "DELETE", loc(SESS.a));
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });
});

describe("L132 — explicit, scoped, auto-expiring", () => {
  it("a traveller in no crew has nothing to share with", async () => {
    stage();
    const read = await call(TOKENS.d, "GET", loc(SESS.d));
    assert.equal(read.status, 200);
    assert.equal(read.body.inCrew, false);
    const share = await call(TOKENS.d, "POST", loc(SESS.d), { label: "Old town", expiresAt: iso(Date.now() + 30 * MIN) });
    assert.equal(share.status, 409);
    assert.equal(share.body.reason, "not_in_crew");
  });

  it("someone else's session is not found", async () => {
    stage();
    const read = await call(TOKENS.b, "GET", loc(SESS.a));
    assert.equal(read.status, 404);
  });

  it("an area share is stored without a coordinate and is seen by a crewmate, persisted not echoed", async () => {
    const { tables } = stage();
    const share = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Night market", expiresAt: iso(Date.now() + 60 * MIN), lat: 25.03, lng: 121.56 });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    assert.equal(tables.layover_crew_location_grants.length, 1);
    const row = tables.layover_crew_location_grants[0];
    assert.equal(row.precision, "area");
    assert.equal(row.purpose, "presence_in_context");
    assert.equal(row.lat, null);
    assert.equal(row.lng, null);
    assert.equal(row.session_id, SESS.a);

    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.inCrew, true);
    assert.equal(b.body.crewmates.length, 1);
    const seen = b.body.crewmates[0];
    assert.equal(seen.userId, USERS.a);
    assert.equal(seen.label, "Night market");
    assert.equal(seen.handle, "ann");
    assert.equal(seen.position, null);
    assert.equal(seen.ring, null);
    assert.equal(b.body.mine, null);

    const a = await call(TOKENS.a, "GET", loc(SESS.a));
    assert.equal(a.body.mine.label, "Night market");
    assert.equal(a.body.preciseControl.enabled, false, "off by default");
  });

  it("a body with no expiry, or one past four hours, is refused", async () => {
    stage();
    const pin = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town" });
    assert.equal(pin.status, 400);
    assert.equal(pin.body.reason, "expiry_required");
    const long = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town", expiresAt: iso(Date.now() + 5 * H) });
    assert.equal(long.status, 400);
    assert.equal(long.body.reason, "expiry_invalid");
  });

  it("audits the share with precision and times only — never the label or a coordinate", async () => {
    const { tables } = stage({ controls: [{ crew_id: CREW, user_id: USERS.a, precise_sharing_enabled: true }] });
    await call(TOKENS.a, "POST", loc(SESS.a), { label: "Gate B12", precision: "exact", expiresAt: iso(Date.now() + 30 * MIN), lat: 25.0797, lng: 121.2342 });
    const ev = tables.layover_events.find((e) => e.event_type === "crew_location_shared");
    assert.ok(ev, "an audit row is written");
    const meta = JSON.stringify(ev.metadata);
    assert.equal(meta.includes("Gate B12"), false);
    assert.equal(meta.includes("25.07"), false);
    assert.deepEqual(Object.keys(ev.metadata).sort(), ["crewId", "endsAt", "precision"]);
  });
});

describe("L158 — scoped to the session, and gone when its scope ends", () => {
  it("is cut at boarding", async () => {
    const boarding = Date.now() + 30 * MIN;
    stage({ sessionOver: { a: { boarding_time: iso(boarding) } } });
    const share = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town", expiresAt: iso(Date.now() + 60 * MIN) });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    assert.equal(share.body.endsBecause, "boarding");
    assert.equal(Math.abs(Date.parse(share.body.mine.endsAt) - boarding) < 1000, true);
  });

  it("an expired share is neither shown nor kept", async () => {
    const { tables } = stage({ grants: [grantRow("a", { expires_at: iso(Date.now() - MIN) })] });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(tables.layover_crew_location_grants.length, 0, "purged on read");
  });

  it("a member who left the crew is neither shown nor kept", async () => {
    const { tables } = stage({ grants: [grantRow("a")], memberOver: { a: { left_at: iso(Date.now() - MIN) } } });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("a sharer whose layover ended is neither shown nor kept", async () => {
    const { tables } = stage({ grants: [grantRow("a")], sessionOver: { a: { status: "completed" } } });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("stop sharing deletes the row and is audited", async () => {
    const { tables } = stage({ grants: [grantRow("a")] });
    const stop = await call(TOKENS.a, "DELETE", loc(SESS.a));
    assert.equal(stop.status, 200);
    assert.equal(tables.layover_crew_location_grants.length, 0);
    assert.ok(tables.layover_events.some((e) => e.event_type === "crew_location_stopped"));
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
  });

  it("an unreadable grant table is a 503, never an empty crew", async () => {
    stage({ failures: { "layover_crew_location_grants:select": { message: "boom" } } });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.status, 503);
  });
});

describe("L166 — precise sharing is a separate control, off by default", () => {
  it("exact refuses until the control is on, stores the point when it is, and is deleted when it goes off", async () => {
    const { tables } = stage();
    const body = { label: "Gate B12", precision: "exact", expiresAt: iso(Date.now() + 30 * MIN), lat: 25.0797, lng: 121.2342 };
    const refused = await call(TOKENS.a, "POST", loc(SESS.a), body);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, "precise_control_off");
    assert.equal(tables.layover_crew_location_grants.length, 0);

    const on = await call(TOKENS.a, "PUT", loc(SESS.a, "/precise-control"), { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.preciseControl.enabled, true);

    const shared = await call(TOKENS.a, "POST", loc(SESS.a), body);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(tables.layover_crew_location_grants[0].lat, 25.0797);
    assert.equal(tables.layover_crew_location_grants[0].purpose, "live_session_sharing");
    const seen = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.deepEqual(seen.body.crewmates[0].position, { lat: 25.0797, lng: 121.2342 });

    const off = await call(TOKENS.a, "PUT", loc(SESS.a, "/precise-control"), { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(tables.layover_crew_location_grants.length, 0, "turning precise off ends the precise share");
    const after = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(after.body.crewmates.length, 0);
  });

  it("the control body is strict", async () => {
    stage();
    const bad = await call(TOKENS.a, "PUT", loc(SESS.a, "/precise-control"), { enabled: "yes" });
    assert.equal(bad.status, 400);
  });

  it("a point inside a protected place is stored without its coordinate", async () => {
    const { tables } = stage({
      controls: [{ crew_id: CREW, user_id: USERS.a, precise_sharing_enabled: true }],
      zones: [{ id: "z1", category: "private_residence", action: null, privacy_floor: null, shape: "circle", center_lat: 25.0797, center_lng: 121.2342, radius_meters: 400, ring: null, jurisdiction: null, policy_ref: null, active: true }],
    });
    const shared = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Somewhere", precision: "exact", expiresAt: iso(Date.now() + 30 * MIN), lat: 25.0797, lng: 121.2342 });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.downgraded, "protected_zone");
    assert.equal(tables.layover_crew_location_grants[0].lat, null);
  });
});

describe("L203 / L124 — membership and the explicit grant decide who sees what", () => {
  it("someone in another crew sees nothing of this crew's shares", async () => {
    stage({ grants: [grantRow("a")] });
    const c = await call(TOKENS.c, "GET", loc(SESS.c));
    assert.equal(c.status, 200);
    assert.equal(c.body.crewmates.length, 0);
    assert.equal(JSON.stringify(c.body).includes("Night market"), false);
  });

  it("a block in either direction withholds both shares", async () => {
    stage({ grants: [grantRow("a"), grantRow("b")], blocks: [{ blocker_id: USERS.b, blocked_id: USERS.a }] });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(b.body.mine.label, "Gate B12");
    const a = await call(TOKENS.a, "GET", loc(SESS.a));
    assert.equal(a.body.crewmates.length, 0);
  });

  it("an unreadable block list withholds every crewmate, and says so", async () => {
    stage({ grants: [grantRow("a"), grantRow("b")], failures: { "blocks:select": { message: "boom" } } });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.status, 200);
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(b.body.crewmatesWithheld, "blocks_unreadable");
    assert.equal(b.body.mine.label, "Gate B12");
  });

  it("a crewmate who paused sharing is withheld, and cannot start a share", async () => {
    stage({ grants: [grantRow("a")], paused: ["a"] });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates.length, 0);
    const share = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town", expiresAt: iso(Date.now() + 30 * MIN) });
    assert.equal(share.status, 409);
    assert.equal(share.body.reason, "sharing_paused");
  });

  it("a venue share is drawn as a ring, never as the point that was sent", async () => {
    const { tables } = stage();
    await call(TOKENS.a, "POST", loc(SESS.a), { label: "Café", precision: "venue", expiresAt: iso(Date.now() + 30 * MIN), lat: 25.03301, lng: 121.56541 });
    assert.notEqual(tables.layover_crew_location_grants[0].lat, 25.03301);
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates[0].position, null);
    assert.equal(b.body.crewmates[0].ring.radiusMeters, 150);
  });
});

describe("L277 — proximity inside the crew, after the viewer's own opt-in", () => {
  it("a bucket, only when both share a point", async () => {
    stage({
      grants: [
        grantRow("a", { precision: "venue", lat: 25.0335, lng: 121.5655 }),
        grantRow("b", { precision: "venue", lat: 25.0337, lng: 121.5657 }),
      ],
    });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.crewmates[0].proximity, "together");
    stage({ grants: [grantRow("a", { precision: "venue", lat: 25.0335, lng: 121.5655 }), grantRow("b")] });
    const b2 = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b2.body.crewmates[0].proximity, null, "the viewer shares no point, so no proximity");
  });
});

describe("the read is this crew's, and only this crew's", () => {
  it("other crews' shares are not read at all — thirteen of them cannot fill this crew's read", async () => {
    const others = Array.from({ length: 13 }, (_, i) => ({
      ...grantRow("b"), crew_id: `crew-other-${i}`, user_id: `user-other-${i}`, session_id: `session-other-${i}`, label: `Elsewhere ${i}`,
    }));
    stage({ grants: [grantRow("a"), ...others] });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.crewmates.length, 1);
    assert.equal(JSON.stringify(b.body).includes("Elsewhere"), false);
  });

  it("L277: a viewer who shares nothing gets no proximity for anyone", async () => {
    stage({ grants: [grantRow("a", { precision: "venue", lat: 25.0335, lng: 121.5655 })] });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.body.mine, null);
    assert.equal(b.body.crewmates[0].proximity, null);
  });
});

// census-layover L294 (wave 5): `publishableUserIds` is a LayoverRead. A degraded
// consent read is "could not check", never "nobody consented" and never "paused".
describe("L294 — an unreadable sharing-preferences read is said as one", () => {
  it("the read withholds every crewmate and names the consent read", async () => {
    stage({ grants: [grantRow("a"), grantRow("b")], failures: { "location_preferences:select": { message: "boom" } } });
    const b = await call(TOKENS.b, "GET", loc(SESS.b));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.crewmates.length, 0);
    assert.equal(b.body.crewmatesWithheld, "sharing_preferences_unreadable");
  });

  it("a share whose sharer's own settings cannot be read is a 503, not 'paused'", async () => {
    stage({ failures: { "location_preferences:select": { message: "boom" } } });
    const share = await call(TOKENS.a, "POST", loc(SESS.a), { label: "Old town", expiresAt: iso(Date.now() + 30 * MIN) });
    assert.equal(share.status, 503, JSON.stringify(share.body));
    assert.notEqual(share.body.reason, "sharing_paused");
  });
});
