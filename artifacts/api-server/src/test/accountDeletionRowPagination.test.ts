/**
 * Account deletion — the ROW-DELETE reads must PAGE
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed
 * ================================
 * `30c3d6129` paged the nine STORAGE COLLECTORS and reported two survivors on
 * the other side of the same bug — reads that feed a DELETE rather than a
 * storage remove. Those are the worse half. A collector that stops short leaves
 * BYTES in a bucket; one of these leaves the user's POSTS in the database.
 *
 *   * tombstone_or_delete_posts read `select("id").eq("author_id", …)` with no
 *     bound at all. PostgREST caps a range-less read at the project's
 *     db-max-rows (1000 here) WITHOUT AN ERROR, so a user past the cap had the
 *     surplus posts neither tombstoned nor hard-deleted — just left in place,
 *     authored by a profile that now reads "Deleted User" — while the step
 *     reported `ok` and the receipt said the account was erased. Silent success
 *     on rows instead of bytes, with the same distribution: only the accounts
 *     with the most content ever failed.
 *   * delete_key_packages passed `.limit(5000)`, ABOVE the server cap, so the
 *     server capped it at 1000 regardless and the bound was decoration. Only
 *     reachable past 1000 devices, so realistically inert — but a limit that
 *     cannot take effect is worse than none, because it reads as a decision and
 *     stops the next person looking.
 *
 * WHAT THESE TESTS DEMAND
 *   * THREE pages, not two. Two pages pass even if the loop happens to run
 *     exactly twice by accident; three is the smallest number that proves it
 *     continues while the data does.
 *   * EVERY post on every page is acted on — and the tombstone/hard-delete
 *     decision is still made per post on page 3, not just page 1.
 *   * THE ROWS ARE REALLY REMOVED FROM THE FAKE as the step deletes them. This
 *     is the trap specific to paging a read that feeds a delete: offset paging
 *     indexes into a result set, so deleting out of that set between pages
 *     shifts every later offset backwards and the loop skips one row for each
 *     one it removed. Draining the reader BEFORE the first delete is the only
 *     thing that makes the offsets mean what they say, and a read/act
 *     interleave fails here rather than in production.
 *   * A failure on page 2 FAILS THE STEP AND WARNS. Keeping page 1 and calling
 *     it the whole set is the original defect wearing a loop.
 *   * Stopping short WARNS, with a sentence about ROWS — "objects may remain in
 *     storage" would be simply untrue for a row delete.
 *   * ORDER IS REQUESTED. Offset paging over an unordered read may skip or
 *     repeat rows between pages; nothing obliges Postgres to return two offsets
 *     of the same query in the same order.
 *   * THE `.in()` LIST IS CHUNKED past one chunk. Paginating the device read
 *     removed the accidental ceiling that used to keep the id list short, and
 *     an unchunked `in.(…)` over thousands of uuids is a query string long
 *     enough to be REJECTED — which would turn a silently-short delete into a
 *     failed one.
 *
 * The fake client pages the way PostgREST does: `.range(from, to)` returns the
 * matching rows in `id` order sliced to that window, so a page is a real slice
 * of a real set and an off-by-one in the offset shows up as a missing or
 * duplicated row rather than passing unnoticed.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionRowPagination.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  COLLECTION_PAGE_SIZE,
  COLLECTION_MAX_PAGES,
} from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

/** The chunk size the service uses for `in.(…)` lists (IN_LIST_CHUNK). */
const IN_LIST_CHUNK = 200;

/** Sortable ids, so `order("id")` in the fake matches insertion order. */
const seqId = (prefix: string, i: number) => `${prefix}-${String(i).padStart(6, "0")}`;

interface Op {
  table: string;
  op: string;
  filters?: any[];
  range?: [number, number];
  limit?: number;
  ordered?: boolean;
  inList?: string[];
}

/**
 * Paging fake supabase client, with one capability the collector fake did not
 * need: DELETES REALLY REMOVE ROWS.
 *
 * That is the point. These steps read a set and then delete out of it, so a
 * fake whose tables never shrink cannot tell a correct collect-then-act
 * implementation apart from a read/act interleave that silently skips a page's
 * worth of rows every time it deletes one.
 */
function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** `table.op` -> error message, on every request. */
  fail?: Record<string, string>;
  /** `table.op` -> 0-based page index that should error (and later pages too). */
  failFromPage?: Record<string, number>;
  /** `table.op` -> error message, applied to the Nth request only. */
  rpcFail?: string;
  /** Tables whose reads IGNORE the requested range and always answer a full page. */
  ignoreRange?: string[];
  /** Drop `.range` from the builder entirely — the `.limit()` fallback path. */
  noRange?: boolean;
} = {}) {
  const rows: Record<string, any[]> = { posts: [], ...(opts.rows ?? {}) };
  const fail = opts.fail ?? {};
  const failFromPage = opts.failFromPage ?? {};
  const ignoreRange = new Set(opts.ignoreRange ?? []);
  const ops: Op[] = [];
  const authDeleted: string[] = [];
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const readCount: Record<string, number> = {};
  const fullPage = Array.from({ length: COLLECTION_PAGE_SIZE }, () => ({}));

  function matches(row: any, filters: any[]): boolean {
    for (const f of filters) {
      if (f[0] === "eq" && row[f[1]] !== f[2]) return false;
      if (f[0] === "in" && !(f[2] as any[]).includes(row[f[1]])) return false;
      if (f[0] === "neq" && row[f[1]] === f[2]) return false;
      // `.not("user_id", "is", null)` — the only `not` shape this service uses.
      if (f[0] === "not" && f[2] === "is" && f[3] === null && (row[f[1]] ?? null) === null) return false;
    }
    return true;
  }

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _single: false,
      _limit: undefined as number | undefined,
      _range: undefined as [number, number] | undefined,
      _ordered: false,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; void v; return q; },
      upsert(v: any) { q._op = "upsert"; void v; return q; },
      insert(v: any) { q._op = "insert"; void v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order(_c?: string) { q._ordered = true; return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      single() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        const key = `${table}.${q._op}`;
        const page = readCount[key] ?? 0;
        readCount[key] = page + 1;
        const inFilter = q._filters.find((f: any[]) => f[0] === "in");
        ops.push({
          table,
          op: q._op,
          filters: q._filters,
          ordered: q._ordered,
          ...(q._range ? { range: q._range } : {}),
          ...(q._limit != null ? { limit: q._limit } : {}),
          ...(inFilter ? { inList: inFilter[2] as string[] } : {}),
        });
        if (fail[key]) return Promise.resolve({ data: null, error: { message: fail[key] } });
        if (failFromPage[key] != null && page >= failFromPage[key]) {
          return Promise.resolve({ data: null, error: { message: `${key}: page ${page} exploded` } });
        }

        if (q._op === "delete") {
          // REALLY remove them. See the note on this fake.
          rows[table] = (rows[table] ?? []).filter((r) => !matches(r, q._filters));
          return Promise.resolve({ data: null, error: null });
        }
        if (q._op !== "select") return Promise.resolve({ data: null, error: null });

        if (ignoreRange.has(table)) {
          return Promise.resolve({ data: fullPage, error: null });
        }

        let data: any[] = (rows[table] ?? []).filter((r) => matches(r, q._filters));
        // A real PostgREST read is ordered before it is windowed.
        if (q._ordered) data = [...data].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
        if (q._range) data = data.slice(q._range[0], q._range[1] + 1);
        else if (q._limit != null) data = data.slice(0, q._limit);
        if (q._single) return Promise.resolve({ data: data.length > 0 ? data[0] : null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };
    if (!opts.noRange) {
      q.range = (from: number, to: number) => { q._range = [from, to]; return q; };
    }
    return q;
  }

  return {
    _ops: ops,
    _reads: readCount,
    _rows: rows,
    _rpcCalls: rpcCalls,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc" });
      rpcCalls.push({ fn, args });
      if (opts.rpcFail && fn === "tombstone_post") {
        return { data: null, error: { message: opts.rpcFail } };
      }
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          ops.push({ table: `storage:${bucket}`, op: "remove" });
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

const stepOf = (out: any, name: string) => out.steps.find((s: any) => s.step === name);
const selectOps = (c: any, table: string) =>
  c._ops.filter((o: Op) => o.table === table && o.op === "select");
const deleteOps = (c: any, table: string) =>
  c._ops.filter((o: Op) => o.table === table && o.op === "delete");

// ── 1. posts: three pages, all of them acted on ──────────────────────────────

describe("account deletion — tombstone_or_delete_posts pages through every post", () => {
  it("acts on all THREE pages of a heavy author's posts", async () => {
    // 2 full pages + a partial one. Two pages would pass even if the loop ran
    // exactly twice by accident; the third page proves it continues.
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 137;
    const posts = Array.from({ length: TOTAL }, (_, i) => ({
      id: seqId("post", i),
      author_id: USER_ID,
    }));
    const c = makeClient({ rows: { posts } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(stepOf(out, "tombstone_or_delete_posts").ok, true);

    // Not one post survives. This is the assertion the whole file exists for:
    // under the unpaginated read the tail of the table stayed exactly where it
    // was, and the step still said ok.
    assert.equal(
      (c._rows.posts as any[]).length,
      0,
      `${(c._rows.posts as any[]).length} post(s) survived the deletion`,
    );
    assert.equal(out.deletedCounts.posts, TOTAL);
    assert.equal(out.tombstonedCounts.posts, 0);

    // Exactly three reads: two full pages and the short one that ends the loop.
    assert.equal(c._reads["posts.select"], 3, JSON.stringify(selectOps(c, "posts")));

    // Contiguous, non-overlapping windows — an off-by-one in the offset would
    // either skip a post or hand the same one back twice, and the fake really
    // slices, so it would show up here rather than pass.
    assert.deepEqual(
      selectOps(c, "posts").map((o: Op) => o.range),
      [
        [0, COLLECTION_PAGE_SIZE - 1],
        [COLLECTION_PAGE_SIZE, COLLECTION_PAGE_SIZE * 2 - 1],
        [COLLECTION_PAGE_SIZE * 2, COLLECTION_PAGE_SIZE * 3 - 1],
      ],
    );

    // A post from EVERY page was individually deleted, named by its own id.
    const deletedIds = new Set(
      deleteOps(c, "posts").map((o: Op) => (o.filters ?? []).find((f: any[]) => f[0] === "eq" && f[1] === "id")?.[2]),
    );
    assert.equal(deletedIds.size, TOTAL);
    for (const i of [0, COLLECTION_PAGE_SIZE - 1, COLLECTION_PAGE_SIZE, COLLECTION_PAGE_SIZE * 2, TOTAL - 1]) {
      assert.ok(deletedIds.has(seqId("post", i)), `post ${i} (page ${Math.floor(i / COLLECTION_PAGE_SIZE) + 1}) must be acted on`);
    }

    assert.deepEqual(out.warnings, [], JSON.stringify(out.warnings));
  });

  it("still makes the tombstone-vs-delete decision per post on page THREE", async () => {
    // The paging must not turn a per-post ruling into a per-page one. One post
    // on each page carries a third-party comment and must be TOMBSTONED, not
    // hard-deleted — including the one past the second page boundary, which the
    // unpaginated read never even saw.
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 50;
    const tombstoneAt = [3, COLLECTION_PAGE_SIZE + 7, COLLECTION_PAGE_SIZE * 2 + 11];
    const posts = Array.from({ length: TOTAL }, (_, i) => ({ id: seqId("post", i), author_id: USER_ID }));
    const posts_comments = tombstoneAt.map((i, n) => ({
      id: seqId("cmt", n),
      post_id: seqId("post", i),
      user_id: OTHER_ID, // somebody else contributed to the thread
    }));
    const c = makeClient({ rows: { posts, posts_comments } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(out.tombstonedCounts.posts, 3);
    assert.equal(out.deletedCounts.posts, TOTAL - 3);

    const tombstoned = new Set(c._rpcCalls.filter((r: any) => r.fn === "tombstone_post").map((r: any) => r.args.p_post_id));
    for (const i of tombstoneAt) {
      assert.ok(tombstoned.has(seqId("post", i)), `post ${i} has a third-party comment and must be tombstoned`);
    }
    // The tombstoned rows are the ONLY survivors — they are blanked in place.
    assert.equal((c._rows.posts as any[]).length, 3);
  });

  it("requests an ORDER, so the offsets index into a stable set", async () => {
    const posts = Array.from({ length: COLLECTION_PAGE_SIZE + 3 }, (_, i) => ({
      id: seqId("post", i), author_id: USER_ID,
    }));
    const c = makeClient({ rows: { posts } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true);
    const reads = selectOps(c, "posts");
    assert.equal(reads.length, 2);
    for (const r of reads) {
      assert.equal(r.ordered, true, "an unordered read may repeat or skip rows between offsets");
    }
  });

  it("reads EVERY page before it deletes any post", async () => {
    // The trap in paging a read that feeds a delete. Interleaving read and act
    // shifts every later offset backwards by the number of rows removed, so the
    // loop skips a page's worth for each page it deletes. The fake really
    // removes rows, so an interleaved implementation loses posts here.
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 9;
    const posts = Array.from({ length: TOTAL }, (_, i) => ({ id: seqId("post", i), author_id: USER_ID }));
    const c = makeClient({ rows: { posts } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const firstDelete = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "delete");
    const lastRead = (() => {
      for (let i = c._ops.length - 1; i >= 0; i -= 1) {
        if (c._ops[i].table === "posts" && c._ops[i].op === "select") return i;
      }
      return -1;
    })();
    assert.ok(firstDelete > -1 && lastRead > -1);
    assert.ok(
      lastRead < firstDelete,
      "every page of post ids must be read BEFORE the first post is deleted — deleting mid-scan shifts the offsets",
    );
    assert.equal((c._rows.posts as any[]).length, 0);
  });
});

// ── 2. posts: failure and truncation are never silent ────────────────────────

describe("account deletion — a short post read is never reported as a clean one", () => {
  it("FAILS the step and warns when page 2 of the post read errors", async () => {
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 4;
    const posts = Array.from({ length: TOTAL }, (_, i) => ({ id: seqId("post", i), author_id: USER_ID }));
    const c = makeClient({ rows: { posts }, failFromPage: { "posts.select": 1 } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    const st = stepOf(out, "tombstone_or_delete_posts");
    assert.equal(st.ok, false, "a read that failed halfway is not a completed deletion");
    assert.match(st.error, /page 1 exploded/);
    assert.ok(
      out.warnings.some((w: string) => w.includes("posts may remain")),
      JSON.stringify(out.warnings),
    );
    // And it did NOT quietly proceed with page 1 as if that were the whole set.
    assert.equal(deleteOps(c, "posts").length, 0);
  });

  it("WARNS that the deletion is INCOMPLETE when the read stops short", async () => {
    // A client with no `.range` at all: the read is still bounded by `.limit()`,
    // but a FULL page with no way to ask for the next one is a truncation, and
    // it must say so rather than pass as a complete read.
    const posts = Array.from({ length: COLLECTION_PAGE_SIZE + 25 }, (_, i) => ({
      id: seqId("post", i), author_id: USER_ID,
    }));
    const c = makeClient({ rows: { posts }, noRange: true });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "tombstone_or_delete_posts").ok, true);
    const warning = out.warnings.find((w: string) => w.startsWith("posts may remain —"));
    assert.ok(warning, JSON.stringify(out.warnings));
    assert.match(warning!, /INCOMPLETE/);
    // The sentence is about ROWS, not storage objects — "objects may remain in
    // storage" would be a false statement about a row delete.
    assert.doesNotMatch(warning!, /objects may remain in storage/);
    // It still did the work it could see: a partial erasure beats none.
    assert.equal(out.deletedCounts.posts, COLLECTION_PAGE_SIZE);
    assert.equal((c._rows.posts as any[]).length, 25);
    // The bound really was applied, and it is the page size — not 5000, not none.
    assert.equal(selectOps(c, "posts")[0].limit, COLLECTION_PAGE_SIZE);
  });

  it("WARNS at the page cap rather than looping forever inside a deletion", async () => {
    // The pathological backend: it ignores the range and answers a full page
    // every time. The loop must terminate at the cap and say the deletion is
    // incomplete.
    const c = makeClient({ rows: { posts: [] }, ignoreRange: ["posts"] });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "tombstone_or_delete_posts").ok, true);
    assert.equal(c._reads["posts.select"], COLLECTION_MAX_PAGES);
    const warning = out.warnings.find((w: string) => w.startsWith("posts may remain —"));
    assert.ok(warning, JSON.stringify(out.warnings));
    assert.match(warning!, /INCOMPLETE/);
  });
});

// ── 3. key_packages: the device read pages, and the `.in()` list is chunked ──

describe("account deletion — delete_key_packages pages the device read", () => {
  it("collects all THREE pages of devices instead of a capped 5000", async () => {
    const TOTAL = COLLECTION_PAGE_SIZE * 2 + 61;
    const devices = Array.from({ length: TOTAL }, (_, i) => ({ id: seqId("dev", i), user_id: USER_ID }));
    const c = makeClient({ rows: { devices } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const st = stepOf(out, "delete_key_packages");
    assert.equal(st.ok, true);
    assert.equal(st.count, TOTAL, "every device's key packages must be cleared, not the first page's");

    assert.equal(c._reads["devices.select"], 3, JSON.stringify(selectOps(c, "devices")));
    assert.deepEqual(
      selectOps(c, "devices").map((o: Op) => o.range),
      [
        [0, COLLECTION_PAGE_SIZE - 1],
        [COLLECTION_PAGE_SIZE, COLLECTION_PAGE_SIZE * 2 - 1],
        [COLLECTION_PAGE_SIZE * 2, COLLECTION_PAGE_SIZE * 3 - 1],
      ],
    );
    // The inert `.limit(5000)` is gone: nothing asks the server for more rows
    // than it will hand back.
    for (const o of selectOps(c, "devices")) {
      assert.equal(o.limit, undefined, "an explicit limit above db-max-rows is a no-op dressed as a bound");
      assert.equal(o.ordered, true);
    }
  });

  it("CHUNKS the device-id `.in()` list past one chunk", async () => {
    // Paging removed the accidental ceiling that used to keep this list short.
    // Unchunked, a heavy account's `in.(…)` would ride in a URL long enough to
    // be rejected — turning a silently-short delete into a failed one.
    const TOTAL = IN_LIST_CHUNK * 2 + 101; // 501 devices → 200 / 200 / 101
    const devices = Array.from({ length: TOTAL }, (_, i) => ({ id: seqId("dev", i), user_id: USER_ID }));
    const c = makeClient({ rows: { devices } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const kpDeletes = deleteOps(c, "key_packages");
    assert.ok(kpDeletes.length > 1, "more than one chunk, or the chunking is untested");
    assert.deepEqual(
      kpDeletes.map((o: Op) => (o.inList ?? []).length),
      [IN_LIST_CHUNK, IN_LIST_CHUNK, 101],
    );
    // Chunking must not LOSE ids: the union is every device, each exactly once.
    const all = kpDeletes.flatMap((o: Op) => o.inList ?? []);
    assert.equal(all.length, TOTAL);
    assert.equal(new Set(all).size, TOTAL);
    assert.ok(all.includes(seqId("dev", 0)));
    assert.ok(all.includes(seqId("dev", TOTAL - 1)));
  });

  it("FAILS and warns when the device read errors on page 2", async () => {
    const devices = Array.from({ length: COLLECTION_PAGE_SIZE * 2 }, (_, i) => ({
      id: seqId("dev", i), user_id: USER_ID,
    }));
    const c = makeClient({ rows: { devices }, failFromPage: { "devices.select": 1 } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "delete_key_packages").ok, false);
    assert.ok(
      out.warnings.some((w: string) => w.includes("key_packages rows may remain")),
      JSON.stringify(out.warnings),
    );
    // It did not delete key_packages for page 1 and call the account clean.
    assert.equal(deleteOps(c, "key_packages").length, 0);
  });

  it("still clears key_packages BEFORE the devices rows they FK", async () => {
    // Paging must not have moved the step relative to delete_devices; the FK
    // makes the order load-bearing.
    const devices = Array.from({ length: COLLECTION_PAGE_SIZE + 2 }, (_, i) => ({
      id: seqId("dev", i), user_id: USER_ID,
    }));
    const c = makeClient({ rows: { devices } });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true);

    const idxKp = c._ops.findIndex((o: Op) => o.table === "key_packages" && o.op === "delete");
    const idxDev = c._ops.findIndex((o: Op) => o.table === "devices" && o.op === "delete");
    assert.ok(idxKp > -1 && idxDev > -1);
    assert.ok(idxKp < idxDev, "key_packages must be cleared before the devices rows they reference");
    // And the whole device read finished before either delete.
    const lastRead = (() => {
      for (let i = c._ops.length - 1; i >= 0; i -= 1) {
        if (c._ops[i].table === "devices" && c._ops[i].op === "select") return i;
      }
      return -1;
    })();
    assert.ok(lastRead < idxKp);
  });
});

// ── 4. The ordinary account pays nothing ─────────────────────────────────────

describe("account deletion — paging costs a light account exactly one request", () => {
  it("reads posts and devices once each when they fit in a page", async () => {
    const c = makeClient({
      rows: {
        posts: [{ id: seqId("post", 0), author_id: USER_ID }],
        devices: [{ id: seqId("dev", 0), user_id: USER_ID }],
      },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    // A short page is the end of the data AND the end of the requests — a pager
    // that always probes for a page that cannot exist is a tax on every account.
    assert.equal(c._reads["posts.select"], 1);
    assert.equal(c._reads["devices.select"], 1);
    assert.deepEqual(out.warnings, [], JSON.stringify(out.warnings));
    assert.equal(deleteOps(c, "key_packages").length, 1);
  });
});
