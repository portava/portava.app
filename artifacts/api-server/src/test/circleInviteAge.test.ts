/**
 * Route-level tests for circle invite accept age enforcement.
 *
 * Pattern: inject a fake Supabase client via _setTestClient() so routes run
 * against deterministic fixtures. Uses node:test + node:assert.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

const INVITE_ID = "00000000-0000-0000-0000-000000000099";

// ── Fake client builder ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeClient(overrides: {
  invite?: Row | null;
  circleAgeSettings?: Row | null;
  profile?: Row | null;
}) {
  const invite           = overrides.invite           ?? null;
  const circleAgeSettings = overrides.circleAgeSettings ?? null;
  const profile           = overrides.profile           ?? null;

  const makeBuilder = (returnData: Row | null): any => ({
    select: () => makeBuilder(returnData),
    insert: () => makeBuilder(returnData),
    update: () => makeBuilder(returnData),
    upsert: () => makeBuilder(returnData),
    eq:     () => makeBuilder(returnData),
    in:     () => makeBuilder(returnData),
    or:     () => makeBuilder(returnData),
    order:  () => makeBuilder(returnData),
    limit:  () => makeBuilder(returnData),
    maybeSingle: () => Promise.resolve({ data: returnData, error: null }),
    single:      () => Promise.resolve({ data: returnData, error: null }),
    then: (resolve: (v: any) => any) =>
      Promise.resolve({ data: returnData ? [returnData] : [], error: null }).then(resolve),
  });

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "bad") return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: { id: "invitee-user" } }, error: null };
      },
    },
    from: (table: string) => {
      if (table === "circle_invites")    return makeBuilder(invite);
      if (table === "circle_age_settings") return makeBuilder(circleAgeSettings);
      if (table === "profiles")          return makeBuilder(profile);
      if (table === "age_limit_audit_log") return makeBuilder(null);
      if (table === "circle_memberships")  return makeBuilder({ id: "cm-1" });
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

  const { default: requestsRouter } = await import("../routes/requests.js");
  app.use(requestsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function acceptInvite(inviteId: string) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const payload = "{}";
    const req = http.request(
      `${baseUrl}/me/requests/circle_invite/${inviteId}/accept`,
      {
        method: "POST",
        headers: {
          "content-type":  "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
          authorization:   "Bearer test-token",
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

// Fixtures — recipient_id must match fake auth user.id ("invitee-user")
const pendingInvite: Row = {
  id:           INVITE_ID,
  owner_id:     "circle-owner-id",
  recipient_id: "invitee-user",
  status:       "pending",
};

const enabledAgeSettings: Row = {
  owner_id:          "circle-owner-id",
  age_limit_enabled: true,
  min_age:           21,
  max_age:           null,
};

const disabledAgeSettings: Row = {
  owner_id:          "circle-owner-id",
  age_limit_enabled: false,
  min_age:           null,
  max_age:           null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Circle invite accept — age enforcement", () => {
  it("accepts invite when owner has no age settings (null row)", async () => {
    _setTestClient(
      makeFakeClient({
        invite:            pendingInvite,
        circleAgeSettings: null,
        profile:           { id: "invitee-user", date_of_birth: null },
      }),
      true,
    );

    const result = await acceptInvite(INVITE_ID);

    assert.notEqual(result.status, 403, `Expected non-403, got ${result.status}: ${JSON.stringify(result.body)}`);
  });

  it("accepts invite when age limit is disabled even if user has no DOB", async () => {
    _setTestClient(
      makeFakeClient({
        invite:            pendingInvite,
        circleAgeSettings: disabledAgeSettings,
        profile:           { id: "invitee-user", date_of_birth: null },
      }),
      true,
    );

    const result = await acceptInvite(INVITE_ID);

    assert.notEqual(result.status, 403, `Expected non-403, got ${result.status}: ${JSON.stringify(result.body)}`);
  });

  it("returns 403 when age limit enabled and invitee has no DOB", async () => {
    _setTestClient(
      makeFakeClient({
        invite:            pendingInvite,
        circleAgeSettings: enabledAgeSettings,
        profile:           { id: "invitee-user", date_of_birth: null },
      }),
      true,
    );

    const result = await acceptInvite(INVITE_ID);

    assert.equal(result.status, 403);
    assert.equal(result.body.error, "age_not_eligible");
  });

  it("returns 403 when invitee is too young (15 years old, need 21+)", async () => {
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - 15);
    const dob = tooYoung.toISOString().slice(0, 10);

    _setTestClient(
      makeFakeClient({
        invite:            pendingInvite,
        circleAgeSettings: enabledAgeSettings,
        profile:           { id: "invitee-user", date_of_birth: dob },
      }),
      true,
    );

    const result = await acceptInvite(INVITE_ID);

    assert.equal(result.status, 403);
    assert.equal(result.body.error, "age_not_eligible");
  });

  it("accepts invite when invitee is old enough (25, need 21+)", async () => {
    const eligible = new Date();
    eligible.setFullYear(eligible.getFullYear() - 25);
    const dob = eligible.toISOString().slice(0, 10);

    _setTestClient(
      makeFakeClient({
        invite:            pendingInvite,
        circleAgeSettings: enabledAgeSettings,
        profile:           { id: "invitee-user", date_of_birth: dob },
      }),
      true,
    );

    const result = await acceptInvite(INVITE_ID);

    assert.notEqual(result.status, 403, `Expected non-403, got ${result.status}: ${JSON.stringify(result.body)}`);
  });
});
