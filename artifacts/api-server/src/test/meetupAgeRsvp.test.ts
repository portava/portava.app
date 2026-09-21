/**
 * Route-level tests for meetup RSVP age enforcement.
 *
 * Pattern: inject a fake Supabase client via _setTestClient() so the route
 * handler runs against deterministic fixtures without any real network calls.
 * All assertions use node:test + node:assert (no external test runner needed).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MEETUPS_SRC = fileURLToPath(new URL("../routes/meetups.ts", import.meta.url));

/**
 * Comments are stripped before the source scan. A line of PROSE quoting the
 * defect satisfies a regex looking for the defect, and the check then passes —
 * or fails — for entirely the wrong reason.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => { const k = l.indexOf("//"); return k < 0 ? l : l.slice(0, k); })
    .join("\n");
}

// ── Minimal fake Supabase client builder ──────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeClient(overrides: {
  meetup?: Row | null;
  rsvp?: Row | null;
  profile?: Row | null;
  insertOk?: boolean;
  /** Tables that answer `{data:null,error}` — the RESOLVED failure supabase-js really produces. */
  failTables?: ReadonlySet<string>;
  /** Records every upsert the route issues, so an "allowed" case can prove the RSVP was WRITTEN. */
  writes?: Array<{ table: string; row: Row }>;
}) {
  const meetup  = overrides.meetup  ?? null;
  const rsvp    = overrides.rsvp    ?? null;
  const profile = overrides.profile ?? null;
  const insertOk = overrides.insertOk ?? true;
  const failTables = overrides.failTables ?? new Set<string>();
  const writes = overrides.writes;

  const makeBuilder = (table: string, returnData: Row | null, isArray = false): any => {
    const fail = failTables.has(table);
    const err = { message: `${table} read failed`, code: "57014" };
    const b: any = {
      select: () => b,
      insert: () => makeBuilder(table, insertOk ? returnData : null),
      update: () => b,
      upsert: (row: Row) => { writes?.push({ table, row }); return b; },
      eq:     () => b,
      in:     () => b,
      or:     () => b,
      order:  () => b,
      limit:  () => b,
      maybeSingle: () => Promise.resolve(fail ? { data: null, error: err } : { data: returnData, error: null }),
      single:      () => Promise.resolve(
        fail ? { data: null, error: err }
             : { data: returnData, error: insertOk ? null : { message: "insert failed" } },
      ),
      then: (resolve: (v: any) => any) =>
        Promise.resolve(
          fail ? { data: null, error: err } : { data: returnData ? [returnData] : [], error: null },
        ).then(resolve),
    };
    return b;
  };

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "bad") return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: { id: "user-123" } }, error: null };
      },
    },
    from: (table: string) => {
      if (table === "meetups") return makeBuilder(table, meetup);
      if (table === "meetup_rsvps" || table === "meetup_invites") return makeBuilder(table, rsvp ?? { id: "rsvp-1", status: "going" });
      if (table === "profiles") return makeBuilder(table, profile);
      if (table === "age_limit_audit_log") return makeBuilder(table, null);
      return makeBuilder(table, null);
    },
  };
}

// ── App setup ─────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The real server installs a logger. Without this shim the RSVP route CRASHES
  // on req.log and a 500-from-crash would satisfy every `notEqual(403)` in this
  // file — the "allowed" cases would pass for a route that never ran.
  app.use((req: any, _res: unknown, next: () => void) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });

  const { default: meetupsRouter } = await import("../routes/meetups.js");
  app.use(meetupsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function rsvp(body: { status: string }, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/meetups/00000000-0000-0000-0000-000000000001/rsvp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
          authorization: "Bearer test-token",
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") });
        });
      },
    );
    req.write(payload);
    req.end();
  });
}

// A meetup with age limit enabled (18+)
const ageLimitedMeetup = {
  id:                "00000000-0000-0000-0000-000000000001",
  creator_id:        "creator-999",
  title:             "Adults Only Meetup",
  status:            "active",
  visibility:        "public",
  age_limit_enabled: true,
  min_age:           18,
  max_age:           null,
  trip_id:           null,
  circle_owner_id:   null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RSVP age enforcement", () => {
  it("returns 403 when user has no DOB and meetup has age limit", async () => {
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: null },
      }),
      true,
    );

    const result = await rsvp({ status: "going" });

    assert.equal(result.status, 403);
    assert.equal(result.body.error, "age_not_eligible");
  });

  it("returns 403 when user is too young (DOB makes them 15)", async () => {
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - 15);
    const dob = tooYoung.toISOString().slice(0, 10);

    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dob },
      }),
      true,
    );

    const result = await rsvp({ status: "going" });

    assert.equal(result.status, 403);
    assert.equal(result.body.error, "age_not_eligible");
  });

  it("allows RSVP when user is old enough (25 years old)", async () => {
    const eligible = new Date();
    eligible.setFullYear(eligible.getFullYear() - 25);
    const dob = eligible.toISOString().slice(0, 10);

    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dob },
      }),
      true,
    );

    const result = await rsvp({ status: "going" });

    assert.notEqual(result.status, 403, `Expected non-403, got ${result.status}: ${JSON.stringify(result.body)}`);
  });

  it("allows declining RSVP even with no DOB (age check skipped for declined)", async () => {
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: null },
      }),
      true,
    );

    const result = await rsvp({ status: "declined" });

    assert.notEqual(result.status, 403);
  });

  it("allows RSVP when meetup has no age limit", async () => {
    const openMeetup = { ...ageLimitedMeetup, age_limit_enabled: false, min_age: null };

    _setTestClient(
      makeFakeClient({
        meetup:  openMeetup,
        profile: { id: "user-123", date_of_birth: null },
      }),
      true,
    );

    const result = await rsvp({ status: "going" });

    assert.notEqual(result.status, 403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The gate must not be BYPASSABLE — every way it could fail to run
// ══════════════════════════════════════════════════════════════════════════════
//
// The cases above all assert `notEqual(403)` for the allowed half. That is a
// weak assertion on its own: a route that CRASHED, or one whose gate never ran,
// satisfies it. These cases close that off — each asserts the exact code, and
// each asserts whether the RSVP was WRITTEN.

const dobFor = (years: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
};

describe("RSVP age gate — it cannot be skipped", () => {
  it("STRUCTURAL: a null service client REFUSES — the gate is not inside `if (sc) { … }`", () => {
    // Why this one is structural and not a request: `getServiceClient()` returns
    // null only when `isServiceClientReady` is false, and that constant is
    // computed from process.env AT MODULE LOAD — by the time this file runs, the
    // test runner has already set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, so
    // the null branch is not reachable from inside the process. Injecting null
    // via _setTestServiceClient does not reach it either: getServiceClient falls
    // through and builds a REAL client. So the null branch is pinned in the
    // source instead of pretended at over HTTP.
    //
    // The defect: the age check lived inside `if (sc) { … }` with NO else, so a
    // missing service client SKIPPED the gate entirely and wrote the RSVP. A
    // safety gate that could not run has not found the caller eligible.
    const src = stripComments(readFileSync(MEETUPS_SRC, "utf8"));
    const i = src.indexOf('router.post("/meetups/:meetupId/rsvp"');
    assert.ok(i > 0, "the RSVP route is not in this file — the scan would prove nothing");
    const route = src.slice(i, i + 3000);
    assert.ok(route.includes("age_limit_enabled"), "the scanned slice does not contain the age gate");
    assert.ok(
      /const sc = getServiceClient\(\);\s*if \(!sc\)/.test(route),
      "the age gate does not refuse on a missing service client",
    );
    assert.ok(
      !/const sc = getServiceClient\(\);\s*if \(sc\) \{/.test(route),
      "the age gate is still wrapped in `if (sc) { … }` — a missing client skips it",
    );
  });

  it("REFUSES retryably when profiles cannot be read — not with a fabricated dob_missing", async () => {
    // supabase-js RESOLVES on a database error, so an unreadable `profiles`
    // produced `data: null` — the exact shape "this user has no date of birth"
    // has. It denied, but with a verdict about the caller's own profile that
    // was invented: it told someone with a date of birth to go and add one.
    const writes: Array<{ table: string; row: Row }> = [];
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dobFor(30) },
        failTables: new Set(["profiles"]),
        writes,
      }),
      true,
    );

    const result = await rsvp({ status: "going" });

    assert.equal(result.body.error, "degraded_unavailable", JSON.stringify(result.body));
    assert.equal(result.status, 503);
    assert.notEqual(result.body.reason, "dob_missing", "an outage is not a fact about this profile");
    assert.equal(writes.filter((w) => w.table === "meetup_invites").length, 0);
  });

  it("a too-young caller is refused for BEING too young, not for a missing DOB", async () => {
    // Without pinning `reason`, this case passed whenever the profile read
    // failed for any incidental cause: `dob_missing` and `below_min_age` are
    // both 403 age_not_eligible, and only one of them is a real age verdict.
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dobFor(15) },
      }),
      true,
    );
    const result = await rsvp({ status: "going" });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "age_not_eligible");
    assert.equal(result.body.reason, "below_min_age",
      "the harness is not exercising the age comparison at all");
  });

  it("gates `maybe` as well as `going` — only `declined` is exempt", async () => {
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dobFor(15) },
      }),
      true,
    );
    const result = await rsvp({ status: "maybe" });
    assert.equal(result.status, 403);
    assert.equal(result.body.reason, "below_min_age");
  });

  it("the healthy twin: an eligible caller is SEATED, and the write really happens", async () => {
    // Without this, refusing unconditionally would pass every case above and
    // make age-limited meetups un-joinable. `notEqual(403)` is not enough — a
    // 500-from-crash satisfies it too.
    const writes: Array<{ table: string; row: Row }> = [];
    _setTestClient(
      makeFakeClient({
        meetup:  ageLimitedMeetup,
        profile: { id: "user-123", date_of_birth: dobFor(25) },
        writes,
      }),
      true,
    );
    const result = await rsvp({ status: "going" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const seated = writes.filter((w) => w.table === "meetup_invites");
    assert.equal(seated.length, 1, "the RSVP must actually be written");
    assert.equal((seated[0]!.row as any).status, "going");
  });
});
