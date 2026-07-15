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

// ── Minimal fake Supabase client builder ──────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeClient(overrides: {
  meetup?: Row | null;
  rsvp?: Row | null;
  profile?: Row | null;
  insertOk?: boolean;
}) {
  const meetup  = overrides.meetup  ?? null;
  const rsvp    = overrides.rsvp    ?? null;
  const profile = overrides.profile ?? null;
  const insertOk = overrides.insertOk ?? true;

  const makeBuilder = (returnData: Row | null, isArray = false): any => ({
    select: () => makeBuilder(returnData, isArray),
    insert: () => makeBuilder(insertOk ? returnData : null),
    update: () => makeBuilder(returnData),
    upsert: () => makeBuilder(returnData),
    eq:     () => makeBuilder(returnData, isArray),
    in:     () => makeBuilder(returnData, isArray),
    or:     () => makeBuilder(returnData, isArray),
    order:  () => makeBuilder(returnData, isArray),
    limit:  () => makeBuilder(returnData, isArray),
    maybeSingle: () => Promise.resolve({ data: returnData, error: null }),
    single:      () => Promise.resolve({ data: returnData, error: insertOk ? null : { message: "insert failed" } }),
    then: (resolve: (v: any) => any) =>
      Promise.resolve({ data: returnData ? [returnData] : [], error: null }).then(resolve),
  });

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "bad") return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: { id: "user-123" } }, error: null };
      },
    },
    from: (table: string) => {
      if (table === "meetups") return makeBuilder(meetup);
      if (table === "meetup_rsvps" || table === "meetup_invites") return makeBuilder(rsvp ?? { id: "rsvp-1" });
      if (table === "profiles") return makeBuilder(profile);
      if (table === "age_limit_audit_log") return makeBuilder(null);
      return makeBuilder(null);
    },
  };
}

// ── App setup ─────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());

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
