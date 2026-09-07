/**
 * §21 / §35 consumer-projection ADOPTION — the four surfaces that used to
 * rebuild identity, and the gates that let them ask.
 *
 * `passportConsumerProjections.test.ts` already proves each VARIANT is stripped
 * to its TABLE 22 allow-list. This suite proves the other half of §35's
 * canonical architecture rule: that Discovery, Compass, Telegraph and Safety
 * REQUEST that projection rather than assembling their own identity payload,
 * and that the surface gate deciding whether they may ask is server-side,
 * fail-closed, and lives in exactly one place.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * A real Express server starts on a random port per block; fetch() calls it.
 * The fake Supabase client is injected through http.ts `_setTestClient`.
 *
 * Run: node --import tsx/esm --test src/test/passportConsumerAdoption.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import {
  allowDiscoveryPersonCard,
  allowTelegraphHeader,
  allowSafetyContext,
} from "../services/passport/PassportConsumerAccess.js";
import discoverySearchRouter from "../routes/discoverySearch.js";
import compassRouter from "../routes/compass.js";
import telegraphRouter from "../routes/telegraph.js";
import safeReturnRouter from "../routes/safeReturn.js";

const VIEWER  = "aaaaaaaa-0000-0000-0000-00000000000a";
const SUBJECT = "bbbbbbbb-0000-0000-0000-00000000000b";
const STRANGER = "cccccccc-0000-0000-0000-00000000000c";
const THREAD  = "dddddddd-0000-0000-0000-00000000000d";
const SESSION_MINE  = "eeeeeeee-0000-0000-0000-00000000000e";
const SESSION_THEIRS = "ffffffff-0000-0000-0000-00000000000f";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function profileRow(id: string, over: Record<string, any> = {}) {
  return {
    id,
    handle: `h_${id.slice(0, 4)}`,
    username: `h_${id.slice(0, 4)}`,
    display_name: "Real Name",
    name: "Real Name",
    avatar_url: "https://x/a.png",
    cover_photo_url: null,
    verified: true,
    verified_at: "2024-01-01",
    verification_level: "id_verified",
    home_city: "Hanoi",
    home_country: "Vietnam",
    current_city: "Da Nang",
    is_official: false,
    is_private: false,
    passport_visibility: "public",
    show_profile_picture_publicly: true,
    account_status: "active",
    interests: ["Nightlife"],
    availability_tags: [],
    spoken_languages: ["English"],
    travel_pace: "packed",
    planning_style: "planner",
    budget_style: "budget",
    travel_group_style: ["social"],
    open_to_meet: true,
    buddy_verified_at: null,
    created_at: "2023-01-01",
    ...over,
  };
}

/** Base tables every route in this suite touches. */
function baseTables(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    profiles: [profileRow(VIEWER), profileRow(SUBJECT), profileRow(STRANGER)],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    message_thread_members: [],
    safe_return_sessions: [],
    safe_return_contacts: [],
    feature_flags: [{ flag: "safe_return_enabled", enabled: true }],
    user_account_states: [],
    blocks: [],
    ...over,
  };
}

function db(over: Record<string, any[]> = {}, viewerId: string | null = VIEWER) {
  const client = makePassportDb(baseTables(over));
  client.auth = {
    getUser: async () => ({
      data: { user: viewerId ? { id: viewerId } : null },
      error: viewerId ? null : { message: "no user" },
    }),
  };
  return client;
}

/** Same client, but every read of `table` resolves as a DB error. */
function dbFailingOn(table: string, over: Record<string, any[]> = {}) {
  const client = db(over);
  const realFrom = client.from.bind(client);
  client.from = (t: string) => {
    if (t !== table) return realFrom(t);
    const err = { data: null, error: { message: `boom: ${t}` }, count: 0 };
    const b: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (onF: any, onR: any) => Promise.resolve(err).then(onF, onR);
          if (prop === "maybeSingle" || prop === "single") return async () => err;
          return () => b;
        },
      },
    );
    return b;
  };
  return client;
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function makeApp(client: any): Express {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", discoverySearchRouter);
  app.use("/api", compassRouter);
  app.use("/api", telegraphRouter);
  app.use("/api", safeReturnRouter);
  return app;
}

const AUTH = { Authorization: "Bearer test-token" };

// ─────────────────────────────────────────────────────────────────────────────
// A. The gates — one implementation, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("allowDiscoveryPersonCard — Discovery + Compass share one gate", () => {
  it("allows a subject with no privacy rows (the product default)", async () => {
    assert.deepEqual(await allowDiscoveryPersonCard(db(), SUBJECT), { allowed: true });
  });

  it("denies a subject who opted out of profile discovery", async () => {
    const d = await allowDiscoveryPersonCard(
      db({ profile_privacy_settings: [{ user_id: SUBJECT, allow_profile_discovery: false }] }),
      SUBJECT,
    );
    assert.deepEqual(d, { allowed: false, reason: "not_discoverable" });
  });

  it("denies an age-restricted subject (viewer age is unresolvable here)", async () => {
    const d = await allowDiscoveryPersonCard(
      db({ user_privacy_settings: [{ user_id: SUBJECT, age_restriction_enabled: true }] }),
      SUBJECT,
    );
    assert.deepEqual(d, { allowed: false, reason: "not_discoverable" });
  });

  it("FAILS CLOSED when the discovery opt-out cannot be read", async () => {
    const d = await allowDiscoveryPersonCard(dbFailingOn("profile_privacy_settings"), SUBJECT);
    assert.deepEqual(d, { allowed: false, reason: "check_failed" });
  });

  it("FAILS CLOSED when the age-restriction row cannot be read", async () => {
    const d = await allowDiscoveryPersonCard(dbFailingOn("user_privacy_settings"), SUBJECT);
    assert.deepEqual(d, { allowed: false, reason: "check_failed" });
  });
});

describe("allowTelegraphHeader — the conversation is the authorisation", () => {
  const bothIn = {
    message_thread_members: [
      { thread_id: THREAD, user_id: VIEWER, left_at: null },
      { thread_id: THREAD, user_id: SUBJECT, left_at: null },
    ],
  };

  it("allows two present members of the same thread", async () => {
    assert.deepEqual(await allowTelegraphHeader(db(bothIn), THREAD, VIEWER, SUBJECT), { allowed: true });
  });

  it("denies when the counterpart has left the thread", async () => {
    const d = await allowTelegraphHeader(
      db({
        message_thread_members: [
          { thread_id: THREAD, user_id: VIEWER, left_at: null },
          { thread_id: THREAD, user_id: SUBJECT, left_at: "2026-01-01T00:00:00Z" },
        ],
      }),
      THREAD, VIEWER, SUBJECT,
    );
    assert.deepEqual(d, { allowed: false, reason: "not_in_thread" });
  });

  it("denies when the viewer is not in the thread they named", async () => {
    const d = await allowTelegraphHeader(
      db({ message_thread_members: [{ thread_id: THREAD, user_id: SUBJECT, left_at: null }] }),
      THREAD, VIEWER, SUBJECT,
    );
    assert.deepEqual(d, { allowed: false, reason: "not_in_thread" });
  });

  it("denies a header for yourself", async () => {
    const d = await allowTelegraphHeader(db(bothIn), THREAD, VIEWER, VIEWER);
    assert.deepEqual(d, { allowed: false, reason: "not_in_thread" });
  });

  it("FAILS CLOSED when membership cannot be read", async () => {
    const d = await allowTelegraphHeader(dbFailingOn("message_thread_members"), THREAD, VIEWER, SUBJECT);
    assert.deepEqual(d, { allowed: false, reason: "check_failed" });
  });
});

describe("allowSafetyContext — a safe-return link, either direction", () => {
  const subjectIsMyContact = {
    safe_return_sessions: [{ id: SESSION_MINE, user_id: VIEWER }],
    safe_return_contacts: [{ id: "c1", session_id: SESSION_MINE, contact_user_id: SUBJECT }],
  };
  const iAmTheirContact = {
    safe_return_sessions: [{ id: SESSION_THEIRS, user_id: SUBJECT }],
    safe_return_contacts: [{ id: "c2", session_id: SESSION_THEIRS, contact_user_id: VIEWER }],
  };

  it("allows when the subject is a contact on the viewer's session", async () => {
    assert.deepEqual(await allowSafetyContext(db(subjectIsMyContact), VIEWER, SUBJECT), { allowed: true });
  });

  it("allows when the viewer is a contact on the subject's session", async () => {
    assert.deepEqual(await allowSafetyContext(db(iAmTheirContact), VIEWER, SUBJECT), { allowed: true });
  });

  it("denies two users with no safe-return link", async () => {
    const d = await allowSafetyContext(db(), VIEWER, STRANGER);
    assert.deepEqual(d, { allowed: false, reason: "no_safety_relationship" });
  });

  it("denies a safety card about yourself", async () => {
    const d = await allowSafetyContext(db(subjectIsMyContact), VIEWER, VIEWER);
    assert.deepEqual(d, { allowed: false, reason: "no_safety_relationship" });
  });

  it("FAILS CLOSED when the contact table cannot be read", async () => {
    const d = await allowSafetyContext(dbFailingOn("safe_return_contacts", subjectIsMyContact), VIEWER, SUBJECT);
    assert.deepEqual(d, { allowed: false, reason: "check_failed" });
  });

  it("FAILS CLOSED when the session table cannot be read", async () => {
    const d = await allowSafetyContext(dbFailingOn("safe_return_sessions", subjectIsMyContact), VIEWER, SUBJECT);
    assert.deepEqual(d, { allowed: false, reason: "check_failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The four adoptions — each surface returns the Passport variant
// ─────────────────────────────────────────────────────────────────────────────

describe("Discovery adopts the discovery_card variant (§21 P95)", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("GET /discovery/people/:id/passport returns the discovery_card variant", async () => {
    srv = await startServer(makeApp(db()));
    const r = await fetch(`${srv.url}/api/discovery/people/${SUBJECT}/passport`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.passport.variant, "discovery_card");
    assert.equal(body.passport.userId, SUBJECT);
    // A person card, not the aggregate: none of these may ride along.
    for (const k of ["stamps", "memories", "upcomingPlans", "featuredJourney", "credentials"]) {
      assert.ok(!(k in body.passport), `discovery_card leaked ${k}`);
    }
  });
});

describe("Discovery person card obeys the shared gate", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("a subject who opted out of discovery is not reachable by id", async () => {
    srv = await startServer(makeApp(
      db({ profile_privacy_settings: [{ user_id: SUBJECT, allow_profile_discovery: false }] }),
    ));
    const r = await fetch(`${srv.url}/api/discovery/people/${SUBJECT}/passport`, { headers: AUTH });
    assert.equal(r.status, 404);
  });
});

describe("Compass adopts the same discovery_card variant (§21 P100)", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("GET /compass/people/:id/passport returns the discovery_card variant", async () => {
    srv = await startServer(makeApp(db()));
    const r = await fetch(`${srv.url}/api/compass/people/${SUBJECT}/passport`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.passport.variant, "discovery_card");
    // §8/§21: Compass reads trust CAPABILITIES off the projection, never a score.
    assert.ok(body.passport.capabilities?.owner, "compass card carries owner capabilities");
    assert.ok(body.passport.capabilities?.actions, "compass card carries server-projected actions");
    assert.ok(!("score" in (body.passport.trust ?? {})), "no numeric trust score on a person card");
  });
});

describe("Telegraph adopts the telegraph header variant (§21 P99)", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("GET /telegraph/threads/:threadId/header/:userId returns the telegraph variant", async () => {
    srv = await startServer(makeApp(db({
      message_thread_members: [
        { thread_id: THREAD, user_id: VIEWER, left_at: null },
        { thread_id: THREAD, user_id: SUBJECT, left_at: null },
      ],
    })));
    const r = await fetch(`${srv.url}/api/telegraph/threads/${THREAD}/header/${SUBJECT}`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.header.variant, "telegraph");
    // §30 — the header renders server-projected actions, it does not derive them.
    assert.equal(typeof body.header.actions.can_message, "boolean");
    assert.equal(typeof body.header.actions.can_make_plan, "boolean");
    assert.equal(typeof body.header.actions.can_follow, "boolean");
  });
});

describe("Telegraph header refuses a conversation the caller is not in", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("returns 403 when the viewer is not a present member", async () => {
    srv = await startServer(makeApp(db({
      message_thread_members: [{ thread_id: THREAD, user_id: SUBJECT, left_at: null }],
    })));
    const r = await fetch(`${srv.url}/api/telegraph/threads/${THREAD}/header/${SUBJECT}`, { headers: AUTH });
    assert.equal(r.status, 403);
  });
});

describe("Safety adopts the safety variant (§21 P101)", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("GET /me/safe-return/contacts/:id/passport returns the restricted safety shape", async () => {
    srv = await startServer(makeApp(db({
      safe_return_sessions: [{ id: SESSION_MINE, user_id: VIEWER }],
      safe_return_contacts: [{ id: "c1", session_id: SESSION_MINE, contact_user_id: SUBJECT }],
    })));
    const r = await fetch(`${srv.url}/api/me/safe-return/contacts/${SUBJECT}/passport`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.passport.variant, "safety");
    assert.equal(body.passport.userId, SUBJECT);
    // "Restricted, purpose-specific context ONLY" — the narrowest shape there is.
    for (const k of ["identity", "name", "avatarUrl", "trust", "availability", "stats", "sharedContext", "capabilities"]) {
      assert.ok(!(k in body.passport), `safety projection leaked ${k}`);
    }
    assert.equal(typeof body.passport.blocked, "boolean");
  });
});

describe("Safety refuses a user with no safe-return relationship", () => {
  let srv: { url: string; close: () => Promise<void> };
  after(async () => { if (srv) await srv.close(); });

  it("returns 403 rather than projecting a restricted card", async () => {
    srv = await startServer(makeApp(db()));
    const r = await fetch(`${srv.url}/api/me/safe-return/contacts/${STRANGER}/passport`, { headers: AUTH });
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. §35 adoption tripwire — the surfaces must not grow a second identity path
// ─────────────────────────────────────────────────────────────────────────────

describe("§35 canonical architecture rule — every TABLE 22 consumer calls the one assembler", () => {
  it("all seven consumers reach buildConsumerProjection", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const expected: Array<[string, string]> = [
      ["../routes/discoverySearch.ts", '"discovery_card"'],
      ["../routes/compass.ts", '"discovery_card"'],
      ["../routes/rentABuddy.ts", '"buddy"'],
      ["../routes/trips.ts", '"trips"'],
      ["../routes/telegraph.ts", '"telegraph"'],
      ["../routes/safeReturn.ts", '"safety"'],
      ["../services/passport/EventPassportService.ts", '"event"'],
    ];
    for (const [rel, variant] of expected) {
      const src = readFileSync(join(here, rel), "utf8");
      assert.ok(
        src.includes("buildConsumerProjection"),
        `${rel} no longer requests a Passport projection (§35)`,
      );
      assert.ok(
        src.includes(`buildConsumerProjection(`) && src.includes(variant),
        `${rel} no longer requests the ${variant} variant`,
      );
    }
  });

  it("there is deliberately no map variant, and the reason is recorded", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../services/passport/PassportConsumerProjections.ts"), "utf8");
    const variantBlock = src.slice(
      src.indexOf("export type PassportConsumerVariant"),
      src.indexOf("type SocialAvailability"),
    );
    assert.ok(!/"map"/.test(variantBlock), "a map variant appeared without a decision");
    assert.ok(
      src.includes("THERE IS DELIBERATELY NO `map` VARIANT"),
      "the Map decision must stay written down beside the variants",
    );
  });
});
