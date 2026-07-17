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

/**
 * Client where the first update single() returns PGRST204 (schema drift) and
 * the second (fallback) update single() returns a generic DB error.
 * The updateCallCount is tracked at the client level so it persists across
 * multiple makeBuilder() calls (each `from()` invocation creates a fresh builder).
 */
function makeFallbackErrorClient() {
  let updateCallCount = 0;
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
          updateCallCount++;
          if (updateCallCount === 1) {
            // First attempt: simulate schema-drift PGRST204
            const bad = Object.keys(pendingUpdate).find((k) => DRIFTED_COLUMNS.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: {
                  code: "PGRST204",
                  message: `Could not find the '${bad}' column of 'profiles' in the schema cache`,
                },
              });
            }
          }
          if (updateCallCount >= 2) {
            // Second attempt (fallback): generic DB error — e.g. transient failure
            return Promise.resolve({
              data: null,
              error: { code: "42P01", message: "relation \"profiles\" does not exist" },
            });
          }
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

  it("partial save reports spokenLanguages in unsavedFields when it is the only drifted column", async () => {
    // Build a client where only spoken_languages is drifted (cover_photo_url is
    // present, so coverUrl saves fine).  The request sends bio (base column) and
    // spokenLanguages (drifted), so the fallback path must strip spoken_languages,
    // save bio, and report spokenLanguages as the sole unsaved field.
    const driftedColsSpokenOnly = new Set([
      "passport_section_order",
      "spoken_languages",
    ]);
    const spokenOnlyUpdates: UpdateRecord[] = [];
    const spokenOnlyRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder3(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...spokenOnlyRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsSpokenOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            spokenOnlyUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...spokenOnlyRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...spokenOnlyRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const spokenLanguagesDriftClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder3(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: spokenOnlyUpdates,
    };

    _setTestClient(spokenLanguagesDriftClient, true);
    _setTestServiceClient(spokenLanguagesDriftClient);

    const r = await patchProfile({ bio: "bio", spokenLanguages: ["en"] });
    assert.equal(r.status, 200, "base-column bio should still be saved");
    const body = await r.json() as any;
    assert.deepEqual(
      body.unsavedFields,
      ["spokenLanguages"],
      `spokenLanguages must be the sole unsaved field — got: ${JSON.stringify(body.unsavedFields)}`,
    );
    assert.ok(typeof body.warning === "string", "warning must be a string");
    assert.ok(
      (body.warning as string).includes("spokenLanguages"),
      `warning must mention "spokenLanguages" — got: ${JSON.stringify(body.warning)}`,
    );
    assert.equal(spokenLanguagesDriftClient.__updates.length, 1, "exactly one fallback write should occur");
    assert.equal(spokenLanguagesDriftClient.__updates[0].patch.bio, "bio");
    assert.ok(
      !("spoken_languages" in spokenLanguagesDriftClient.__updates[0].patch),
      "drifted spoken_languages must be stripped from the fallback write",
    );
  });

  it("partial save reports defaultLanguage in unsavedFields when it is the only drifted column", async () => {
    // Build a client where only default_language is drifted.  The request sends
    // bio (base column) and defaultLanguage (drifted), so the fallback path must
    // strip default_language, save bio, and report defaultLanguage as the sole
    // unsaved field.
    const driftedColsDefaultLangOnly = new Set(["default_language"]);
    const defaultLangUpdates: UpdateRecord[] = [];
    const defaultLangRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder4(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...defaultLangRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsDefaultLangOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            defaultLangUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...defaultLangRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...defaultLangRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const defaultLanguageDriftClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder4(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: defaultLangUpdates,
    };

    _setTestClient(defaultLanguageDriftClient, true);
    _setTestServiceClient(defaultLanguageDriftClient);

    const r = await patchProfile({ bio: "bio", defaultLanguage: "fr" });
    assert.equal(r.status, 200, "base-column bio should still be saved");
    const body = await r.json() as any;
    assert.deepEqual(
      body.unsavedFields,
      ["defaultLanguage"],
      `defaultLanguage must be the sole unsaved field — got: ${JSON.stringify(body.unsavedFields)}`,
    );
    assert.ok(typeof body.warning === "string", "warning must be a string");
    assert.ok(
      (body.warning as string).includes("defaultLanguage"),
      `warning must mention "defaultLanguage" — got: ${JSON.stringify(body.warning)}`,
    );
    assert.equal(defaultLanguageDriftClient.__updates.length, 1, "exactly one fallback write should occur");
    assert.equal(defaultLanguageDriftClient.__updates[0].patch.bio, "bio");
    assert.ok(
      !("default_language" in defaultLanguageDriftClient.__updates[0].patch),
      "drifted default_language must be stripped from the fallback write",
    );
  });

  it("clearing defaultLanguage (null) also reports it in unsavedFields under drift", async () => {
    // defaultLanguage is nullish in the PATCH schema — sending null clears it.
    // A null write still produces a default_language key in the update row, so
    // under drift it must follow the same strip-and-report path as setting a
    // value, not silently pretend the clear succeeded.
    const driftedColsDefaultLangOnly = new Set(["default_language"]);
    const nullClearUpdates: UpdateRecord[] = [];
    const nullClearRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder5(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...nullClearRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsDefaultLangOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            nullClearUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...nullClearRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...nullClearRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const nullClearClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder5(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: nullClearUpdates,
    };

    _setTestClient(nullClearClient, true);
    _setTestServiceClient(nullClearClient);

    const r = await patchProfile({ bio: "bio", defaultLanguage: null });
    assert.equal(r.status, 200, "base-column bio should still be saved");
    const body = await r.json() as any;
    assert.deepEqual(
      body.unsavedFields,
      ["defaultLanguage"],
      `defaultLanguage (cleared to null) must be the sole unsaved field — got: ${JSON.stringify(body.unsavedFields)}`,
    );
    assert.ok(typeof body.warning === "string", "warning must be a string");
    assert.ok(
      (body.warning as string).includes("defaultLanguage"),
      `warning must mention "defaultLanguage" — got: ${JSON.stringify(body.warning)}`,
    );
    assert.equal(nullClearClient.__updates.length, 1, "exactly one fallback write should occur");
    assert.equal(nullClearClient.__updates[0].patch.bio, "bio");
    assert.ok(
      !("default_language" in nullClearClient.__updates[0].patch),
      "drifted default_language must be stripped from the fallback write",
    );
  });

  it("clearing defaultLanguage alone under drift errors — no silent no-op 200", async () => {
    // { defaultLanguage: null } is the ONLY field in the PATCH and
    // default_language is drifted. Every requested field would be stripped by
    // the fallback, so the route must hit the all-stripped error path naming
    // defaultLanguage — not return a no-op 200.
    const driftedColsDefaultLangOnly = new Set(["default_language"]);
    const soloClearUpdates: UpdateRecord[] = [];
    const soloClearRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder6(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...soloClearRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsDefaultLangOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            soloClearUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...soloClearRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...soloClearRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const soloClearClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder6(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: soloClearUpdates,
    };

    _setTestClient(soloClearClient, true);
    _setTestServiceClient(soloClearClient);

    const r = await patchProfile({ defaultLanguage: null });
    assert.notEqual(r.status, 200, "a null-clear that saves nothing must not return 200");
    const body = await r.json() as any;
    assert.ok(
      JSON.stringify(body).includes("defaultLanguage"),
      `error body must mention "defaultLanguage" — got: ${JSON.stringify(body)}`,
    );
    assert.equal(soloClearClient.__updates.length, 0, "no fallback write should have been committed");
  });

  it("clearing coverUrl alone under drift errors — no silent no-op 200", async () => {
    // { coverUrl: null } is the ONLY field in the PATCH and cover_photo_url is
    // drifted. coverUrl maps only to cover_photo_url (no base fallback column),
    // so every requested field would be stripped by the fallback — the route
    // must hit the all-stripped error path naming coverUrl, not return a
    // no-op 200 that silently pretends the clear succeeded.
    const driftedColsCoverOnly = new Set(["cover_photo_url"]);
    const soloCoverClearUpdates: UpdateRecord[] = [];
    const soloCoverClearRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder7(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...soloCoverClearRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsCoverOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            soloCoverClearUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...soloCoverClearRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...soloCoverClearRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const soloCoverClearClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder7(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: soloCoverClearUpdates,
    };

    _setTestClient(soloCoverClearClient, true);
    _setTestServiceClient(soloCoverClearClient);

    const r = await patchProfile({ coverUrl: null });
    assert.notEqual(r.status, 200, "a null-clear that saves nothing must not return 200");
    const body = await r.json() as any;
    assert.ok(
      JSON.stringify(body).includes("coverUrl"),
      `error body must mention "coverUrl" — got: ${JSON.stringify(body)}`,
    );
    assert.equal(soloCoverClearClient.__updates.length, 0, "no fallback write should have been committed");
  });

  it("clearing preferredLanguage alone under drift errors — no silent no-op 200", async () => {
    // { preferredLanguage: null } is the ONLY field in the PATCH and
    // preferred_language is drifted. preferredLanguage maps only to
    // preferred_language (no base fallback column), so every requested field
    // would be stripped by the fallback — the route must hit the all-stripped
    // error path naming preferredLanguage, not return a no-op 200 that
    // silently pretends the clear succeeded.
    const driftedColsPrefLangOnly = new Set(["preferred_language"]);
    const soloPrefLangClearUpdates: UpdateRecord[] = [];
    const soloPrefLangClearRow: any = {
      id: ME, username: "me_user", handle: "me_user", name: "Me",
      bio: "old bio", is_private: false, passport_visibility: "public",
      avatar_url: null, created_at: new Date("2026-01-01").toISOString(),
    };
    function makeBuilder8(table: string) {
      let pendingUpdate: any = null;
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        limit() { return builder; },
        update(patch: any) { pendingUpdate = patch; return builder; },
        insert() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: table === "profiles" ? { ...soloPrefLangClearRow } : null, error: null });
        },
        single() {
          if (pendingUpdate && table === "profiles") {
            const bad = Object.keys(pendingUpdate).find((k) => driftedColsPrefLangOnly.has(k));
            if (bad) {
              return Promise.resolve({
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${bad}' column of 'profiles' in the schema cache` },
              });
            }
            soloPrefLangClearUpdates.push({ table, patch: pendingUpdate });
            return Promise.resolve({ data: { ...soloPrefLangClearRow, ...pendingUpdate }, error: null });
          }
          return Promise.resolve({ data: table === "profiles" ? { ...soloPrefLangClearRow } : null, error: null });
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return builder;
    }
    const soloPrefLangClearClient: any = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
      from: (table: string) => makeBuilder8(table),
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
      __updates: soloPrefLangClearUpdates,
    };

    _setTestClient(soloPrefLangClearClient, true);
    _setTestServiceClient(soloPrefLangClearClient);

    const r = await patchProfile({ preferredLanguage: null });
    assert.notEqual(r.status, 200, "a null-clear that saves nothing must not return 200");
    const body = await r.json() as any;
    assert.ok(
      JSON.stringify(body).includes("preferredLanguage"),
      `error body must mention "preferredLanguage" — got: ${JSON.stringify(body)}`,
    );
    assert.equal(soloPrefLangClearClient.__updates.length, 0, "no fallback write should have been committed");
  });

  // ── Fallback retry DB error ────────────────────────────────────────────────
  // After the schema-drift fallback strips newer columns and retries, the
  // retry itself can fail (e.g. a constraint violation or transient DB error).
  // The handler must propagate that error as a 4xx/5xx — not silently 200.

  it("all-fields-stripped error names every dropped field when two drifted-only fields are sent", async () => {
    // coverUrl → cover_photo_url (drifted in DRIFTED_COLUMNS)
    // spokenLanguages → spoken_languages (stripped by FALLBACK_STRIPPED_COLUMNS on any drift)
    // Neither maps to a surviving base column, so safeRow is empty → error path fires.
    const client = makeDriftedClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({
      coverUrl: "https://example.com/c.jpg",
      spokenLanguages: ["en"],
    });
    assert.notEqual(r.status, 200, "must not return 200 when every requested field would be stripped");
    const body = await r.json() as any;
    const bodyStr = JSON.stringify(body);
    assert.ok(
      bodyStr.includes("coverUrl"),
      `error body must mention "coverUrl" — got: ${bodyStr}`,
    );
    assert.ok(
      bodyStr.includes("spokenLanguages"),
      `error body must mention "spokenLanguages" — got: ${bodyStr}`,
    );
    assert.equal(client.__updates.length, 0, "no write should have been committed");
  });

  it("fallback retry DB error returns a non-200 response with the error code", async () => {
    // bio is a base column; displayName maps to display_name (drifted) + name (base).
    // First update: PGRST204 because display_name is missing.
    // Fallback strips display_name, retries with { bio, name } — but the second
    // single() returns a generic DB error to simulate a transient failure.
    const client = makeFallbackErrorClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await patchProfile({ bio: "new bio", displayName: "New Name" });
    assert.notEqual(r.status, 200, "a DB error on the fallback retry must not return 200");
    const body = await r.json() as any;
    assert.ok(
      body.code === "db_error" || JSON.stringify(body).includes("42P01") || JSON.stringify(body).includes("does not exist"),
      `response body should surface the DB error — got: ${JSON.stringify(body)}`,
    );
  });
});

// =============================================================================
// GET /me/profile — fallback retry DB error is surfaced
// =============================================================================
// The GET route has the same PGRST204 drift pattern as PATCH (profile.ts
// lines 267-272): if the first maybeSingle() returns PGRST204, it retries
// with PROFILE_COLUMNS_FALLBACK.  If that second maybeSingle() also errors,
// the route must return a non-200 with the error code — not a silent success.

/**
 * Fake client where:
 *   - auth resolves correctly for ME_TOK
 *   - the first profiles.maybeSingle() returns PGRST204 (schema-drift)
 *   - the second profiles.maybeSingle() (fallback) returns a generic DB error
 * maybeSingleCallCount is tracked at the client level so it persists across
 * multiple from() calls (the route calls from("profiles") twice).
 */
function makeGetFallbackErrorClient() {
  let maybeSingleCallCount = 0;

  function makeBuilder(table: string) {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      neq() { return builder; },
      limit() { return builder; },
      update(patch: any) { void patch; return builder; },
      insert() { return builder; },
      maybeSingle() {
        if (table === "profiles") {
          maybeSingleCallCount++;
          if (maybeSingleCallCount === 1) {
            // First attempt: simulate PGRST204 schema-drift
            return Promise.resolve({
              data: null,
              error: {
                code: "PGRST204",
                message: "Could not find the 'passport_tab_order' column of 'profiles' in the schema cache",
              },
            });
          }
          // Second attempt (fallback with PROFILE_COLUMNS_FALLBACK): generic DB error
          return Promise.resolve({
            data: null,
            error: { code: "42P01", message: "relation \"profiles\" does not exist" },
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({ data: null, error: null });
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
  };
  return client;
}

/**
 * Fake client where:
 *   - the first profiles.maybeSingle() returns PGRST204 (schema-drift)
 *   - the second profiles.maybeSingle() (fallback with PROFILE_COLUMNS_FALLBACK)
 *     succeeds with a valid profile row
 * Used to guard the happy fallback path: GET /me/profile must return 200 with
 * the mapped profile when the fallback select recovers valid data.
 */
function makeGetFallbackSuccessClient() {
  let maybeSingleCallCount = 0;
  const fallbackRow: any = {
    id: ME, handle: "me_user", username: "me_user", name: "Me",
    bio: "old bio", avatar_url: null, home_city: "Lisbon", home_country: "Portugal",
    current_city: null, travel_style: null, interests: ["food"],
    verified: false, verification_status: "unverified", verified_at: null,
    open_to_meet: true, is_private: false, passport_visibility: "public",
    username_updated_at: null, created_at: new Date("2026-01-01").toISOString(),
  };

  function makeBuilder(table: string) {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      neq() { return builder; },
      limit() { return builder; },
      gte() { return builder; },
      update(patch: any) { void patch; return builder; },
      insert() { return builder; },
      maybeSingle() {
        if (table === "profiles") {
          maybeSingleCallCount++;
          if (maybeSingleCallCount === 1) {
            // First attempt (full PROFILE_COLUMNS): schema-drift error
            return Promise.resolve({
              data: null,
              error: {
                code: "PGRST204",
                message: "Could not find the 'passport_tab_order' column of 'profiles' in the schema cache",
              },
            });
          }
          // Second attempt (PROFILE_COLUMNS_FALLBACK): valid row
          return Promise.resolve({ data: { ...fallbackRow }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
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
    __getMaybeSingleCallCount: () => maybeSingleCallCount,
  };
  return client;
}

describe("GET /api/me/profile under schema drift — fallback retry error is surfaced", () => {
  function getProfile() {
    return fetch(`${base}/me/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ME_TOK}` },
    });
  }

  it("returns non-200 when the fallback maybeSingle() also errors — not a silent success", async () => {
    // First maybeSingle(): PGRST204 (triggers fallback)
    // Second maybeSingle(): generic DB error
    // Expected: the route surfaces that error instead of returning 200
    const client = makeGetFallbackErrorClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await getProfile();
    assert.notEqual(r.status, 200, "a DB error on the GET fallback retry must not return 200");
    const body = await r.json() as any;
    assert.ok(
      body.code === "db_error" ||
        JSON.stringify(body).includes("42P01") ||
        JSON.stringify(body).includes("does not exist"),
      `response body should surface the DB error — got: ${JSON.stringify(body)}`,
    );
  });

  it("returns 200 with the profile when the fallback select recovers valid data", async () => {
    // First maybeSingle(): PGRST204 (triggers fallback)
    // Second maybeSingle() (PROFILE_COLUMNS_FALLBACK): valid profile row
    // Expected: 200 with the mapped profile fields
    const client = makeGetFallbackSuccessClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await getProfile();
    assert.equal(r.status, 200, "a successful fallback select must return 200");
    const body = await r.json() as any;
    assert.equal(body.id, ME);
    assert.equal(body.handle, "me_user");
    assert.equal(body.username, "me_user");
    assert.equal(body.name, "Me");
    assert.equal(body.bio, "old bio");
    assert.equal(body.homeCity, "Lisbon");
    assert.equal(body.homeCountry, "Portugal");
    assert.deepEqual(body.interests, ["food"]);
    assert.equal(body.openToMeet, true);
    assert.equal(body.passportVisibility, "public");
    assert.ok(body.completeness && typeof body.completeness.score === "number", "completeness score present");
    assert.equal(
      client.__getMaybeSingleCallCount(), 2,
      "exactly two profile selects: drifted attempt + fallback",
    );
  });
});
