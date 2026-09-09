/**
 * Safe Return × Locate My Friends — the cross-feature boundary.
 *
 * ─── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `routes/safeReturn.ts` GET /api/me/safe-return/contacts/:userId/passport
 *   → services/passport/PassportConsumerProjections.buildConsumerProjection("safety")
 *   → services/passport/PassportProjectionService.buildPassportProjection
 *   → loadTravelerActivity → loadActiveCrewSession
 *   → SELECT locate_friends_members, locate_friends_sessions
 *
 * Those two tables are Locate My Friends storage (Map spec §12), created and
 * flagged by migration 2219_locate_friends_sessions.sql. The SELECT consulted
 * NEITHER `locate_friends_enabled` NOR whether 2219 had been applied, and the
 * `safety` variant then discarded the traveler state entirely. Safe Return —
 * `safe_return_enabled` TRUE in production — carried an ungated read of a
 * disabled feature's storage whose answer it could not use. Applying 2219 on
 * 2026-09-08 stopped the read failing; it did not stop the read.
 *
 * ─── THE CONTRACT NOW ────────────────────────────────────────────────────────
 *
 * OWNERSHIP FIRST. Map spec §23 lists the two as SEPARATE purpose-bound
 * location scopes ("Locate My Friends: temporary group-scoped
 * approximate/precise" / "Safe Return: purpose-bound precise location"), and
 * 2219's header states that every read of its tables resolves the caller's
 * membership first. Safe Return does neither and needs neither, so it declares
 * `crewSignal: "excluded"` and the read does not happen on its path AT ANY FLAG
 * VALUE. That is the ownership half, and it is what these tests pin.
 *
 * The Passport assembler keeps the §5 `with_crew` state — Passport spec §5
 * names it — but only behind, in order:
 *   1. the consumer's declared `crewSignal`,
 *   2. the viewer's §23 / TABLE 24 location gate, and
 *   3. `capability = locate_friends_enabled ON && 2219 schema ready`,
 * all fail-closed.
 *
 * ─── WHY THE TESTS LOOK LIKE THIS ────────────────────────────────────────────
 *
 * Every case asserts the RESPONSE / RETURN SHAPE, not merely that nothing
 * threw, and every case additionally asserts which TABLES the client was asked
 * for — a gate that returns the right shape while still issuing the SELECT has
 * not closed anything. `controls` below prove the recorder is not vacuous: with
 * the identical fixture and no exclusion, the read IS issued and the state IS
 * `with_crew`.
 *
 * The route cases install the same `req.log` shim the real server installs; a
 * route without it CRASHES and the resulting 500 would masquerade as
 * fail-closed.
 *
 * Run: node --import tsx/esm --test src/test/safeReturnLocateFriendsBoundary.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { buildConsumerProjection } from "../services/passport/PassportConsumerProjections.js";
import { resetSchemaCapabilityMemo } from "../lib/capability/schemaCapability.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 2 * 3_600_000).toISOString();
const FAKE_TOKEN = "safe-return-boundary-token";

/** The Locate My Friends tables no Safe Return request may ever touch. */
const LOCATE_TABLES = [
  "locate_friends_members",
  "locate_friends_sessions",
  "locate_friends_positions",
  "locate_friends_audit",
];

// ── Fixture ───────────────────────────────────────────────────────────────────

interface DbOpts {
  /** feature_flags rows, verbatim. Absent flags read as `absent` → refused. */
  flags?: Record<string, boolean>;
  /** Stage an active, opted-in, un-expired crew session for OWNER. */
  crewSession?: boolean;
  /** profile_privacy_settings row for OWNER (absent = show-by-default). */
  privacy?: Record<string, any>;
  /**
   * Tables that answer an error instead of rows.
   *   "all"  — every terminal call errors, so the CAPABILITY PROBE also fails
   *            (this is "schema unavailable").
   *   "list" — only list resolution errors, so the probe SUCCEEDS and the
   *            actual read then fails (this is "database read error").
   */
  errorTables?: Record<string, { code: string; message: string; mode: "all" | "list" }>;
  /** Link VIEWER and OWNER as safe-return contacts so the route authorises. */
  safetyLink?: boolean;
  /**
   * Make VIEWER and OWNER friends, so the REAL permission engine grants
   * `canSeeLocationContext` on the route path.
   *
   * WITHOUT THIS THE ROUTE MATRIX IS VACUOUS. A stranger fails the audience
   * gate anyway, so every route case would pass with Safe Return's
   * `crewSignal: "excluded"` hand-reverted — the tests would be measuring gate
   * 2 and reporting on gate 1. Friends clear gate 2, so on the route only the
   * exclusion stands between Safe Return and Locate storage.
   */
  friends?: boolean;
}

function makeBoundaryDb(opts: DbOpts = {}) {
  const touched: string[] = [];
  const crew = opts.crewSession === true;
  const inner = makePassportDb({
    profiles: [
      {
        id: OWNER, handle: "owner", display_name: "Owner", name: "Owner",
        home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
        is_official: false, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true, verified: true,
        created_at: "2023-01-01",
      },
      {
        id: VIEWER, handle: "viewer", display_name: "Viewer", name: "Viewer",
        home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
        is_official: false, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true, created_at: "2023-01-01",
      },
    ],
    feature_flags: Object.entries(opts.flags ?? {}).map(([flag, enabled]) => ({
      flag, key: flag, enabled,
    })),
    profile_privacy_settings: opts.privacy ? [{ user_id: OWNER, ...opts.privacy }] : [],
    locate_friends_members: crew
      ? [{ session_id: SESSION, user_id: OWNER, left_at: null }]
      : [],
    locate_friends_sessions: crew
      ? [{ id: SESSION, started_at: PAST, expires_at: FUTURE, ended_at: null }]
      : [],
    // user_friendships is keyed (user_a, user_b) with the ids sorted; OWNER
    // sorts before VIEWER.
    user_friendships: opts.friends ? [{ user_a: OWNER, user_b: VIEWER }] : [],
    safe_return_sessions: opts.safetyLink ? [{ id: "sr-1", user_id: VIEWER }] : [],
    safe_return_contacts: opts.safetyLink
      ? [{ id: "src-1", session_id: "sr-1", contact_user_id: OWNER }]
      : [],
  });

  /** A builder whose every terminal call resolves to a driver error. */
  function errorBuilder(err: { code: string; message: string }, mode: "all" | "list") {
    const answer = async () => ({ data: null, error: err });
    const b: any = new Proxy(
      {
        maybeSingle: () => (mode === "all" ? answer() : Promise.resolve({ data: null, error: null })),
        single: () => (mode === "all" ? answer() : Promise.resolve({ data: null, error: null })),
        then: (onF: any, onR: any) => answer().then(onF, onR),
      },
      {
        get(target: any, prop: string) {
          if (prop in target) return target[prop];
          return () => b;
        },
      },
    );
    return b;
  }

  const client: any = {
    from(table: string) {
      touched.push(table);
      const err = opts.errorTables?.[table];
      if (err) return errorBuilder({ code: err.code, message: err.message }, err.mode);
      return inner.from(table);
    },
    auth: {
      getUser: async (token: string) =>
        token === FAKE_TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
    /** Every table this client was asked for, in order. */
    touched,
  };
  return client;
}

/** Which Locate My Friends tables were read on this request. */
function locateTablesTouched(db: any): string[] {
  return [...new Set<string>(db.touched)].filter((t) => LOCATE_TABLES.includes(t));
}

// ── Viewer resolutions (the resolver itself is covered elsewhere) ─────────────

function perms(over: Partial<ViewerPermissions> = {}): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false, ...over,
  };
}
const selfRes: ViewerResolution = {
  context: "self", permissions: perms(), sharedTrip: false, sharedEvent: false,
  ownerIsTripHost: false, buddyRole: null,
};
/** A follower who MAY see location context — the audience gate's "allow" side. */
const followerRes: ViewerResolution = {
  context: "following",
  permissions: perms({ relationshipLabel: "following", canSeeLocationContext: true }),
  sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null,
};
/** The same follower after the owner's location opt-out is applied by the DB row. */
const resolver = (res: ViewerResolution) => async () => res;

beforeEach(() => { resetSchemaCapabilityMemo(); });

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — the harness can see the read, and can reach it
// ─────────────────────────────────────────────────────────────────────────────

describe("controls — the recorder and the read are both real", () => {
  it("flag ON + schema ready + no exclusion ⇒ the crew read IS issued and with_crew IS projected", async () => {
    const db = makeBoundaryDb({ flags: { locate_friends_enabled: true }, crewSession: true });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.deepEqual(p.travelerState, {
      state: "with_crew",
      label: "With Crew",
      city: null,
      validFrom: PAST,
      expiresAt: FUTURE,
    });
    assert.deepEqual(
      locateTablesTouched(db).sort(),
      ["locate_friends_members", "locate_friends_sessions"],
      "the control must actually reach Locate storage, or every case below is vacuous",
    );
  });

  it("crewSignal: 'excluded' suppresses the read even with the flag ON and the session staged", async () => {
    const db = makeBoundaryDb({ flags: { locate_friends_enabled: true }, crewSession: true });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
      crewSignal: "excluded",
    }))!;
    assert.equal(p.travelerState?.state, "home");
    assert.equal(p.travelerState?.label, "Home");
    assert.equal(p.travelerState?.city, null);
    assert.equal(p.travelerState?.validFrom, null);
    assert.equal(p.travelerState?.expiresAt, null);
    assert.deepEqual(locateTablesTouched(db), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MATRIX, at the assembler
// ─────────────────────────────────────────────────────────────────────────────

describe("the §5 crew signal — five states, none of which may disclose presence", () => {
  it("1. Safe Return ON, Locate Friends OFF ⇒ no read, state falls through to home", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: false },
      crewSession: true,
    });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.deepEqual(p.travelerState, {
      state: "home", label: "Home", city: null, validFrom: null, expiresAt: null,
    });
    assert.deepEqual(locateTablesTouched(db), [], "a dark feature's storage is not read");
  });

  it("1b. no flag row at all reads as absent, not as enabled", async () => {
    const db = makeBoundaryDb({ flags: { safe_return_enabled: true }, crewSession: true });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.equal(p.travelerState?.state, "home");
    assert.deepEqual(locateTablesTouched(db), []);
  });

  it("2. Safe Return ON, Locate Friends ON but its schema is UNAVAILABLE ⇒ probe refuses, no crew state", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      errorTables: {
        locate_friends_members: {
          code: "PGRST205",
          message: "Could not find the table 'public.locate_friends_members' in the schema cache",
          mode: "all",
        },
        locate_friends_sessions: {
          code: "PGRST205",
          message: "Could not find the table 'public.locate_friends_sessions' in the schema cache",
          mode: "all",
        },
      },
    });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.deepEqual(p.travelerState, {
      state: "home", label: "Home", city: null, validFrom: null, expiresAt: null,
    });
    // The PROBE is allowed to touch the tables — that is how readiness is
    // established. What must not happen is the crew SELECT, and the state must
    // not be with_crew.
    assert.notEqual(p.travelerState?.state, "with_crew");
  });

  it("3. both ON and the schema ready ⇒ the state IS projected, and still carries no city", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
    });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.deepEqual(p.travelerState, {
      state: "with_crew",
      label: "With Crew",
      city: null,
      validFrom: PAST,
      expiresAt: FUTURE,
    });
  });

  it("4. a database read error on the crew tables ⇒ refused, never 'no session' by accident", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      errorTables: {
        // mode "list": the capability probe (maybeSingle) succeeds, so the
        // capability resolves ENABLED and the failure is in the read itself.
        locate_friends_members: { code: "57014", message: "canceling statement due to statement timeout", mode: "list" },
        locate_friends_sessions: { code: "57014", message: "canceling statement due to statement timeout", mode: "list" },
      },
    });
    const p = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    assert.deepEqual(p.travelerState, {
      state: "home", label: "Home", city: null, validFrom: null, expiresAt: null,
    });
  });

  it("5. the owner's privacy settings deny location ⇒ no read and no crew state for that viewer", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      privacy: { show_current_city: false, show_home_country: true },
    });
    const p = (await buildPassportProjection(db, OWNER, VIEWER, {
      resolveViewerContext: resolver(followerRes),
    }))!;
    assert.equal(p.travelerState?.state, "home", "an opted-out owner is not 'With Crew' to a viewer");
    assert.equal(p.travelerState?.label, "Home");
    assert.equal(p.travelerState?.city, null);
    assert.equal(p.travelerState?.validFrom, null);
    assert.equal(p.travelerState?.expiresAt, null);
    assert.deepEqual(locateTablesTouched(db), [], "location storage is not read for a denied viewer");
  });

  it("5b. a viewer with no location-context permission is denied even with the opt-in present", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      privacy: { show_current_city: true, show_home_country: true },
    });
    const p = (await buildPassportProjection(db, OWNER, VIEWER, {
      resolveViewerContext: resolver({
        ...followerRes,
        permissions: perms({ relationshipLabel: "stranger", canSeeLocationContext: false }),
      }),
    }))!;
    assert.equal(p.travelerState?.state, "home");
    assert.deepEqual(locateTablesTouched(db), []);
  });

  it("5c. the same viewer WITH the opt-in and the permission does receive it — the gate is not a wall", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      privacy: { show_current_city: true, show_home_country: true },
    });
    const p = (await buildPassportProjection(db, OWNER, VIEWER, {
      resolveViewerContext: resolver(followerRes),
    }))!;
    assert.equal(p.travelerState?.state, "with_crew");
    assert.equal(p.travelerState?.city, null, "crew presence never carries a city");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MATRIX, at the Safe Return route
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

function request(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_TOKEN}` },
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

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs. Without it every route that logs
  // CRASHES, and a 500-from-crash reads exactly like a fail-closed refusal.
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", safeReturnRouter);
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server.close(); });

const SAFETY_PATH = `/api/me/safe-return/contacts/${OWNER}/passport`;

/** The §21 TABLE 22 safety shape: identity + relationship, nothing else. */
function assertSafetyShape(body: any) {
  assert.ok(body && typeof body === "object", "a JSON body");
  const p = body.passport;
  assert.ok(p && typeof p === "object", "a passport object");
  assert.deepEqual(
    Object.keys(p).sort(),
    ["blocked", "handle", "userId", "variant", "verified", "viewerContext"],
    "the safety variant carries identity + relationship and NOTHING location-derived",
  );
  assert.equal(p.variant, "safety");
  assert.equal(p.userId, OWNER);
  assert.equal(p.handle, "owner");
  assert.equal(p.blocked, false);
  assert.equal((p as any).travelerState, undefined);
  assert.equal((p as any).city, undefined);
}

function routeCase(name: string, opts: DbOpts) {
  it(name, async () => {
    const db = makeBoundaryDb({ friends: true, ...opts, safetyLink: true });
    _setTestClient(db, true);
    _setTestServiceClient(db);
    const res = await request(SAFETY_PATH);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertSafetyShape(res.body);
    assert.deepEqual(
      locateTablesTouched(db),
      [],
      "Safe Return must never read Locate My Friends storage, at any flag value",
    );
  });
}

describe("GET /api/me/safe-return/contacts/:userId/passport — Safe Return owns its contract", () => {
  const SR_ON = { safe_return_enabled: true };

  routeCase("1. Safe Return ON + Locate Friends OFF", {
    flags: { ...SR_ON, locate_friends_enabled: false }, crewSession: true,
  });

  routeCase("2. Safe Return ON + Locate Friends schema unavailable", {
    flags: { ...SR_ON, locate_friends_enabled: true },
    crewSession: true,
    errorTables: {
      locate_friends_members: { code: "PGRST205", message: "Could not find the table 'public.locate_friends_members' in the schema cache", mode: "all" },
      locate_friends_sessions: { code: "PGRST205", message: "Could not find the table 'public.locate_friends_sessions' in the schema cache", mode: "all" },
    },
  });

  routeCase("3. both ON and the schema ready — turning the flag on does NOT hand the read back", {
    flags: { ...SR_ON, locate_friends_enabled: true }, crewSession: true,
  });

  routeCase("4. a database read error on the crew tables", {
    flags: { ...SR_ON, locate_friends_enabled: true },
    crewSession: true,
    errorTables: {
      locate_friends_members: { code: "57014", message: "canceling statement due to statement timeout", mode: "list" },
      locate_friends_sessions: { code: "57014", message: "canceling statement due to statement timeout", mode: "list" },
    },
  });

  routeCase("5. the owner's privacy settings deny location", {
    flags: { ...SR_ON, locate_friends_enabled: true },
    crewSession: true,
    privacy: { show_current_city: false, show_home_country: false },
  });

  it("CONTROL: the route fixture really does clear the audience gate — the same db, unexcluded, reads Locate storage", async () => {
    // No injected resolver: the REAL permission engine runs over the same rows
    // the route cases use. If this ever stops touching Locate storage, the
    // route matrix above has gone vacuous and is measuring gate 2 instead of
    // Safe Return's exclusion.
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      friends: true,
      safetyLink: true,
    });
    const p = (await buildPassportProjection(db, OWNER, VIEWER))!;
    assert.equal(p.travelerState?.state, "with_crew");
    assert.equal(p.travelerState?.city, null);
    assert.deepEqual(
      locateTablesTouched(db).sort(),
      ["locate_friends_members", "locate_friends_sessions"],
    );
  });

  it("without a safety relationship the route refuses BEFORE projecting anything", async () => {
    const db = makeBoundaryDb({
      flags: { safe_return_enabled: true, locate_friends_enabled: true },
      crewSession: true,
      safetyLink: false,
    });
    _setTestClient(db, true);
    _setTestServiceClient(db);
    const res = await request(SAFETY_PATH);
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, "forbidden");
    assert.deepEqual(locateTablesTouched(db), []);
  });

  it("the safety projection is asked for with crewSignal 'excluded' — asserted through the assembler", async () => {
    // The route's own call is covered above; this pins the same contract at the
    // consumer-projection seam so a refactor of either side is caught.
    const db = makeBoundaryDb({ flags: { locate_friends_enabled: true }, crewSession: true });
    const p = (await buildConsumerProjection(db, "safety", OWNER, VIEWER, {
      resolveViewerContext: resolver(selfRes),
      crewSignal: "excluded",
    }))!;
    assert.equal(p.variant, "safety");
    assert.deepEqual(locateTablesTouched(db), []);
  });
});
