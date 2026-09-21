/**
 * PATCH /api/me/privacy — a merge base that could not be READ is not an empty
 * merge base, and a visibility restriction that was not WRITTEN is not an
 * applied one.
 *
 * ── DEFECT 1: THE SILENT PRIVACY REVERSION ──────────────────────────────────
 * The handler merges the caller's patch onto their existing row so that a
 * one-field PATCH does not clobber the other seventeen:
 *
 *     const existingRes = await sc.from("profile_privacy_settings")…maybeSingle()
 *       .then(undefined, () => ({ data: null }));      // ← rejection handler
 *     const existing = existingRes.data;
 *     const mergedRow = { ...PRIVACY_DEFAULTS, ...(existing ?? {}), ...patch };
 *
 * supabase-js RESOLVES on a database error, so that second `.then` argument
 * never ran and the resolved `{ data: null, error }` was indistinguishable from
 * "this user has no settings row yet". The merge base then fell back to
 * PRIVACY_DEFAULTS — and those defaults are the PERMISSIVE ones
 * (`allow_tagging: true`, `allow_profile_discovery: true`,
 * `precise_location_visible: false`, every `show_*` true). So a user toggling
 * one unrelated switch during a transient read failure had every privacy
 * restriction they had ever set silently REVERTED, written back to the
 * database, and returned to them as a 200 carrying the reverted row as though
 * they had asked for it. Nothing was logged.
 *
 * ── DEFECT 2: THE UNAPPLIED `is_private` ────────────────────────────────────
 * `profiles.is_private` is the column discovery and search actually exclude on.
 * Setting `profile_visibility: "private"` synced it with
 * `.then(undefined, (e) => req.log.warn(...))` — again a rejection handler on a
 * client that resolves its errors, so the warning was never emitted for the
 * failure that happens. A user was answered 200 "you are private" and stayed
 * fully exposed in exactly the surfaces they had just asked to leave.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * A test where the user genuinely has no settings row and a test where the
 * table cannot be read pass for the same reason, so each failure case here sits
 * next to a healthy one with the row PRESENT and readable. A "fix" that refused
 * every PATCH would satisfy every failure assertion and would have broken the
 * privacy screen outright; the healthy cases are what stop that.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/profilePrivacyMergeBaseFailOpen.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import profileRouter from "../routes/profile.js";

const ME = "bb000000-0000-4000-a000-000000000022";
const TOK = "tok-priv";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };
const WRITE_ERROR = { message: "could not serialize access due to concurrent update", code: "40001" };

/** The user's ACTUAL settings: several restrictions, all tighter than the defaults. */
const RESTRICTED_ROW = {
  user_id: ME,
  profile_visibility: "private",
  allow_tagging: false,
  allow_profile_discovery: false,
  allow_follow: false,
  show_posts: false,
  precise_location_visible: false,
  updated_at: "2026-01-01T00:00:00.000Z",
};

function install(spec: FakeClientSpec) {
  // Mutated in place, not spread: makeFailClosedClient records issued writes
  // back onto the spec object it is handed.
  spec.users = { [TOK]: ME };
  const client = makeFailClosedClient(spec);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
}

function rows(privacyRows: any[]) {
  return {
    profiles: [{ id: ME, account_status: "active", is_private: true }],
    profile_privacy_settings: privacyRows,
    user_privacy_settings: [] as any[],
  };
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this shim the handler CRASHES on its first req.log call and a
  // 500-from-crash would masquerade as a fail-closed refusal.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function patchPrivacy(body: Record<string, unknown>) {
  const res = await fetch(`${base}/me/privacy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed };
}

describe("PATCH /me/privacy: an unread merge base is not an empty one", () => {
  it("HEALTHY: a one-field patch merges onto the stored row and keeps every other restriction", async () => {
    const spec: FakeClientSpec = { rows: rows([{ ...RESTRICTED_ROW }]) };
    install(spec);

    const res = await patchPrivacy({ show_stamps: false });
    assert.equal(res.status, 200, "a healthy patch must still succeed");

    const written = (spec.inserted?.["profile_privacy_settings"] ?? [])[0];
    assert.ok(written, "the upsert must be ISSUED");
    assert.equal(written.show_stamps, false, "the patched field is applied");
    // The whole point of the merge base: untouched restrictions survive.
    assert.equal(written.allow_tagging, false, "a stored restriction must survive an unrelated patch");
    assert.equal(written.allow_profile_discovery, false, "a stored restriction must survive an unrelated patch");
    assert.equal(written.allow_follow, false, "a stored restriction must survive an unrelated patch");
  });

  it("HEALTHY: a first-time patch with genuinely no stored row still succeeds on the defaults", async () => {
    const spec: FakeClientSpec = { rows: rows([]) };
    install(spec);

    const res = await patchPrivacy({ show_stamps: false });
    assert.equal(
      res.status,
      200,
      "a user who has never opened the privacy screen must still be able to patch it",
    );
    const written = (spec.inserted?.["profile_privacy_settings"] ?? [])[0];
    assert.ok(written, "the upsert must be ISSUED");
    assert.equal(written.show_stamps, false);
  });

  it("FAILS CLOSED: an unreadable settings row does not revert the user's restrictions to the permissive defaults", async () => {
    const spec: FakeClientSpec = {
      rows: rows([{ ...RESTRICTED_ROW }]),
      // The row EXISTS and is restrictive; only the read of it fails. That is
      // the pairing: the row is there, so any "no row" reasoning is excluded.
      failOn: (ctx) => (ctx.table === "profile_privacy_settings" ? READ_ERROR : null),
    };
    install(spec);

    const res = await patchPrivacy({ show_stamps: false });
    assert.equal(res.status, 500, "a patch whose merge base could not be read must not answer 200");
    assert.equal(res.body.error, "db_error");

    // The decisive assertion: NOTHING was written. The old code wrote the
    // permissive defaults over the user's restrictions here.
    const written = spec.inserted?.["profile_privacy_settings"] ?? [];
    assert.equal(
      written.length,
      0,
      "no reverted row may be persisted when the user's real settings could not be read",
    );
  });

  it("HEALTHY: setting profile_visibility=private applies profiles.is_private and reports success", async () => {
    const spec: FakeClientSpec = { rows: rows([{ ...RESTRICTED_ROW, profile_visibility: "public" }]) };
    install(spec);

    const res = await patchPrivacy({ profile_visibility: "private" });
    assert.equal(res.status, 200);

    const profileWrites = spec.updated?.["profiles"] ?? [];
    assert.equal(profileWrites.length, 1, "the is_private sync must be ISSUED");
    assert.equal(profileWrites[0].is_private, true);
  });

  it("FAILS CLOSED: 'you are now private' is not reported when profiles.is_private could not be written", async () => {
    const spec: FakeClientSpec = {
      rows: rows([{ ...RESTRICTED_ROW, profile_visibility: "public" }]),
      // profile_privacy_settings writes succeed; only the column discovery and
      // search actually exclude on fails.
      failWritesOn: (t) => (t === "profiles" ? WRITE_ERROR : null),
    };
    install(spec);

    const res = await patchPrivacy({ profile_visibility: "private" });
    assert.equal(
      res.status,
      500,
      "a visibility change that never reached the column discovery reads must not answer 200",
    );
    assert.equal(res.body.error, "db_error");
  });
});
