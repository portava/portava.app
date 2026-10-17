/**
 * Account deletion — the storage collectors must PAGE
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed
 * ================================
 * None of the collection steps passed a `.range()` or a `.limit()`. A
 * range-less PostgREST read is capped by the project's `db-max-rows` (1000 on
 * this deployment — the figure lib/intelProjectionScheduler records and pages
 * against, using the same service-role client) and the cap is applied WITHOUT
 * AN ERROR: `data` simply stops. So a user with more rows than the cap in any
 * collected table had the surplus dropped, their bytes stayed in the bucket,
 * the step reported `ok` with a plausible count, and the deletion was reported
 * successful.
 *
 * The distribution is what makes it serious: the accounts that failed were the
 * ones with the MOST content. A user with three photos was always erased
 * correctly; a user with three thousand never was.
 *
 * WHAT THESE TESTS DEMAND
 *   * THREE pages, not two. A two-page test passes even if the loop happens to
 *     run exactly twice; three is the smallest number that proves the loop
 *     really continues while the data does.
 *   * A single partial page costs exactly ONE request. A pager that always
 *     probes for a page that cannot exist is a per-deletion tax on every
 *     ordinary account.
 *   * A failure on page 2 FAILS THE STEP AND WARNS. Returning page 1 and
 *     calling it a complete read is the original defect wearing a loop.
 *   * Hitting the page cap WARNS. The cap exists so a malformed backend cannot
 *     spin forever inside a deletion — but a bounded read that stopped early is
 *     still an incomplete read, and it must say so.
 *   * ORDER SURVIVES PAGING. Collection still finishes before the storage
 *     removes and before the row deletes; a collector that read its later pages
 *     after `delete_stories` would find nothing there.
 *   * THE GUARD SURVIVES PAGING. A foreign key on page 2 is refused exactly as
 *     it is on page 1 — pagination must not become a way around
 *     collectOwnedReference.
 *
 * The fake client pages the way PostgREST does: `.range(from, to)` returns the
 * matching rows in `id` order sliced to that window, so a page is a real slice
 * of a real set rather than a canned second response.
 *
 * MUTATION PROOF: see the header of the run in the task report — reverting the
 * pager to a single unpaginated read turns the page-spanning tests RED.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionPagination.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  COLLECTION_PAGE_SIZE,
  COLLECTION_MAX_PAGES,
  POST_MEDIA_BUCKET,
} from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

/** Public-URL form, the shape memory_items stores. */
const publicUrl = (path: string) =>
  `https://proj.supabase.co/storage/v1/object/public/${POST_MEDIA_BUCKET}/${path}`;

/** Sortable ids, so `order("id")` in the fake matches insertion order. */
const seqId = (prefix: string, i: number) => `${prefix}-${String(i).padStart(6, "0")}`;

interface Op {
  table: string;
  op: string;
  filters?: any[];
  range?: [number, number];
  limit?: number;
  paths?: string[];
  values?: Record<string, unknown>;
}

/**
 * Paging fake supabase client.
 *
 * Two things make it worth more than a stub:
 *   * `eq` / `in` are really applied, so "this user's rows" is a real subset
 *     rather than whatever the fake was handed;
 *   * `range(from, to)` really slices the ordered result, so page 2 is the
 *     genuine continuation of page 1 and an off-by-one in the offset shows up
 *     as a missing or duplicated row rather than passing unnoticed.
 *
 * Every DB read, DB write, RPC and storage remove lands in one `ops` list in
 * the order it happened, so "collected before deleted" is checkable rather than
 * inferred.
 */
function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** `table.op` -> error message. */
  fail?: Record<string, string>;
  /** `table.op` -> 0-based page index that should error (later pages too). */
  failFromPage?: Record<string, number>;
  /**
   * Tables whose reads IGNORE the requested range and always answer with a
   * full page — the malformed backend the page cap exists for.
   */
  ignoreRange?: string[];
} = {}) {
  const rows: Record<string, any[]> = { posts: [], ...structuredClone(opts.rows ?? {}) };
  const fail = opts.fail ?? {};
  const failFromPage = opts.failFromPage ?? {};
  const ignoreRange = new Set(opts.ignoreRange ?? []);
  const ops: Op[] = [];
  const storageRemoved: Array<{ bucket: string; paths: string[] }> = [];
  const authDeleted: string[] = [];
  /** Reads seen per `table.op`, to drive failFromPage and to count requests. */
  const readCount: Record<string, number> = {};
  /** One shared full page for the ignore-range tables: allocated once, not per request. */
  const fullPage = Array.from({ length: COLLECTION_PAGE_SIZE }, () => ({}));

  function matches(row: any, filters: any[]): boolean {
    for (const f of filters) {
      if (f[0] === "eq" && row[f[1]] !== f[2]) return false;
      if (f[0] === "in" && !(f[2] as any[]).includes(row[f[1]])) return false;
      if (f[0] === "neq" && row[f[1]] === f[2]) return false;
      if (f[0] === "is" && row[f[1]] !== f[2]) return false;
      if (f[0] === "gt" && !(row[f[1]] > f[2])) return false;
      if (f[0] === "lte" && !(row[f[1]] <= f[2])) return false;
      if (f[0] === "or" && !String(f[1]).split(",").some(part => {
        const [column, operator, value] = part.split(".");
        return operator === "eq" && row[column!] === value;
      })) return false;
    }
    return true;
  }

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _limit: undefined as number | undefined,
      _range: undefined as [number, number] | undefined,
      _ordered: false,
      select() { return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      is(column: string, value: unknown) { q._filters.push(["is", column, value]); return q; },
      gt(column: string, value: unknown) { q._filters.push(["gt", column, value]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order(_c?: string) { q._ordered = true; return q; },
      limit(n: number) { q._limit = n; return q; },
      range(from: number, to: number) { q._range = [from, to]; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      single() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        const key = `${table}.${q._op}`;
        const page = readCount[key] ?? 0;
        readCount[key] = page + 1;
        ops.push({
          table,
          op: q._op,
          filters: q._filters,
          values: q._values,
          ...(q._range ? { range: q._range } : {}),
          ...(q._limit != null ? { limit: q._limit } : {}),
        });
        if (fail[key]) return Promise.resolve({ data: null, error: { message: fail[key] } });
        if (failFromPage[key] != null && page >= failFromPage[key]) {
          return Promise.resolve({ data: null, error: { message: `${key}: page ${page} exploded` } });
        }
        if (q._op !== "select" && !["media_assets", "user_deletion_requests", "profiles"].includes(table)) return Promise.resolve({ data: null, error: null });

        if (ignoreRange.has(table)) {
          // The pathological backend: a full page, forever, whatever we asked for.
          return Promise.resolve({ data: fullPage, error: null });
        }

        let data: any[] = (rows[table] ?? []).filter((r) => matches(r, q._filters));
        // A real PostgREST read is ordered before it is windowed.
        if (q._ordered) data = [...data].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
        if (q._range) data = data.slice(q._range[0], q._range[1] + 1);
        else if (q._limit != null) data = data.slice(0, q._limit);
        if (q._op === "update") for (const row of data) {
          Object.assign(row, q._values);
          if (table === "media_assets") row.version += 3;
        }
        if (q._op === "delete") rows[table] = rows[table]!.filter(row => !data.includes(row));
        if (q._single && data.length > 1) return Promise.resolve({ data: null, error: { message: "Multiple rows" } });
        data = structuredClone(data);
        if (q._single) return Promise.resolve({ data: data.length > 0 ? data[0] : null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _ops: ops,
    _rows: rows,
    _reads: readCount,
    _storageRemoved: storageRemoved,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc" });
      void args;
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          ops.push({ table: `storage:${bucket}`, op: "remove", paths });
          storageRemoved.push({ bucket, paths });
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; },
      },
    },
  };
}

const removedPaths = (c: any): string[] => c._storageRemoved.flatMap((r: any) => r.paths);
const stepOf = (out: any, name: string) => out.steps.find((s: any) => s.step === name);
const opIndex = (c: any, table: string, op: string) =>
  c._ops.findIndex((o: Op) => o.table === table && o.op === op);
const lastOpIndex = (c: any, table: string, op: string) => {
  for (let i = c._ops.length - 1; i >= 0; i -= 1) {
    if (c._ops[i].table === table && c._ops[i].op === op) return i;
  }
  return -1;
};
const firstStorageRemoveIndex = (c: any) => c._ops.findIndex((o: Op) => o.op === "remove");

// ── 1. Three pages ───────────────────────────────────────────────────────────

describe("account deletion — collection pages through every row", () => {
  it("collects all THREE pages of a heavy user's story media", async () => {
    // 2 full pages + a partial one. Two pages would pass even if the loop ran
    // exactly twice by accident; the third page is what proves it continues.
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 137;
    const stories = Array.from({ length: TOTAL }, (_, i) => ({
      id: seqId("story", i),
      owner_id: USER_ID,
      media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/story-${i}.jpg`,
    }));
    const c = makeClient({ rows: { stories } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Every single object, not the first page of them.
    const removed = new Set(removedPaths(c));
    assert.equal(removed.size, TOTAL, `expected ${TOTAL} distinct objects, got ${removed.size}`);
    for (const i of [0, COLLECTION_PAGE_SIZE - 1, COLLECTION_PAGE_SIZE, TOTAL - 1]) {
      assert.ok(
        removed.has(`${USER_ID}/story-${i}.jpg`),
        `story ${i} (page ${Math.floor(i / COLLECTION_PAGE_SIZE) + 1}) must be removed`,
      );
    }
    assert.equal(stepOf(out, "collect_story_media_paths").count, TOTAL);

    // Exactly three reads: two full pages and the short one that ends the loop.
    assert.equal(c._reads["stories.select"], 3, JSON.stringify(c._ops.filter((o: Op) => o.table === "stories")));

    // The windows are contiguous and non-overlapping — an off-by-one in the
    // offset would either skip a row or hand the same one back twice.
    const ranges = c._ops.filter((o: Op) => o.table === "stories" && o.op === "select").map((o: Op) => o.range);
    assert.deepEqual(ranges, [
      [0, COLLECTION_PAGE_SIZE - 1],
      [COLLECTION_PAGE_SIZE, COLLECTION_PAGE_SIZE * 2 - 1],
      [COLLECTION_PAGE_SIZE * 2, COLLECTION_PAGE_SIZE * 3 - 1],
    ]);

    // No spurious warnings: a complete three-page read is a complete read.
    assert.deepEqual(out.warnings, [], JSON.stringify(out.warnings));
  });

  it("pages the message table, where a heavy user's rows actually pile up", async () => {
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 1;
    const messages = Array.from({ length: TOTAL }, (_, i) => ({
      id: seqId("msg", i),
      sender_id: USER_ID,
      media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/msg-${i}.jpg`,
      media_thumbnail_url: null,
    }));
    const c = makeClient({ rows: { messages } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(stepOf(out, "collect_message_media_paths").count, TOTAL);
    assert.equal(new Set(removedPaths(c)).size, TOTAL);
    assert.equal(c._reads["messages.select"], 3);
  });

  it("pages EVERY set-returning collection step, not just the one under test", async () => {
    const N = COLLECTION_PAGE_SIZE + 11;
    const idx = Array.from({ length: N }, (_, i) => i);
    const memoryIds = idx.map((i) => seqId("mem", i));
    const c = makeClient({
      rows: {
        profiles: [{ id: USER_ID, account_status: "deletion_pending", avatar_url: null, cover_photo_url: null }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending" }],
        post_media: idx.map((i) => ({
          id: seqId("pm", i), user_id: USER_ID,
          storage_bucket: POST_MEDIA_BUCKET, storage_path: `${USER_ID}/pm-${i}.jpg`,
        })),
        media_assets: idx.map((i) => ({
          id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, owner_user_id: USER_ID, uploader_user_id: null,
          version: 4, thumbnail_path: null, media_type: "image", size_bytes: 128, deleted_at: null,
          updated_at: "2026-10-16T00:00:00.000Z", moderation_status: "approved", processing_status: "ready", purge_status: "not_requested",
          storage_bucket: POST_MEDIA_BUCKET, storage_path: `${USER_ID}/ma-${i}.jpg`,
        })),
        memories: memoryIds.map((id) => ({ id, owner_id: USER_ID })),
        memory_items: idx.map((i) => ({
          id: seqId("mi", i), memory_id: memoryIds[i],
          media_url: publicUrl(`memories/${USER_ID}/mi-${i}.jpg`),
        })),
        intel_evidence: idx.map((i) => ({
          id: seqId("ev", i), actor_id: USER_ID,
          reference: `${POST_MEDIA_BUCKET}/${USER_ID}/ev-${i}.jpg`,
        })),
        stories: idx.map((i) => ({
          id: seqId("st", i), owner_id: USER_ID,
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/st-${i}.jpg`,
        })),
        messages: idx.map((i) => ({
          id: seqId("ms", i), sender_id: USER_ID,
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/ms-${i}.jpg`,
        })),
        hidden_gems: idx.map((i) => ({
          id: seqId("hg", i), submitted_by: USER_ID,
          image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/hg-${i}.jpg`,
        })),
        reviews: idx.map((i) => ({
          id: seqId("rv", i), reviewer_id: USER_ID,
          photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/rv-${i}.jpg`],
        })),
      },
    });

    const outcomes = [];
    const removedPerRun = [];
    for (let pass = 0; pass < Math.ceil(N / 100); pass += 1) {
      const before = c._rows.media_assets!.length;
      const outcome = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
      outcomes.push(outcome);
      const remaining = c._rows.media_assets!.length;
      removedPerRun.push(before - remaining);
      assert.equal(before - remaining, Math.min(100, before), "each run must make bounded, distinct source progress");
      if (remaining > 0) {
        assert.equal(outcome.ok, false, "unprocessed Media must keep this run retryable");
        assert.equal(c._rows.user_deletion_requests![0].status, "pending");
        assert.equal(c._rows.user_deletion_requests![0].user_id, USER_ID);
        assert.equal(c._rows.profiles![0].account_status, "deletion_pending");
        assert.deepEqual(c._authDeleted, []);
        assert.equal(stepOf(outcome, "erase_canonical_account_media").ok, false);
        assert.ok(outcome.warnings.some(warning => warning.includes("Media cleanup unconfirmed")));
        assert.equal(c._ops.filter(operation => operation.table === "profiles" && operation.op === "update").length, 0);
      }
    }
    const out = outcomes.at(-1)!;
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.deepEqual(removedPerRun, [100, 100, 100, 100, 100, 11]);
    assert.equal(c._rows.media_assets!.length, 0);
    assert.equal(c._rows.user_deletion_requests![0].status, "completed");
    assert.equal(c._rows.user_deletion_requests![0].user_id, null);
    assert.deepEqual(c._authDeleted, [USER_ID]);
    assert.equal(stepOf(out, "erase_canonical_account_media").count, 11);
    const canonicalDeletes = c._ops.filter(operation => operation.table === "media_assets" && operation.op === "delete");
    assert.equal(canonicalDeletes.length, N);
    assert.equal(new Set(canonicalDeletes.map(operation => operation.filters!.find(filter => filter[0] === "eq" && filter[1] === "id")[2])).size, N);
    for (const operation of canonicalDeletes) {
      assert.ok(operation.filters!.some(filter => filter[0] === "eq" && filter[1] === "version" && filter[2] === 10));
      assert.ok(operation.filters!.some(filter => filter[0] === "eq" && filter[1] === "purge_status" && filter[2] === "completed"));
    }

    for (const name of [
      "collect_post_media_paths",
      "collect_memory_media_paths",
      "collect_intel_evidence_paths",
      "collect_story_media_paths",
      "collect_message_media_paths",
      "collect_hidden_gem_media_paths",
      "collect_review_photo_paths",
    ]) {
      assert.equal(stepOf(out, name).count, N, `${name} must see all ${N} rows, not one page of them`);
    }

    // 8 collectors × N objects, all of them distinct and all of them removed.
    assert.equal(new Set(removedPaths(c)).size, N * 8);
    assert.deepEqual(out.warnings, [], JSON.stringify(out.warnings));
  });
});

// ── 2. Termination and request economy ───────────────────────────────────────

describe("account deletion — paging terminates without waste", () => {
  it("costs exactly ONE request when the user's rows fit in a partial page", async () => {
    const c = makeClient({
      rows: {
        stories: [
          { id: seqId("st", 0), owner_id: USER_ID, media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/a.jpg` },
          { id: seqId("st", 1), owner_id: USER_ID, media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/b.jpg` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(stepOf(out, "collect_story_media_paths").count, 2);
    // A short page IS the end of the data. Probing for a page that cannot exist
    // would be a round trip added to every ordinary deletion.
    assert.equal(c._reads["stories.select"], 1, JSON.stringify(c._ops.filter((o: Op) => o.table === "stories")));
    // …and an empty table costs one request too, not zero and not two.
    assert.equal(c._reads["hidden_gems.select"], 1);
    assert.deepEqual(out.warnings, []);
  });

  it("reads a second page when the first is exactly full, and stops there", async () => {
    // The boundary the short-page rule turns on: PAGE_SIZE rows look identical
    // to "there is more" until the next page comes back empty.
    const stories = Array.from({ length: COLLECTION_PAGE_SIZE }, (_, i) => ({
      id: seqId("st", i), owner_id: USER_ID,
      media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/st-${i}.jpg`,
    }));
    const c = makeClient({ rows: { stories } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(stepOf(out, "collect_story_media_paths").count, COLLECTION_PAGE_SIZE);
    assert.equal(c._reads["stories.select"], 2);
    assert.deepEqual(out.warnings, []);
  });
});

// ── 3. Failure inside a page must not fail open ──────────────────────────────

describe("account deletion — a failed page is a failed step, not a short read", () => {
  it("surfaces a warning when page 2 errors, instead of quietly keeping page 1", async () => {
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 40;
    const stories = Array.from({ length: TOTAL }, (_, i) => ({
      id: seqId("st", i), owner_id: USER_ID,
      media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/st-${i}.jpg`,
    }));
    // 0-based: page index 1 is the SECOND request.
    const c = makeClient({ rows: { stories }, failFromPage: { "stories.select": 1 } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    const st = stepOf(out, "collect_story_media_paths");
    assert.equal(st.ok, false, "a page that errored must fail the step");
    assert.ok(
      out.warnings.some((w: string) => w.includes("story media") && w.includes("could not be read")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`,
    );

    // Page 1 is still removed — a partial removal beats none, and the warning
    // is what stops it being mistaken for a complete one.
    const removed = new Set(removedPaths(c));
    assert.equal(removed.size, COLLECTION_PAGE_SIZE);
    assert.ok(removed.has(`${USER_ID}/st-0.jpg`));
    assert.ok(!removed.has(`${USER_ID}/st-${TOTAL - 1}.jpg`));

    // It did not keep hammering the broken table after the failure.
    assert.equal(c._reads["stories.select"], 2);
  });

  it("keeps one collector's page failure from suppressing the others", async () => {
    const c = makeClient({
      rows: {
        stories: Array.from({ length: COLLECTION_PAGE_SIZE + 5 }, (_, i) => ({
          id: seqId("st", i), owner_id: USER_ID,
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/st-${i}.jpg`,
        })),
        hidden_gems: [
          { id: seqId("hg", 0), submitted_by: USER_ID, image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/hg.jpg` },
        ],
      },
      failFromPage: { "stories.select": 1 },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(stepOf(out, "collect_story_media_paths").ok, false);
    assert.equal(stepOf(out, "collect_hidden_gem_media_paths").ok, true);
    assert.ok(removedPaths(c).includes(`${USER_ID}/hg.jpg`), "the gem must still be removed");
  });
});

// ── 4. The page cap ──────────────────────────────────────────────────────────

describe("account deletion — the page cap is bounded AND loud", () => {
  it("stops at the page cap and warns that the collection is INCOMPLETE", async () => {
    // A backend that ignores the offset and answers every request with a full
    // page. Unbounded, this spins forever INSIDE a deletion; bounded silently,
    // it is the original defect again.
    const c = makeClient({ ignoreRange: ["stories"] });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(c._reads["stories.select"], COLLECTION_MAX_PAGES, "the loop must terminate at the cap");
    assert.ok(
      out.warnings.some((w: string) => w.includes("story media") && w.includes("INCOMPLETE")),
      `hitting the cap must never be silent: ${JSON.stringify(out.warnings)}`,
    );
    assert.ok(
      out.warnings.some((w: string) => w.includes(String(COLLECTION_MAX_PAGES))),
      "the warning should name the cap it hit",
    );
    // The rest of the deletion still runs — a stalled deletion is worse than a
    // partial one, which is why this warns rather than aborting.
    assert.equal(c._authDeleted.length, 1);
  });
});

// ── 5. Ordering survives paging ──────────────────────────────────────────────

describe("account deletion — paging does not reorder collection after deletion", () => {
  it("finishes every page of collection before the storage removes and the row deletes", async () => {
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 3;
    const c = makeClient({
      rows: {
        stories: Array.from({ length: TOTAL }, (_, i) => ({
          id: seqId("st", i), owner_id: USER_ID,
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/st-${i}.jpg`,
        })),
        intel_evidence: Array.from({ length: COLLECTION_PAGE_SIZE + 2 }, (_, i) => ({
          id: seqId("ev", i), actor_id: USER_ID,
          reference: `${POST_MEDIA_BUCKET}/${USER_ID}/ev-${i}.jpg`,
        })),
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const lastStoryRead = lastOpIndex(c, "stories", "select");
    const lastEvidenceRead = lastOpIndex(c, "intel_evidence", "select");
    const firstRemove = firstStorageRemoveIndex(c);
    const storyDelete = opIndex(c, "stories", "delete");
    const eraseIntel = opIndex(c, "rpc:erase_intel_for_actor", "rpc");

    assert.ok(lastStoryRead > -1 && lastEvidenceRead > -1 && firstRemove > -1);
    assert.ok(storyDelete > -1 && eraseIntel > -1);

    // The LAST page of every collector, not merely the first, precedes the
    // removes — a pager that read later pages lazily would trip this.
    assert.ok(lastStoryRead < firstRemove, "story pages must all be read before storage removal begins");
    assert.ok(lastEvidenceRead < firstRemove, "evidence pages must all be read before storage removal begins");

    // And before the row deletes that destroy the references. erase_intel_for_actor
    // deletes the very rows whose `reference` says where the bytes live; page 2
    // of that read happening afterwards would find nothing.
    assert.ok(lastStoryRead < storyDelete, "story pages must all be read before delete_stories");
    assert.ok(lastEvidenceRead < eraseIntel, "evidence pages must all be read before erase_intel_for_actor");

    assert.equal(new Set(removedPaths(c)).size, TOTAL + COLLECTION_PAGE_SIZE + 2);
  });
});

// ── 6. The guard survives paging ─────────────────────────────────────────────

describe("account deletion — pagination is not a way around the ownership guard", () => {
  it("refuses a foreign key, a traversal and an external URL found on a LATER page", async () => {
    // The dangerous half of paging: the guard is applied per row, and rows on
    // page 2 have never been through it before. A mismatched remove() destroys
    // a third party's file.
    const messages: any[] = Array.from({ length: COLLECTION_PAGE_SIZE }, (_, i) => ({
      id: seqId("ms", i), sender_id: USER_ID,
      media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/mine-${i}.jpg`,
      media_thumbnail_url: null,
    }));
    // Page 2: one of ours, and three that must be refused.
    messages.push(
      { id: seqId("ms", COLLECTION_PAGE_SIZE + 0), sender_id: USER_ID,
        media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/mine-late.jpg`, media_thumbnail_url: null },
      { id: seqId("ms", COLLECTION_PAGE_SIZE + 1), sender_id: USER_ID,
        media_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.jpg`, media_thumbnail_url: null },
      { id: seqId("ms", COLLECTION_PAGE_SIZE + 2), sender_id: USER_ID,
        media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/../${OTHER_ID}/escape.jpg`, media_thumbnail_url: null },
      { id: seqId("ms", COLLECTION_PAGE_SIZE + 3), sender_id: USER_ID,
        media_url: "https://evil.example.com/somebody-elses.jpg", media_thumbnail_url: null },
    );
    const c = makeClient({ rows: { messages } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const removed = removedPaths(c);
    assert.ok(removed.includes(`${USER_ID}/mine-late.jpg`), "our own page-2 object must still be collected");
    assert.ok(
      !removed.some((p) => p.includes(OTHER_ID)),
      `no third-party path may be removed: ${JSON.stringify(removed.filter((p) => p.includes(OTHER_ID)))}`,
    );
    assert.ok(!removed.some((p) => p.includes("..")), "a traversal must never reach remove()");
    // PAGE_SIZE own objects on page 1 + exactly one on page 2.
    assert.equal(stepOf(out, "collect_message_media_paths").count, COLLECTION_PAGE_SIZE + 1);
    assert.equal(new Set(removed).size, COLLECTION_PAGE_SIZE + 1);
  });
});

// ── 7. The id list the collection feeds ──────────────────────────────────────

describe("account deletion — the memory id list survives paging", () => {
  it("collects items for memories past the first page, and chunks the id list", async () => {
    const N = COLLECTION_PAGE_SIZE + 7;
    const memoryIds = Array.from({ length: N }, (_, i) => seqId("mem", i));
    const c = makeClient({
      rows: {
        memories: memoryIds.map((id) => ({ id, owner_id: USER_ID })),
        memory_items: memoryIds.map((id, i) => ({
          id: seqId("mi", i), memory_id: id,
          media_url: publicUrl(`memories/${USER_ID}/item-${i}.jpg`),
        })),
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // The id read paged (2 requests for N rows), and every memory's item was found.
    assert.equal(c._reads["memories.select"], 2);
    assert.equal(stepOf(out, "collect_memory_media_paths").count, N);
    assert.equal(new Set(removedPaths(c)).size, N);
    assert.ok(removedPaths(c).includes(`memories/${USER_ID}/item-${N - 1}.jpg`));

    // The id list is chunked rather than sent as one enormous `in.(…)`: several
    // reads, and the owned-memory deletes carry chunked lists too.
    const itemReads = c._ops.filter((o: Op) => o.table === "memory_items" && o.op === "select");
    assert.ok(itemReads.length > 1, "an unbounded id list would have been one request");
    for (const op of itemReads) {
      const inFilter = (op.filters ?? []).find((f: any[]) => f[0] === "in");
      assert.ok(inFilter[2].length <= 200, `in.() list too long: ${inFilter[2].length}`);
    }
    const itemDeletes = c._ops.filter((o: Op) => o.table === "memory_items" && o.op === "delete");
    assert.ok(itemDeletes.length > 1, "the delete must be chunked the same way");
    assert.equal(stepOf(out, "delete_memory_items").ok, true);
  });
});
