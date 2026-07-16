/**
 * Schema-drift guard for PATCH /api/me/profile.
 *
 * Simulates a database missing the newer profile columns (42703 / PGRST204 on
 * update) and asserts:
 *   1. A passport_section_order save returns an explicit db_error — never a
 *      silent 200 that drops the layout preference.
 *   2. Other newer-column saves still fall back (retry without the drifted
 *      columns) and succeed when at least one base column remains.
 *   3. If EVERY requested field would be stripped, the route errors instead
 *      of returning a no-op 200.
 *
 * Run: node --test --import tsx src/test/profileSchemaDrift.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

// Columns "missing" from the simulated drifted database.
const DRIFTED_COLUMNS = new Set([
  "passport_section_order",
  "cover_photo_url",
  "display_name",
]);

type UpdateRecord = { table: string; patch: any };

function makeDriftedClient() {
  const updates: UpdateRecord[] = [];
  const profileRow: any = {
    id: ME, username: "me_user", handle: "me_user", name: "Me",
    bio: "old bio", is_private: false, passport_visibility: "public",
    avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
  };

  function makeBuilder(table: string) {
    let pendingUpdate: any = null;
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      neq() { return builder; },
      limit() { return builder; },
      update(patch: any) { pendingUpdate = patch; return builder; },
      insert() { return builder; },
      maybeSingle() {
        return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
      },
      single() {
        if (pendingUpdate && table === "profiles") {
          const bad = Object.keys(pendingUpdate).find((k) => DRIFTED_COLUMNS.has(k));
          if (bad) {
            return Promise.resolve({
              data: null,
              error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
            });
          }
          updates.push({ table, patch: pendingUpdate });
          return Promise.resolve({ data: { ...profileRow, ...pendingUpdate }, error: null });
        }
        return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from: (table: string) => makeBuilder(table),
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    __updates: updates,
  };
  return client;
}

/**
 * Like makeDriftedClient, but the profile row returned by the fallback update
 * also contains date_of_birth and dob_verified — fields that mapProfile must
 * strip before the 200 response is sent.
 */
function makeDriftedClientWithSensitiveRow() {
  const updates: UpdateRecord[] = [];
  const profileRow: any = {
    id: ME, username: "me_user", handle: "me_user", name: "Me",
    bio: "old bio", is_private: false, passport_visibility: "public",
    avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    // Sensitive fields: the DB may return these even though the API must never
    // surface them.  The fallback branch calls mapProfile, so they should be
    // stripped before the response is sent.
    date_of_birth: "1990-03-15",
    dob_verified: true,
  };

  function makeBuilder(table: string) {
    let pendingUpdate: any = null;
    let callCount = 0;
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      neq() { return builder; },
      limit() { return builder; },
      update(patch: any) { pendingUpdate = patch; return builder; },
      insert() { return builder; },
      maybeSingle() {
        return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
      },
      single() {
        if (pendingUpdate && table === "profiles") {
          callCount++;
          if (callCount === 1) {
            // First attempt: simulate schema-drift error (PGRST204) so the
            // handler falls back to PROFILE_COLUMNS_FALLBACK.
            const bad = Object.keys(pendingUpdate).find((k) => DRIFTED_COLUMNS.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
          }
          // Fallback / second attempt: succeed and return the sensitive row so
          // we can assert it gets stripped.
          updates.push({ table, patch: pendingUpdate });
          return Promise.resolve({ data: { ...profileRow, ...pendingUpdate }, error: null });
        }
        return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from: (table: string) => makeBuilder(table),
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    __updates: updates,
  };
  return client;
}

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function patchProfile(body: any) {
  return fetch(`${base}/me/profile`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${ME_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/me/profile under schema drift (missing newer columns)", () => {
  it("passport layout save returns an explicit error, not a silent 200", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({
      passportSectionOrder: ["tabs", "identity", "stamps", "highlights", "dossier"],
    });
    assert.notEqual(r.status, 200, "must not report success when the column is missing");
    const body = await r.json() as any;
    assert.match(JSON.stringify(body), /passport_section_order/i, "error should name the missing column");
    assert.equal(client.__updates.length, 0, "no fallback write should have been committed");
  });

  it("mixed save including passportSectionOrder also errors instead of dropping it", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({
      bio: "new bio",
      passportSectionOrder: ["dossier", "tabs", "identity", "stamps", "highlights"],
    });
    assert.notEqual(r.status, 200);
    assert.equal(client.__updates.length, 0);
  });

  it("other drifted-column saves still fall back when a base column is also present", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.equal(r.status, 200, "fallback path should still save the base column");
    assert.equal(client.__updates.length, 1);
    assert.equal(client.__updates[0].patch.bio, "new bio");
    assert.ok(!("display_name" in client.__updates[0].patch), "drifted column stripped from retry");
  });

  it("errors when every requested field would be stripped (no silent no-op 200)", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // coverUrl maps only to the drifted cover_photo_url column (unlike
    // displayName, which also writes the base `name` column).
    const r = await patchProfile({ coverUrl: "https://example.com/c.jpg" });
    assert.notEqual(r.status, 200, "a write that saves nothing must not return 200");
    const body = await r.json() as any;
    assert.match(JSON.stringify(body), /coverUrl/, "error should name the unsaved field");
    assert.equal(client.__updates.length, 0);
  });

  it("partial save returns unsavedFields listing exactly what was dropped", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "kept bio", coverUrl: "https://example.com/c.jpg" });
    assert.equal(r.status, 200, "base column still saves");
    const body = await r.json() as any;
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "response must list the fields that were not saved");
    assert.match(body.warning ?? "", /coverUrl/, "warning message should name the unsaved field");
    assert.equal(client.__updates.length, 1);
    assert.equal(client.__updates[0].patch.bio, "kept bio");
    assert.ok(!("cover_photo_url" in client.__updates[0].patch));
  });

  it("warning lists ALL dropped fields when multiple drifted columns are stripped at once", async () => {
    // Build a client that treats cover_photo_url AND spoken_languages as drifted,
    // so both coverUrl and spokenLanguages are stripped in the fallback write.
    const driftedCols = new Set([
      "passport_section_order",
      "cover_photo_url",
      "display_name",
      "spoken_languages",
    ]);
    const updates: UpdateRecord[] = [];
    const profileRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder2(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedCols.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            updates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...profileRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...profileRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const multiDriftClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder2(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: updates,
    };

    _setTestClient(multiDriftClient, true);
    _setTestServiceClient(multiDriftClient);

    // bio is a base column (kept), coverUrl → cover_photo_url (drifted),
    // spokenLanguages → spoken_languages (drifted in this client).
    const r = await patchProfile({
      bio: "bio",
      coverUrl: "https://example.com/c.jpg",
      spokenLanguages: ["en", "es"],
    });
    assert.equal(r.status, 200, "base-column bio should still be saved");
    const body = await r.json() as any;

    // Both dropped field names must appear in unsavedFields (order-independent).
    assert.ok(
      Array.isArray(body.unsavedFields),
      `unsavedFields must be an array, got: ${JSON.stringify(body.unsavedFields)}`,
    );
    assert.ok(
      (body.unsavedFields as string[]).includes("coverUrl"),
      `unsavedFields must contain "coverUrl" — got: ${JSON.stringify(body.unsavedFields)}`,
    );
    assert.ok(
      (body.unsavedFields as string[]).includes("spokenLanguages"),
      `unsavedFields must contain "spokenLanguages" — got: ${JSON.stringify(body.unsavedFields)}`,
    );

    // The warning string must name both dropped fields.
    assert.ok(typeof body.warning === "string", "warning must be a string");
    assert.ok(
      (body.warning as string).includes("coverUrl"),
      `warning must mention "coverUrl" — got: ${JSON.stringify(body.warning)}`,
    );
    assert.ok(
      (body.warning as string).includes("spokenLanguages"),
      `warning must mention "spokenLanguages" — got: ${JSON.stringify(body.warning)}`,
    );

    // The base column bio must have been written.
    assert.equal(multiDriftClient.__updates.length, 1, "exactly one fallback write should occur");
    assert.equal(multiDriftClient.__updates[0].patch.bio, "bio");
    assert.ok(!("cover_photo_url" in multiDriftClient.__updates[0].patch), "drifted cover_photo_url must be stripped");
    assert.ok(!("spoken_languages" in multiDriftClient.__updates[0].patch), "drifted spoken_languages must be stripped");
  });

  it("displayName is NOT reported unsaved when the base name column still persists it", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ displayName: "New Name" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unsavedFields, undefined, "display_name stripped but `name` saved — not a partial save");
    assert.equal(client.__updates.length, 1);
    assert.equal(client.__updates[0].patch.name, "New Name");
  });

  it("fully successful saves carry no unsavedFields or warning", async () => {
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "just a bio" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unsavedFields, undefined);
    assert.equal(body.warning, undefined);
  });

  // ── DOB strip on fallback path ─────────────────────────────────────────────
  // The fallback DB row may contain date_of_birth and dob_verified if the live
  // schema has them.  mapProfile must strip them before the 200 is sent.

  it("fallback-path 200 does not include date_of_birth (snake_case) in the response", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // bio + displayName: display_name is drifted → first attempt fails with
    // PGRST204, fallback retries with only bio (+ name).  The fallback row
    // returned by the fake client contains date_of_birth and dob_verified.
    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.equal(r.status, 200, "fallback path should still return 200 for a base-column save");
    const body = await r.json() as any;
    assert.ok(
      !("date_of_birth" in body),
      `date_of_birth must not appear in fallback PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("fallback-path 200 does not include dateOfBirth (camelCase) in the response", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(
      !("dateOfBirth" in body),
      `dateOfBirth must not appear in fallback PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("fallback-path 200 does not include dob_verified (snake_case) in the response", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(
      !("dob_verified" in body),
      `dob_verified must not appear in fallback PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("fallback-path 200 does not include dobVerified (camelCase) in the response", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(
      !("dobVerified" in body),
      `dobVerified must not appear in fallback PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  // ── DOB strip on the partial-save branch ──────────────────────────────────
  // When some fields are dropped (unsavedFields is non-empty), the route takes
  // an early-return at lines 577-586 via mapProfile(updated).  The DB row may
  // still contain date_of_birth / dob_verified; mapProfile must strip them
  // before the 200 is sent from that branch too.

  it("partial-save branch does not include date_of_birth (snake_case) when coverUrl is dropped", async () => {
    // bio is a base column (persisted), coverUrl maps to cover_photo_url which
    // is drifted → PGRST204 on first attempt, fallback drops cover_photo_url,
    // unsavedFields = ["coverUrl"] → partial-save early return fires.
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", coverUrl: "https://example.com/c.jpg" });
    assert.equal(r.status, 200, "partial-save should still return 200 for the base-column field");
    const body = await r.json() as any;
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "partial-save branch must have fired");
    assert.ok(
      !("date_of_birth" in body),
      `date_of_birth must not appear in partial-save PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("partial-save branch does not include dateOfBirth (camelCase) when coverUrl is dropped", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", coverUrl: "https://example.com/c.jpg" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "partial-save branch must have fired");
    assert.ok(
      !("dateOfBirth" in body),
      `dateOfBirth must not appear in partial-save PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("partial-save branch does not include dob_verified (snake_case) when coverUrl is dropped", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", coverUrl: "https://example.com/c.jpg" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "partial-save branch must have fired");
    assert.ok(
      !("dob_verified" in body),
      `dob_verified must not appear in partial-save PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });

  it("partial-save branch does not include dobVerified (camelCase) when coverUrl is dropped", async () => {
    const client = makeDriftedClientWithSensitiveRow();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", coverUrl: "https://example.com/c.jpg" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "partial-save branch must have fired");
    assert.ok(
      !("dobVerified" in body),
      `dobVerified must not appear in partial-save PATCH response — got keys: ${Object.keys(body).join(", ")}`,
    );
  });
});
