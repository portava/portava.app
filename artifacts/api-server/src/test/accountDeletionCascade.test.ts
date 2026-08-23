/**
 * Account deletion cascade + scheduled worker (audit P1 item 7)
 *
 * Under test:
 *   services/accountDeletion/AccountDeletionService.ts  — the cascade
 *   lib/accountDeletionScheduler.ts                     — the due-request worker
 *   routes/profile.ts POST /internal/deletion-requests/execute-due — worker endpoint
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionCascade.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import express from "express";
import {
  createDeletedProfileHandle,
  executeAccountDeletion,
  storagePathFromPublicUrl,
  PROFILE_MEDIA_BUCKET,
} from "../services/accountDeletion/AccountDeletionService.js";
import { processDueDeletions } from "../lib/accountDeletionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

// ── Fake supabase client ──────────────────────────────────────────────────────

interface Op { table: string; op: string; filters: any[]; values?: any }

/**
 * Apply the filter operators used by mutation paths and return matching rows.
 */
function matchingIndices(tableRows: any[], filters: Array<any>): number[] {
  const eqFilters = filters.filter((f) => f[0] === "eq");
  const lteFilters = filters.filter((f) => f[0] === "lte");
  return tableRows.reduce<number[]>((acc, row, idx) => {
    const matches = eqFilters.every(([, col, val]: [string, string, any]) => row[col] === val);
    const withinUpperBounds = lteFilters.every(
      ([, col, val]: [string, string, any]) => row[col] != null && row[col] <= val,
    );
    if (matches && withinUpperBounds) acc.push(idx);
    return acc;
  }, []);
}

function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** table -> error message, injected on the given op */
  fail?: Record<string, string>;
  authDeleteError?: string;
  authDeleteFailures?: number;
  profileHandleConflicts?: number;
  requestUpdateFailures?: number;
  normalizeReturnedRequestTimestamps?: boolean;
  storageError?: string;
} = {}) {
  // Deep-copy seeded rows so mutations don't bleed between tests.
  const rows: Record<string, any[]> = {};
  for (const [t, arr] of Object.entries(opts.rows ?? {})) {
    rows[t] = arr.map((r) => ({ ...r }));
  }
  if (!Object.hasOwn(rows, "profiles")) {
    rows.profiles = [{
      id: USER_ID,
      handle: "original_handle",
      username: "original_handle",
      display_name: "Original User",
      name: "Original User",
      account_status: "active",
    }];
  } else {
    rows.profiles = rows.profiles.map((row, index) => ({
      id: index === 0 ? USER_ID : OTHER_ID,
      handle: index === 0 ? "original_handle" : `other_handle_${index}`,
      username: index === 0 ? "original_handle" : `other_handle_${index}`,
      display_name: index === 0 ? "Original User" : "Other User",
      name: index === 0 ? "Original User" : "Other User",
      account_status: "active",
      ...row,
    }));
  }
  if (!Object.hasOwn(rows, "user_deletion_requests")) {
    rows.user_deletion_requests = [{
      user_id: USER_ID,
      status: "pending",
      scheduled_at: "2020-01-01T00:00:00Z",
    }];
  }
  const fail = opts.fail ?? {};
  const ops: Op[] = [];
  const storageRemoved: Array<{ bucket: string; paths: string[] }> = [];
  const authDeleted: string[] = [];
  let authDeleteFailuresRemaining = opts.authDeleteFailures ?? 0;
  let profileHandleConflictsRemaining = opts.profileHandleConflicts ?? 0;
  let requestUpdateFailuresRemaining = opts.requestUpdateFailures ?? 0;
  let authUserExists = true;

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _returning: false,
      select() {
        q._returning = true;
        return q;
      },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters, values: q._values });
        const key = `${table}.${q._op}`;
        if (
          table === "user_deletion_requests"
          && q._op === "update"
          && q._values?.status === "executed"
          && requestUpdateFailuresRemaining > 0
        ) {
          requestUpdateFailuresRemaining -= 1;
          return Promise.resolve({
            data: null,
            error: { message: "temporary request update failure" },
          });
        }
        if (fail[key] || fail[table]) {
          return Promise.resolve({ data: null, error: { message: fail[key] ?? fail[table] } });
        }
        if (q._op === "update" && table === "profiles") {
          if (profileHandleConflictsRemaining > 0) {
            profileHandleConflictsRemaining -= 1;
            return Promise.resolve({
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "profiles_handle_key"',
              },
            });
          }
          if (q._values?.handle == null) {
            return Promise.resolve({
              data: null,
              error: {
                code: "23502",
                message: 'null value in column "handle" violates not-null constraint',
              },
            });
          }
        }
        let data: any = rows[table] ?? [];
        if (q._op === "update") {
          const matched = matchingIndices(rows[table] ?? [], q._filters);
          if (table === "profiles" && q._values?.handle != null) {
            const matchedSet = new Set(matched);
            const duplicate = (rows.profiles ?? []).some(
              (row, index) => !matchedSet.has(index) && row.handle === q._values.handle,
            );
            if (duplicate) {
              return Promise.resolve({
                data: null,
                error: {
                  code: "23505",
                  message: 'duplicate key value violates unique constraint "profiles_handle_key"',
                },
              });
            }
          }
          for (const index of matched) {
            rows[table][index] = { ...rows[table][index], ...q._values };
          }
          data = matched.map((index) => rows[table][index]);
          if (
            opts.normalizeReturnedRequestTimestamps
            && table === "user_deletion_requests"
          ) {
            data = data.map((row: any) => {
              const normalized = { ...row };
              for (const field of ["execution_started_at", "execution_lease_expires_at"]) {
                if (typeof normalized[field] === "string") {
                  normalized[field] = normalized[field].replace(/Z$/, "+00:00");
                }
              }
              return normalized;
            });
          }
        }
        if (q._op === "delete" && rows[table]) {
          // Actually remove matching rows from the in-memory store so the
          // zero-orphan census test can verify per-user scoping.
          const toRemove = new Set(matchingIndices(rows[table], q._filters));
          rows[table] = rows[table].filter((_, i) => !toRemove.has(i));
          data = [];
        }
        if (q._limit) data = data.slice(0, q._limit);
        if (q._single) data = data.length > 0 ? data[0] : null;
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _ops: ops,
    _storageRemoved: storageRemoved,
    _authDeleted: authDeleted,
    _rows: rows,
    rpc: async (name: string, args: any) => {
      ops.push({
        table: name,
        op: "rpc",
        values: args,
        filters: [["eq", "user_id", args.p_user_id]],
      });
      const key = `${name}.rpc`;
      if (fail[key] || fail[name]) {
        return { data: null, error: { message: fail[key] ?? fail[name] } };
      }
      // SECURITY DEFINER maintenance/revocation RPCs actually erase raw rows the
      // service_role can no longer delete directly. Mirror that effect on the
      // in-memory store so the zero-orphan census stays meaningful.
      const userScopedErase: Record<string, string[]> = {
        delete_journey_observations_for_user_v1: ["journey_observations"],
        delete_journey_shadow_rows_v1: ["journey_observations", "journey_segment_revisions"],
        revoke_journey_consent_and_delete_segments: ["journey_observations", "journey_segment_revisions"],
      };
      const eraseTables = userScopedErase[name];
      if (eraseTables && args?.p_user_id != null) {
        const filters = [["eq", "user_id", args.p_user_id]];
        let deleted = 0;
        for (const t of eraseTables) {
          if (!rows[t]) continue;
          const toRemove = new Set(matchingIndices(rows[t], filters));
          deleted += toRemove.size;
          rows[t] = rows[t].filter((_, i) => !toRemove.has(i));
        }
        return { data: deleted, error: null };
      }
      return { data: 0, error: null };
    },
    from: (t: string) => builder(t),
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          if (opts.storageError) return { data: null, error: { message: opts.storageError } };
          storageRemoved.push({ bucket, paths });
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if (opts.authDeleteError) return { data: null, error: { message: opts.authDeleteError } };
          if (authDeleteFailuresRemaining > 0) {
            authDeleteFailuresRemaining -= 1;
            return { data: null, error: { message: "temporary auth deletion failure" } };
          }
          if (!authUserExists) {
            return {
              data: null,
              error: { code: "user_not_found", status: 404, message: "User not found" },
            };
          }
          authUserExists = false;
          authDeleted.push(id);
          return { data: {}, error: null };
        },
      },
    },
  };
}

const opFor = (c: any, table: string, op: string) =>
  c._ops.find((o: Op) => o.table === table && o.op === op);
const updateForStatus = (c: any, table: string, status: string) =>
  c._ops.find((o: Op) => o.table === table && o.op === "update" && o.values?.status === status);

// ── storagePathFromPublicUrl ─────────────────────────────────────────────────

describe("storagePathFromPublicUrl", () => {
  it("extracts the object path for the bucket", () => {
    const url = `https://x.supabase.co/storage/v1/object/public/${PROFILE_MEDIA_BUCKET}/u/1/avatar.jpg`;
    assert.equal(storagePathFromPublicUrl(url, PROFILE_MEDIA_BUCKET), "u/1/avatar.jpg");
  });

  it("returns null for a URL from a different bucket, and for null", () => {
    const url = "https://x.supabase.co/storage/v1/object/public/other-bucket/a.jpg";
    assert.equal(storagePathFromPublicUrl(url, PROFILE_MEDIA_BUCKET), null);
    assert.equal(storagePathFromPublicUrl(null, PROFILE_MEDIA_BUCKET), null);
  });
});

describe("deleted profile handle contract", () => {
  it("generates opaque, valid, unique handles without embedding the user id", () => {
    const handles = new Set<string>();
    for (let i = 0; i < 128; i += 1) {
      const handle = createDeletedProfileHandle();
      assert.match(handle, /^deleted_[a-f0-9]{22}$/);
      assert.equal(handle.length, 30);
      assert.equal(handle.includes(USER_ID), false);
      assert.equal(handle.includes(USER_ID.replaceAll("-", "")), false);
      handles.add(handle);
    }
    assert.equal(handles.size, 128);
  });

  it("migration preserves handle integrity and rebinds audit rows to the tombstone", async () => {
    const sql = await readFile(
      new URL("../migrations/2125_account_deletion_tombstone_contract.sql", import.meta.url),
      "utf8",
    );
    assert.match(sql, /profiles\.handle must remain NOT NULL/);
    assert.match(sql, /profiles\.handle must remain UNIQUE/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS profiles_id_fkey/);
    assert.match(
      sql,
      /FOREIGN KEY \(user_id\)\s+REFERENCES public\.profiles\(id\)\s+ON DELETE RESTRICT/s,
    );
    assert.match(sql, /status IN \('pending', 'executing', 'cancelled', 'executed'\)/);
    assert.match(sql, /account_status <> 'deleted'/);
    assert.match(sql, /execution_token uuid/);
    assert.doesNotMatch(sql, /DROP\s+(?:CONSTRAINT\s+profiles_handle_key|NOT NULL)/i);
  });
});

describe("account-deletion Journey revocation compatibility contract", () => {
  it("installs only the deletion RPC and optional-table-safe revocation trigger", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/2126_account_deletion_journey_revocation_compat.sql",
        import.meta.url,
      ),
      "utf8",
    );

    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION public\.revoke_journey_consent_and_delete_segments/,
    );
    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION public\.purge_journey_observations_on_consent_revocation/,
    );
    assert.match(
      migration,
      /to_regclass\('public\.journey_segment_revisions'\) IS NOT NULL/,
    );
    assert.match(migration, /pg_advisory_xact_lock/);
    assert.match(migration, /DELETE FROM public\.journey_observations/);
    assert.doesNotMatch(migration, /CREATE\s+TABLE[\s\S]*journey_segment_revisions/i);
  });

  it("fails closed unless both Journey flags exist and remain disabled", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/2126_account_deletion_journey_revocation_compat.sql",
        import.meta.url,
      ),
      "utf8",
    );

    assert.match(migration, /v_flag_count <> 2 OR v_enabled_count <> 0/);
    assert.doesNotMatch(migration, /UPDATE\s+public\.feature_flags/i);
    assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.feature_flags/i);
  });
});

// ── The cascade ──────────────────────────────────────────────────────────────

describe("executeAccountDeletion — full cascade", () => {
  it("deletes content, storage, verification rows, and the auth user", async () => {
    const c = makeClient({
      rows: {
        post_media: [
          { storage_bucket: "post-media", storage_path: "p/1.jpg", thumbnail_storage_path: "p/1_t.jpg" },
        ],
        media_assets: [{ storage_bucket: "post-media", storage_path: "m/2.jpg", thumbnail_path: null }],
        profiles: [{
          avatar_url: `https://x/storage/v1/object/public/${PROFILE_MEDIA_BUCKET}/av.jpg`,
          cover_photo_url: null,
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Content rows deleted, each scoped to this user.
    assert.ok(opFor(c, "posts", "delete"), "posts deleted");
    assert.deepEqual(opFor(c, "posts", "delete")!.filters, [["eq", "author_id", USER_ID]]);
    assert.ok(opFor(c, "messages", "delete"), "message ciphertext deleted");
    assert.deepEqual(opFor(c, "messages", "delete")!.filters, [["eq", "sender_id", USER_ID]]);
    assert.ok(opFor(c, "identity_verifications", "delete"), "verification rows deleted");
    assert.ok(opFor(c, "media_assets", "delete"), "media_assets deleted");
    assert.deepEqual(
      opFor(c, "revoke_journey_consent_and_delete_segments", "rpc")!.filters,
      [["eq", "user_id", USER_ID]],
      "Journey consent and segments are cleaned atomically because profile is tombstoned",
    );

    // Storage objects removed, including thumbnails and the profile avatar.
    const removed = c._storageRemoved.flatMap((r) => r.paths);
    assert.ok(removed.includes("p/1.jpg"));
    assert.ok(removed.includes("p/1_t.jpg"));
    assert.ok(removed.includes("m/2.jpg"));
    assert.ok(removed.includes("av.jpg"));

    // Auth user removed — this is what drops the email address.
    assert.deepEqual(c._authDeleted, [USER_ID]);

    // Profile anonymised into a tombstone rather than deleted.
    const upd = opFor(c, "profiles", "update")!;
    assert.equal(upd.values.display_name, null);
    assert.equal(upd.values.account_status, "deleted");
    assert.equal(upd.values.username, null);
    assert.equal(upd.values.full_name, null);
    assert.equal(upd.values.date_of_birth, null);
    assert.equal(upd.values.expo_push_token, null);
    assert.equal(upd.values.is_private, true);
    assert.equal(upd.values.passport_visibility, "private");
    assert.equal(upd.values.tag_permission, "nobody");
    assert.deepEqual(upd.values.interests, []);
    assert.deepEqual(upd.values.public_social_links, {});
    assert.match(upd.values.handle, /^deleted_[a-f0-9]{22}$/);
    assert.notEqual(upd.values.handle, "original_handle");
    assert.equal(upd.values.handle.includes(USER_ID.replaceAll("-", "")), false);

    // Request closed out.
    const reqUpd = updateForStatus(c, "user_deletion_requests", "executed")!;
    assert.equal(reqUpd.values.status, "executed");
    assert.ok(reqUpd.values.executed_at);
    assert.equal(c._rows.profiles[0].handle, upd.values.handle);
    assert.equal(c._rows.profiles[0].account_status, "deleted");
    assert.equal(c._rows.user_deletion_requests[0].status, "executed");
  });

  it("scrubs every current profile PII and preference field retained in the tombstone", async () => {
    const c = makeClient({
      rows: {
        profiles: [{
          bio: "identifying biography",
          public_social_links: { instagram: "@real_person" },
          expo_push_token: "ExponentPushToken[secret-device]",
          date_of_birth: "1990-01-02",
          location_city: "Private City",
          location_country: "Private Country",
          city: "Legacy City",
          country: "Legacy Country",
          country_code: "PC",
          flag_emoji: "🏳️",
          tagline: "Private tagline",
          interests: ["private interest"],
          spoken_languages: ["fr"],
          travel_styles: ["solo"],
          looking_for: ["friends"],
          trust_score: 99,
          trust_label: "Private trust label",
          verification_method: "government-id",
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const row = c._rows.profiles[0];
    for (const field of [
      "username", "username_updated_at", "display_name", "full_name", "bio",
      "bio_original_language", "avatar_url", "cover_photo_url", "home_city",
      "home_country", "current_city", "location_city", "location_country",
      "city", "country", "country_code", "flag_emoji", "tagline",
      "travel_style", "default_language", "preferred_language", "travel_pace",
      "budget_style", "comfort_level", "planning_style", "expo_push_token",
      "date_of_birth", "verified_at", "verification_method",
      "verification_expires_at", "verified_since", "id_verified_at",
      "selfie_verified_at", "home_country_verified_at", "host_verified_at",
      "buddy_verified_at", "trust_score", "trust_label",
    ]) {
      assert.equal(row[field], null, `${field} must be erased`);
    }
    for (const field of [
      "interests", "spoken_languages", "travel_styles", "travel_group_style",
      "looking_for", "availability_tags",
    ]) {
      assert.deepEqual(row[field], [], `${field} must be emptied`);
    }
    assert.deepEqual(row.public_social_links, {});
    assert.equal(row.name, "Deleted User");
    assert.equal(row.is_private, true);
    assert.equal(row.open_to_meet, false);
    assert.equal(row.verified, false);
    assert.equal(row.account_status, "deleted");
  });

  it("claims the request before the first destructive write", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true);

    const claimIndex = c._ops.findIndex(
      (op: Op) => op.table === "user_deletion_requests"
        && op.op === "update"
        && op.values?.status === "executing",
    );
    const firstDeleteIndex = c._ops.findIndex((op: Op) => op.op === "delete");
    assert.ok(claimIndex >= 0 && firstDeleteIndex >= 0);
    assert.ok(claimIndex < firstDeleteIndex);
  });

  it("accepts PostgREST-normalized claim timestamps for the same instant", async () => {
    const c = makeClient({ normalizeReturnedRequestTimestamps: true });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(c._rows.user_deletion_requests[0].status, "executed");
  });

  it("does no destructive work while another unexpired execution owns the request", async () => {
    const c = makeClient({
      rows: {
        user_deletion_requests: [{
          user_id: USER_ID,
          status: "executing",
          execution_token: "22222222-2222-2222-2222-222222222222",
          execution_started_at: "2099-01-01T00:00:00.000Z",
          execution_lease_expires_at: "2099-01-01T01:00:00.000Z",
          scheduled_at: "2020-01-01T00:00:00Z",
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, false);
    assert.equal(opFor(c, "posts", "delete"), undefined);
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
    assert.equal(
      c._rows.user_deletion_requests[0].execution_token,
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("releases the claim when the fail-closed audit hook rejects before destruction", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, {
      actorId: "admin-1",
      beforeDestructiveWork: async () => {
        throw new Error("audit unavailable");
      },
    });

    assert.equal(out.ok, false);
    assert.equal(opFor(c, "posts", "delete"), undefined);
    assert.equal(c._rows.user_deletion_requests[0].status, "pending");
    assert.equal(c._rows.user_deletion_requests[0].execution_token, null);
    assert.ok(out.steps.some((step) => step.step === "pre_deletion_audit" && !step.ok));
  });

  it("collects storage paths BEFORE deleting the rows that hold them", async () => {
    const c = makeClient({
      rows: { post_media: [{ storage_bucket: "post-media", storage_path: "p/1.jpg" }] },
    });
    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const idxCollect = c._ops.findIndex((o: Op) => o.table === "post_media" && o.op === "select");
    const idxDelete = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "delete");
    assert.ok(idxCollect >= 0 && idxDelete >= 0);
    assert.ok(idxCollect < idxDelete, "must read post_media paths before posts cascade removes them");
  });

  it("aborts before touching the auth user when profile anonymisation fails", async () => {
    const c = makeClient({ fail: { "profiles.update": "permission denied" } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    assert.equal(out.ok, false);
    assert.deepEqual(c._authDeleted, [], "must not delete the auth user if the tombstone failed");
    assert.equal(updateForStatus(c, "user_deletion_requests", "executed"), undefined);
    assert.equal(c._rows.user_deletion_requests[0].status, "executing");
    assert.ok(
      out.steps.some((step) => step.step === "expire_deletion_claim" && step.ok),
      "a failed destructive run stays non-cancellable but is immediately reclaimable",
    );
    assert.ok(out.steps.some((s) => s.step === "anonymise_profile" && !s.ok));
    assert.equal(
      c._ops.filter((op: Op) => op.table === "profiles" && op.op === "update").length,
      1,
      "non-uniqueness failures must not be retried",
    );
  });

  it("fails closed when no profile row exists instead of deleting Auth without a tombstone", async () => {
    const c = makeClient({ rows: { profiles: [] } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, false);
    assert.deepEqual(c._authDeleted, []);
    assert.ok(
      out.steps.some(
        (step) => step.step === "anonymise_profile"
          && step.error?.includes("no profile row matched"),
      ),
    );
  });

  it("retries only handle uniqueness conflicts with a fresh opaque value", async () => {
    const c = makeClient({ profileHandleConflicts: 2 });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true, JSON.stringify(out.steps));
    const attempts = c._ops.filter(
      (op: Op) => op.table === "profiles" && op.op === "update",
    );
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((op: Op) => op.values.handle)).size, 3);
    assert.match(c._rows.profiles[0].handle, /^deleted_[a-f0-9]{22}$/);
  });

  it("keeps a failed Auth deletion retry idempotent", async () => {
    const c = makeClient({ authDeleteFailures: 1 });

    const first = await executeAccountDeletion(c, USER_ID, { actorId: null });
    const firstHandle = c._rows.profiles[0].handle;
    assert.equal(first.ok, false);
    assert.match(firstHandle, /^deleted_[a-f0-9]{22}$/);
    assert.equal(c._rows.user_deletion_requests[0].status, "executing");
    assert.deepEqual(c._authDeleted, []);

    const second = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(second.ok, true, JSON.stringify(second.steps));
    assert.match(c._rows.profiles[0].handle, /^deleted_[a-f0-9]{22}$/);
    assert.notEqual(c._rows.profiles[0].handle, firstHandle);
    assert.equal(c._rows.user_deletion_requests[0].status, "executed");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("finishes an expired execution claim when a retry finds Auth already deleted", async () => {
    const c = makeClient({ requestUpdateFailures: 1 });

    const first = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(first.ok, false);
    assert.deepEqual(c._authDeleted, [USER_ID]);
    assert.equal(c._rows.user_deletion_requests[0].status, "executing");
    assert.ok(
      first.steps.some(
        (step) => step.step === "mark_request_executed"
          && step.error?.includes("temporary request update failure"),
      ),
    );

    // The execution-claim integrity constraint requires expiry > started_at,
    // so immediate failure expiry may be one millisecond in the future.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(second.ok, true, JSON.stringify(second.steps));
    assert.deepEqual(
      c._authDeleted,
      [USER_ID],
      "the retry accepts the provider's explicit user_not_found result",
    );
    assert.equal(c._rows.user_deletion_requests[0].status, "executed");
  });

  it("fails before destructive work when the request audit row is missing", async () => {
    const c = makeClient({ rows: { user_deletion_requests: [] } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, false);
    assert.deepEqual(c._authDeleted, []);
    assert.ok(
      out.steps.some(
        (step) => step.step === "claim_deletion_request"
          && step.error?.includes("no cancellable or expired request row matched"),
      ),
    );
  });

  it("returns not-ok and leaves a reclaimable non-cancellable request when Auth cannot be deleted", async () => {
    const c = makeClient({ authDeleteError: "user not found" });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    // The email address is still on file — the deletion is NOT complete, so
    // callers must leave the request retryable instead of marking it done.
    assert.equal(out.ok, false, "auth-user failure must fail the outcome");
    assert.ok(
      out.warnings.some((w) => w.includes("email address still on file")),
      "email retention must be surfaced: " + JSON.stringify(out.warnings),
    );
    assert.equal(
      updateForStatus(c, "user_deletion_requests", "executed"),
      undefined,
      "request must NOT be marked executed while the auth user survives",
    );
    assert.ok(out.steps.some((s) => s.step === "auth_delete_user" && !s.ok));
  });

  it("does not anonymise or complete the account when atomic Journey cleanup fails", async () => {
    const c = makeClient({
      fail: { "revoke_journey_consent_and_delete_segments.rpc": "temporary deletion failure" },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, false);
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
    assert.equal(updateForStatus(c, "user_deletion_requests", "executed"), undefined);
    assert.equal(c._rows.user_deletion_requests[0].status, "executing");
    assert.ok(
      out.steps.some(
        (step) => step.step === "revoke_journey_consent_and_delete_segments" && !step.ok,
      ),
    );
  });

  it("revokes Journey authorization and deletes segments in one database operation", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true);
    const atomicOps = c._ops.filter(
      (op: Op) => op.table === "revoke_journey_consent_and_delete_segments" && op.op === "rpc",
    );
    assert.equal(atomicOps.length, 1, "privacy cleanup must be one database transaction");
    assert.deepEqual(
      atomicOps[0]!.values?.p_preferences,
      { location_mode: "off", sharing_paused: true },
    );
    assert.equal(opFor(c, "user_location_preferences", "update"), undefined);
    assert.equal(opFor(c, "delete_journey_segments_for_user", "rpc"), undefined);
  });

  it("does not abort the run when Storage is unavailable", async () => {
    const c = makeClient({
      rows: { post_media: [{ storage_bucket: "post-media", storage_path: "p/1.jpg" }] },
      storageError: "bucket unavailable",
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true);
    assert.ok(out.warnings.some((w) => w.includes("storage objects")));
    assert.ok(opFor(c, "posts", "delete"), "content deletion proceeds regardless");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("contentOnly leaves the tombstone and the auth user alone", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null, contentOnly: true });

    assert.ok(opFor(c, "posts", "delete"));
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
  });
});

// ── Merged legacy cascade steps (old services/accountDeletion.ts union) ──────

describe("executeAccountDeletion — merged legacy cascade steps", () => {
  it("clears stories, reviews, gems, saves, follows, notifications and search history", async () => {
    const c = makeClient();

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Stories + engagement rows, scoped to the right column each time.
    assert.deepEqual(opFor(c, "story_reactions", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "story_replies", "delete")!.filters,   [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "story_views", "delete")!.filters,     [["eq", "viewer_id", USER_ID]]);
    assert.deepEqual(opFor(c, "stories", "delete")!.filters,         [["eq", "owner_id", USER_ID]]);

    // The user's own interactions on other users' posts.
    for (const t of ["post_reactions", "posts_comments", "post_shares", "post_saves", "posts_likes", "comment_likes"]) {
      assert.deepEqual(opFor(c, t, "delete")!.filters, [["eq", "user_id", USER_ID]], `${t} scoped to user`);
    }

    // Reviews + hidden gems (saves and authored submissions).
    assert.deepEqual(opFor(c, "reviews", "delete")!.filters,          [["eq", "reviewer_id", USER_ID]]);
    assert.deepEqual(opFor(c, "hidden_gem_saves", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "hidden_gems", "delete")!.filters,      [["eq", "submitted_by", USER_ID]]);

    // Saved items.
    assert.deepEqual(opFor(c, "saved_places", "delete")!.filters,    [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "user_saves", "delete")!.filters,      [["eq", "saver_id", USER_ID]]);
    assert.deepEqual(opFor(c, "wishlist_places", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "event_saves", "delete")!.filters,     [["eq", "user_id", USER_ID]]);

    // Follow graph, both directions.
    const followOps = c._ops.filter((o: Op) => o.table === "user_follows" && o.op === "delete");
    assert.equal(followOps.length, 2, "user_follows deleted in both directions");
    assert.ok(followOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "follower_id" && f[2] === USER_ID)));
    assert.ok(followOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "following_id" && f[2] === USER_ID)));

    // Notifications: received AND acting, plus push-device rows + history.
    const notifOps = c._ops.filter((o: Op) => o.table === "notifications" && o.op === "delete");
    assert.equal(notifOps.length, 2, "notifications deleted by user_id and actor_id");
    assert.ok(notifOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "user_id" && f[2] === USER_ID)));
    assert.ok(notifOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "actor_id" && f[2] === USER_ID)));
    assert.deepEqual(opFor(c, "notification_devices", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "search_history", "delete")!.filters,       [["eq", "user_id", USER_ID]]);
  });

  it("deletes key_packages by device_id BEFORE deleting the devices rows", async () => {
    const c = makeClient({ rows: { devices: [{ id: "dev-1" }, { id: "dev-2" }] } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const kp = opFor(c, "key_packages", "delete")!;
    assert.deepEqual(kp.filters, [["in", "device_id", ["dev-1", "dev-2"]]]);

    const idxKp = c._ops.findIndex((o: Op) => o.table === "key_packages" && o.op === "delete");
    const idxDev = c._ops.findIndex((o: Op) => o.table === "devices" && o.op === "delete");
    assert.ok(idxKp >= 0 && idxDev >= 0);
    assert.ok(idxKp < idxDev, "key_packages (FK on devices) must be cleared before devices");
  });

  it("one failing content table records its step but never aborts the rest", async () => {
    const c = makeClient({ fail: { "reviews.delete": "permission denied" } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.ok(out.steps.some((s) => s.step === "delete_reviews" && !s.ok));
    assert.ok(out.warnings.some((w) => w.includes("reviews")));
    // Everything after reviews still ran, up to and including the auth user.
    assert.ok(opFor(c, "search_history", "delete"), "later steps still execute");
    assert.deepEqual(c._authDeleted, [USER_ID]);
    assert.ok(updateForStatus(c, "user_deletion_requests", "executed"));
  });

  it("contentOnly also runs the merged content steps", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null, contentOnly: true });

    assert.ok(opFor(c, "stories", "delete"));
    assert.ok(opFor(c, "user_follows", "delete"));
    assert.ok(opFor(c, "search_history", "delete"));
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
  });
});

// ── Journey / location cascade steps ─────────────────────────────────────────

describe("executeAccountDeletion — journey and location cascade steps", () => {
  it("deletes all journey and location tables scoped to the user", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Journey observations precede sessions; trigger-created revocation jobs
    // are removed only after preferences and sessions.
    assert.deepEqual(
      opFor(c, "delete_journey_observations_for_user_v1", "rpc")!.filters,
      [["eq", "user_id", USER_ID]],
      "journey_observations erased via SECURITY DEFINER RPC (direct DELETE revoked)",
    );
    assert.deepEqual(
      opFor(c, "journey_revocation_jobs", "delete")!.filters,
      [["eq", "user_id", USER_ID]],
      "journey_revocation_jobs",
    );
    assert.deepEqual(
      opFor(c, "location_sessions", "delete")!.filters,
      [["eq", "user_id", USER_ID]],
      "location_sessions",
    );

    // location support tables
    assert.deepEqual(opFor(c, "user_location_state", "delete")!.filters,       [["eq", "user_id", USER_ID]], "user_location_state");
    assert.deepEqual(opFor(c, "location_snapshots", "delete")!.filters,        [["eq", "user_id", USER_ID]], "location_snapshots");
    assert.deepEqual(opFor(c, "location_trust_events", "delete")!.filters,     [["eq", "user_id", USER_ID]], "location_trust_events");
    assert.deepEqual(opFor(c, "user_location_preferences", "delete")!.filters, [["eq", "user_id", USER_ID]], "user_location_preferences");

    // crew tables — events before sessions and preferences
    const crewOps = c._ops.filter((o: Op) => o.op === "delete" && o.table.startsWith("trip_crew_location_"));
    const crewTables = crewOps.map((o: Op) => o.table);
    const idxEvents  = crewTables.indexOf("trip_crew_location_events");
    const idxSess    = crewTables.indexOf("trip_crew_location_sessions");
    const idxPrefs   = crewTables.indexOf("trip_crew_location_preferences");
    assert.ok(idxEvents >= 0, "trip_crew_location_events deleted");
    assert.ok(idxSess  >= 0, "trip_crew_location_sessions deleted");
    assert.ok(idxPrefs >= 0, "trip_crew_location_preferences deleted");
    assert.ok(idxEvents < idxSess,  "crew events must be deleted before crew sessions");
    assert.ok(idxEvents < idxPrefs, "crew events must be deleted before crew preferences");

    assert.deepEqual(crewOps[idxEvents].filters, [["eq", "user_id", USER_ID]], "crew events scoped to user");
    assert.deepEqual(crewOps[idxSess ].filters,  [["eq", "user_id", USER_ID]], "crew sessions scoped to user");
    assert.deepEqual(crewOps[idxPrefs].filters,  [["eq", "user_id", USER_ID]], "crew preferences scoped to user");
  });

  it("orders Journey deletes around revocation-trigger side effects", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const idxObs  = c._ops.findIndex((o: Op) => o.table === "delete_journey_observations_for_user_v1" && o.op === "rpc");
    const idxJRev = c._ops.findIndex((o: Op) => o.table === "journey_revocation_jobs" && o.op === "delete");
    const idxSess = c._ops.findIndex((o: Op) => o.table === "location_sessions"      && o.op === "delete");
    const idxPrefs = c._ops.findIndex((o: Op) => o.table === "user_location_preferences" && o.op === "delete");
    assert.ok(idxObs  < idxSess, "journey_observations erase must precede location_sessions");
    assert.ok(idxPrefs < idxJRev, "revocation jobs must be removed after preference triggers");
    assert.ok(idxSess < idxJRev, "revocation jobs must be removed after session triggers");
  });

  it("journey_retention_health is NOT touched (operator singleton, no user_id)", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const touched = c._ops.some((o: Op) => o.table === "journey_retention_health");
    assert.equal(touched, false, "journey_retention_health must not be deleted per-account");
  });

  it("a failing Journey/location step retains durable work and leaves the claim retryable", async () => {
    const c = makeClient({ fail: { "location_sessions.delete": "relation does not exist" } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, false);
    assert.ok(
      out.steps.some((s) => s.step === "delete_location_sessions" && !s.ok),
      "failed step must be recorded",
    );
    assert.ok(
      out.warnings.some((w) => w.includes("location_sessions")),
      "warning must name the table",
    );
    assert.ok(
      out.warnings.some((w) => w.includes("revocation_jobs retained")),
      "durable revocation work must be retained",
    );
    assert.equal(
      opFor(c, "journey_revocation_jobs", "delete"),
      undefined,
      "revocation jobs must not be removed after a privacy-step failure",
    );
    assert.deepEqual(c._authDeleted, [], "auth user deletion must wait for restricted-data cleanup");
    assert.ok(opFor(c, "search_history", "delete"), "later steps still execute");
  });

  it("a Journey observation deletion failure cannot be hidden by deleting its retry jobs", async () => {
    const c = makeClient({ fail: { "delete_journey_observations_for_user_v1.rpc": "storage unavailable" } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, false);
    assert.equal(opFor(c, "journey_revocation_jobs", "delete"), undefined);
    assert.deepEqual(c._authDeleted, []);
    assert.equal(updateForStatus(c, "user_deletion_requests", "executed"), undefined);
    assert.equal(c._rows.user_deletion_requests[0].status, "executing");
  });
});

// ── Zero-orphan census ────────────────────────────────────────────────────────

describe("executeAccountDeletion — zero-orphan census", () => {
  /**
   * Seed one row for USER_ID and one for OTHER_ID in every journey/location
   * table (plus a representative set of existing tables). After running the
   * cascade for USER_ID only, assert that:
   *   - every USER_ID row is gone, and
   *   - every OTHER_ID row still exists.
   * journey_retention_health is intentionally excluded (no user_id column).
   */
  it("removes all USER_ID rows from every location/journey table while leaving OTHER_ID rows intact", async () => {
    const userRow  = (extra?: Record<string, any>) => ({ user_id: USER_ID,  ...extra });
    const otherRow = (extra?: Record<string, any>) => ({ user_id: OTHER_ID, ...extra });

    const c = makeClient({
      rows: {
        // journey / location tables under test
        journey_observations:           [userRow(), otherRow()],
        journey_revocation_jobs:        [userRow(), otherRow()],
        location_sessions:              [userRow(), otherRow()],
        user_location_state:            [userRow(), otherRow()],
        location_snapshots:             [userRow(), otherRow()],
        location_trust_events:          [userRow(), otherRow()],
        user_location_preferences:      [userRow(), otherRow()],
        trip_crew_location_events:      [userRow(), otherRow()],
        trip_crew_location_sessions:    [userRow(), otherRow()],
        trip_crew_location_preferences: [userRow(), otherRow()],
        // a representative sample of previously-existing tables
        stories:          [{ owner_id: USER_ID }, { owner_id: OTHER_ID }],
        story_reactions:  [userRow(), otherRow()],
        posts_likes:      [userRow(), otherRow()],
        search_history:   [userRow(), otherRow()],
        // devices seeded so key_packages step doesn't fail
        devices: [],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Tables keyed on user_id
    const userIdTables = [
      "journey_observations", "journey_revocation_jobs", "location_sessions",
      "user_location_state", "location_snapshots", "location_trust_events",
      "user_location_preferences", "trip_crew_location_events",
      "trip_crew_location_sessions", "trip_crew_location_preferences",
      "story_reactions", "posts_likes", "search_history",
    ];
    for (const t of userIdTables) {
      const remaining = c._rows[t] ?? [];
      const userOrphans  = remaining.filter((r) => r.user_id === USER_ID);
      const otherSurvive = remaining.filter((r) => r.user_id === OTHER_ID);
      assert.equal(userOrphans.length,  0, `${t}: USER_ID orphan remains`);
      assert.equal(otherSurvive.length, 1, `${t}: OTHER_ID row must survive`);
    }

    // stories uses owner_id
    const storiesLeft = c._rows["stories"] ?? [];
    assert.equal(storiesLeft.filter((r) => r.owner_id === USER_ID).length,  0, "stories: USER_ID orphan");
    assert.equal(storiesLeft.filter((r) => r.owner_id === OTHER_ID).length, 1, "stories: OTHER_ID survives");
  });
});

// ── The scheduler ────────────────────────────────────────────────────────────

describe("accountDeletionScheduler — fails closed", () => {
  beforeEach(() => _setTestServiceClient(null as any));

  it("does nothing when the feature flag is off", async () => {
    const c = makeClient({ rows: { feature_flags: [{ enabled: false }] } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.skipped, true);
    assert.equal(r.executed, 0);
    assert.equal(opFor(c, "user_deletion_requests", "select"), undefined, "must not even query for due rows");
  });

  it("does nothing when the flag row is missing", async () => {
    const c = makeClient({ rows: { feature_flags: [] } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();
    assert.equal(r.skipped, true);
    assert.deepEqual(c._authDeleted, []);
  });

  it("does nothing when the flag lookup errors", async () => {
    const c = makeClient({ fail: { feature_flags: "relation does not exist" } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();
    assert.equal(r.skipped, true);
  });

  it("executes due requests when enabled, filtering on pending + scheduled_at", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.skipped, false);
    assert.equal(r.considered, 1);
    assert.equal(r.executed, 1);
    assert.equal(r.failed, 0);

    const q = opFor(c, "user_deletion_requests", "select")!;
    assert.ok(
      q.filters.some(
        (f: any[]) => f[0] === "or"
          && String(f[1]).includes("status.eq.pending")
          && String(f[1]).includes("status.eq.executing"),
      ),
    );
    assert.ok(q.filters.some((f: any[]) => f[0] === "lte" && f[1] === "scheduled_at"));

    assert.deepEqual(c._authDeleted, [USER_ID], "the due account is actually deleted");
  });

  it("reports a failure instead of marking the request done", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
      fail: { "profiles.update": "db down" },
    });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.executed, 0);
    assert.equal(r.failed, 1);
    assert.deepEqual(c._authDeleted, []);
  });
});

// ── The internal worker endpoint (routes/profile.ts) ─────────────────────────

describe("POST /internal/deletion-requests/execute-due", () => {
  let server: http.Server;
  let base: string;
  const SECRET = "test-internal-secret";
  let savedSecret: string | undefined;

  before(async () => {
    savedSecret = process.env.INTERNAL_API_SECRET;
    process.env.INTERNAL_API_SECRET = SECRET;
    await new Promise<void>((resolve) => {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res: any, next: any) => {
        req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        next();
      });
      app.use("/api", profileRouter);
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => _setTestServiceClient(null as any));

  function post(headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL("/api/internal/deletion-requests/execute-due", base);
      const req = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST", headers },
        (res) => {
          let raw = "";
          res.on("data", (ch) => { raw += ch; });
          res.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("rejects a missing/invalid internal secret", async () => {
    _setTestServiceClient(makeClient() as any);
    const noSecret = await post();
    assert.equal(noSecret.status, 401);
    const badSecret = await post({ "x-internal-secret": "wrong" });
    assert.equal(badSecret.status, 401);
  });

  it("responds 503/skipped and touches nothing when the feature flag is off", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: false }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 503);
    assert.equal(body.skipped, true);
    assert.equal(opFor(c, "user_deletion_requests", "select"), undefined, "must not even query for due rows");
    assert.deepEqual(c._authDeleted, []);
  });

  it("executes due requests through the unified cascade when enabled", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.processed, 1);
    assert.equal(body.executed, 1);
    assert.deepEqual(body.failed, []);
    assert.deepEqual(c._authDeleted, [USER_ID], "cascade actually ran (auth user removed)");
    assert.ok(updateForStatus(c, "user_deletion_requests", "executed"));
  });

  it("leaves a failed request pending and reports it in `failed`", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
      authDeleteError: "auth API down",
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 200);
    assert.equal(body.executed, 0);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].userId, USER_ID);
    assert.ok(body.failed[0].failedSteps.some((s: any) => s.step === "auth_delete_user"));
    assert.equal(
      updateForStatus(c, "user_deletion_requests", "executed"),
      undefined,
      "request must NOT be marked executed on a failed cascade",
    );
  });
});
