/**
 * Story retention — the purge over the owner's archive.
 *
 * WHY THIS EXISTS
 * ---------------
 * This job deletes user content permanently, on a timer, with nobody watching.
 * The failure that matters is not "it crashed" — it is "it reported success and
 * did nothing", or "it reported nothing to do because it could not look". The
 * predecessor sweep (routes/stories.ts:973) was exactly the first shape: real
 * code, correct logic, no caller, and a tree that read as though expiry worked.
 *
 * So every assertion here is about the RESULTING STATE — what rows and objects
 * exist afterwards — never about what a call returned. supabase-js resolves on
 * database errors and `storage.remove()` resolves for a path it never touched,
 * so a return value proves nothing about the world.
 *
 * WHAT IS PINNED, AND THE TRAP EACH ONE GUARDS
 * --------------------------------------------
 *   - The ledger is written BEFORE anything is destroyed, and carries the
 *     storage path. Trap: deleting the row first loses the only record of
 *     where the bytes are, and the object becomes permanent and unfindable.
 *   - A read-back, not the remove() result, decides `object_deleted_at`. Trap:
 *     a remove that silently did nothing marks the object gone forever.
 *   - An unreadable reference table means KEEP THE BYTES. Trap: treating an
 *     outage as "no Highlight references this" deletes a live Highlight's
 *     media, which nothing can undo.
 *   - A pass with failures is never a success and never reports zero work, and
 *     the scheduler will not call itself healthy on the strength of having been
 *     attempted. Trap: the whole class of jobs that stop working quietly.
 *   - Repeated delete requests do not extend the recovery window. That one is
 *     enforced by migration 2998's trigger and rehearsed against real Postgres
 *     in src/scripts/rehearseStoryRetention.ts — a fake client cannot prove a
 *     database trigger, and pretending otherwise here would be the vacuous kind
 *     of green.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). The verdict is the exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/storyRetention.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  enqueueDueStories,
  processPurgeQueue,
  purgeExpiredEngagement,
  runStoryRetention,
  findSurvivingReferences,
  splitStoragePath,
} from "../services/stories/storyRetention.js";
import {
  resolveStoryRetentionConfig,
  PUBLISHED_STORY_RETENTION,
  POLICY_ACK_TOKEN,
} from "../services/stories/storyRetentionPolicy.js";
import {
  runStoryRetentionTick,
  getStoryRetentionStatus,
  _resetStoryRetentionStatus,
} from "../lib/storyRetentionScheduler.js";

// ═══════════════════════════════════════════════════════════════════════════
// An in-memory stand-in for Supabase that applies the filters for real.
//
// Deliberately NOT a recorder of calls. A recorder would let a purge that
// filtered on the wrong column pass, because the assertion would be about the
// call rather than about which rows survived. This one holds rows, applies the
// operators the service actually uses, and is then queried for what is left.
// ═══════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>;

class FakeDb {
  tables: Record<string, Row[]> = {};
  /** table -> error returned instead of rows, for the fail-closed cases. */
  readErrors: Record<string, any> = {};
  /**
   * table -> columns the database does NOT have. A query that NAMES one fails
   * with 42703; every other query on the same table still works.
   *
   * That distinction is the whole point. `readErrors` breaks a table outright,
   * which is indistinguishable from an outage and makes every caller fail
   * together. A migration that has not been applied is narrower and more
   * dangerous: most reads succeed, and only the ones mentioning the new column
   * fail. That is the shape production has today with 2998 unapplied, and it is
   * the only shape in which the order of the calls inside runStoryRetention can
   * be observed.
   */
  missingColumns: Record<string, string[]> = {};
  /** bucket -> the object paths that exist. */
  storage: Record<string, Set<string>> = {};
  /** When true, remove() resolves cleanly but leaves the object in place. */
  removeIsALie = false;
  /** When set, remove() resolves with this error. */
  removeError: any = null;

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }
  objects(bucket: string): Set<string> {
    this.storage[bucket] ??= new Set();
    return this.storage[bucket];
  }
}

function matches(row: Row, filters: Array<[string, string, any]>): boolean {
  return filters.every(([col, op, val]) => {
    const v = row[col];
    switch (op) {
      case "eq": return v === val;
      case "in": return (val as any[]).includes(v);
      case "isNull": return v === null || v === undefined;
      case "notNull": return v !== null && v !== undefined;
      case "lt": return v !== null && v !== undefined && String(v) < String(val);
      case "lte": return v !== null && v !== undefined && String(v) <= String(val);
      case "gt": return v !== null && v !== undefined && String(v) > String(val);
      // PostgREST's `.or("a.lt.X,b.lt.Y")`. Parsed and applied for real rather
      // than waved through: this fake exists to run the SELECT the service
      // actually issues, and an `or` that matched everything would make the
      // archive-deadline predicate untestable while looking tested.
      case "or": {
        const terms = String(val).split(",").map((t) => t.trim()).filter(Boolean);
        return terms.some((term) => {
          const firstDot = term.indexOf(".");
          const secondDot = term.indexOf(".", firstDot + 1);
          if (firstDot < 0 || secondDot < 0) throw new Error(`fake db: unparseable or() term ${term}`);
          const c = term.slice(0, firstDot);
          const o = term.slice(firstDot + 1, secondDot);
          const raw = term.slice(secondDot + 1);
          return matches(row, [[c, o, raw]]);
        });
      }
      default: throw new Error(`fake db: unsupported operator ${op}`);
    }
  });
}

function makeClient(db: FakeDb): any {
  const from = (table: string) => {
    const filters: Array<[string, string, any]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let mode: "select" | "update" | "delete" | "upsert" = "select";
    let patch: Row | null = null;
    let upsertRows: Row[] = [];
    let upsertOpts: any = {};
    let countMode = false;
    let headMode = false;

    const selected = (): Row[] => {
      let out = db.rows(table).filter((r) => matches(r, filters));
      if (orderCol) {
        out = [...out].sort((a, b) => {
          const av = String(a[orderCol!] ?? "");
          const bv = String(b[orderCol!] ?? "");
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    /** Every column this query names, including the ones inside an `or` term. */
    const namedColumns = (): string[] => {
      const out: string[] = [];
      for (const [col, op, val] of filters) {
        if (op !== "or") { out.push(col); continue; }
        for (const term of String(val).split(",").map((t) => t.trim()).filter(Boolean)) {
          const firstDot = term.indexOf(".");
          if (firstDot > 0) out.push(term.slice(0, firstDot));
        }
      }
      if (orderCol) out.push(orderCol);
      return out;
    };

    const run = (): any => {
      const err = db.readErrors[table];
      if (err) return { data: null, error: err, count: null };

      const absent = db.missingColumns[table] ?? [];
      const named = namedColumns().find((c) => absent.includes(c));
      if (named) {
        return {
          data: null,
          count: null,
          error: { code: "42703", message: `column ${table}.${named} does not exist` },
        };
      }

      if (mode === "select") {
        const rows = selected();
        if (countMode) return { data: headMode ? null : rows, error: null, count: rows.length };
        return { data: rows.map((r) => ({ ...r })), error: null, count: null };
      }
      if (mode === "update") {
        const hit = db.rows(table).filter((r) => matches(r, filters));
        for (const r of hit) Object.assign(r, patch);
        return { data: hit.map((r) => ({ ...r })), error: null, count: null };
      }
      if (mode === "delete") {
        const keep = db.rows(table).filter((r) => !matches(r, filters));
        const removed = db.rows(table).length - keep.length;
        db.tables[table] = keep;
        return { data: null, error: null, count: removed };
      }
      // upsert
      const key = upsertOpts.onConflict ?? "id";
      for (const r of upsertRows) {
        const existing = db.rows(table).find((x) => x[key] === r[key]);
        if (existing) {
          if (!upsertOpts.ignoreDuplicates) Object.assign(existing, r);
        } else {
          db.rows(table).push({ ...r });
        }
      }
      return { data: null, error: null, count: null };
    };

    const builder: any = {
      select(_cols?: string, opts?: any) {
        if (mode !== "update" && mode !== "delete" && mode !== "upsert") mode = "select";
        if (opts?.count) countMode = true;
        if (opts?.head) headMode = true;
        return builder;
      },
      update(p: Row) { mode = "update"; patch = p; return builder; },
      delete() { mode = "delete"; return builder; },
      upsert(rows: Row | Row[], opts: any = {}) {
        mode = "upsert";
        upsertRows = Array.isArray(rows) ? rows : [rows];
        upsertOpts = opts;
        return builder;
      },
      eq(c: string, v: any) { filters.push([c, "eq", v]); return builder; },
      in(c: string, v: any[]) { filters.push([c, "in", v]); return builder; },
      is(c: string, v: any) { filters.push([c, v === null ? "isNull" : "eq", v]); return builder; },
      not(c: string, op: string, v: any) {
        if (op === "is" && v === null) filters.push([c, "notNull", null]);
        else throw new Error(`fake db: unsupported not(${op})`);
        return builder;
      },
      or(expr: string) { filters.push(["", "or", expr]); return builder; },
      lt(c: string, v: any) { filters.push([c, "lt", v]); return builder; },
      lte(c: string, v: any) { filters.push([c, "lte", v]); return builder; },
      gt(c: string, v: any) { filters.push([c, "gt", v]); return builder; },
      order(c: string, o: any = {}) { orderCol = c; orderAsc = o.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() {
        const r = run();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const rows = (r.data ?? []) as Row[];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    return builder;
  };

  return {
    from,
    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            if (db.removeError) return { data: null, error: db.removeError };
            if (!db.removeIsALie) for (const p of paths) db.objects(bucket).delete(p);
            return { data: paths.map((p) => ({ name: p })), error: null };
          },
          async list(dir: string, opts: any = {}) {
            const prefix = dir ? `${dir}/` : "";
            const names = [...db.objects(bucket)]
              .filter((p) => p.startsWith(prefix))
              .map((p) => p.slice(prefix.length))
              .filter((n) => !n.includes("/"))
              .filter((n) => (opts.search ? n.startsWith(opts.search) : true));
            return { data: names.map((name) => ({ name })), error: null };
          },
        };
      },
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

const OWNER = "11111111-1111-1111-1111-111111111111";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function storyPath(id: string) { return `stories/${OWNER}/${id}.jpg`; }
function storyUrl(id: string) { return `post-media/${storyPath(id)}`; }

function seedStory(db: FakeDb, id: string, over: Row = {}): Row {
  const row: Row = {
    id,
    owner_id: OWNER,
    media_url: storyUrl(id),
    state: "expired",
    expires_at: iso(NOW - 400 * DAY),
    deleted_at: null,
    saved_to_highlight_id: null,
    ...over,
  };
  db.rows("stories").push(row);
  db.objects("post-media").add(storyPath(id));
  return row;
}

function freshDb(): FakeDb {
  const db = new FakeDb();
  db.tables.stories = [];
  db.tables.story_purge_queue = [];
  db.tables.highlights = [];
  db.tables.memory_items = [];
  db.tables.passport_memories = [];
  db.tables.story_views = [];
  db.tables.story_reactions = [];
  db.tables.story_replies = [];
  db.tables.job_health = [];
  return db;
}

const CFG = { archiveRetentionDays: 365, deletedRecoveryDays: 30, engagementRetentionDays: 30, divergences: [] };

// ═══════════════════════════════════════════════════════════════════════════

describe("retention policy configuration", () => {
  it("enforces the published windows when the environment says nothing", () => {
    const cfg = resolveStoryRetentionConfig({});
    assert.equal(cfg.archiveRetentionDays, PUBLISHED_STORY_RETENTION.archiveRetentionDays);
    assert.equal(cfg.deletedRecoveryDays, PUBLISHED_STORY_RETENTION.deletedRecoveryDays);
    assert.equal(cfg.engagementRetentionDays, PUBLISHED_STORY_RETENTION.engagementRetentionDays);
    assert.deepEqual(cfg.divergences, [], "a default configuration diverges from nothing");
  });

  it("ignores an unparseable override and says so, rather than coercing it", () => {
    const cfg = resolveStoryRetentionConfig({ STORY_ARCHIVE_RETENTION_DAYS: "thirty" });
    assert.equal(cfg.archiveRetentionDays, 365, "a typo must not become a retention window");
    assert.equal(cfg.divergences.length, 1);
    assert.equal(cfg.divergences[0].reason, "unparseable");
  });

  it("refuses a valid override that nobody acknowledged", () => {
    const cfg = resolveStoryRetentionConfig({ STORY_ARCHIVE_RETENTION_DAYS: "30" });
    assert.equal(cfg.archiveRetentionDays, 365, "the published promise wins without an acknowledgement");
    assert.equal(cfg.divergences[0].reason, "override_refused_no_ack");
  });

  it("honours an acknowledged override and records that the policy text is now stale", () => {
    const cfg = resolveStoryRetentionConfig({
      STORY_ARCHIVE_RETENTION_DAYS: "30",
      STORY_RETENTION_POLICY_ACK: POLICY_ACK_TOKEN,
    });
    assert.equal(cfg.archiveRetentionDays, 30);
    assert.equal(cfg.divergences[0].reason, "override_accepted");
  });

  it("refuses zero and negative windows even with an acknowledgement", () => {
    for (const bad of ["0", "-1", "3.5"]) {
      const cfg = resolveStoryRetentionConfig({
        STORY_DELETED_RECOVERY_DAYS: bad,
        STORY_RETENTION_POLICY_ACK: POLICY_ACK_TOKEN,
      });
      assert.equal(cfg.deletedRecoveryDays, 30, `"${bad}" must not become a recovery window`);
      assert.equal(cfg.divergences[0].reason, "unparseable");
    }
  });
});

describe("what the purge selects", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); });

  it("enqueues an expired story past 365 days and leaves one inside the window alone", async () => {
    seedStory(db, "old", { expires_at: iso(NOW - 366 * DAY) });
    seedStory(db, "recent", { expires_at: iso(NOW - 364 * DAY) });

    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const queued = db.rows("story_purge_queue").map((r) => r.story_id).sort();
    assert.deepEqual(queued, ["old"], "only the story past its archive window is queued");
  });

  it("never queues a story saved to a Highlight, however old", async () => {
    seedStory(db, "saved", { expires_at: iso(NOW - 900 * DAY), saved_to_highlight_id: "h-1", state: "saved" });
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    assert.equal(db.rows("story_purge_queue").length, 0, "a Highlight owns those bytes, not the archive");
  });

  it("never queues a moderator-removed story", async () => {
    seedStory(db, "removed", { state: "removed", expires_at: iso(NOW - 900 * DAY) });
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    assert.equal(db.rows("story_purge_queue").length, 0, "moderation records are retained, per the privacy policy");
  });

  it("queues an owner-deleted story only after its 30-day recovery window", async () => {
    seedStory(db, "justDeleted", { state: "deleted", deleted_at: iso(NOW - 29 * DAY), expires_at: iso(NOW - 40 * DAY) });
    seedStory(db, "lapsed", { state: "deleted", deleted_at: iso(NOW - 31 * DAY), expires_at: iso(NOW - 40 * DAY) });

    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const queued = db.rows("story_purge_queue").map((r) => r.story_id).sort();
    assert.deepEqual(queued, ["lapsed"], "a story still inside its recovery window is recoverable, so it stays");
  });

  it("queues a deleted story whose archive deadline passed, even though it was deleted yesterday", async () => {
    // Expired 400 days ago, deleted yesterday. Counting only from `deleted_at`
    // would hold it another 29 days — so deleting a story would be a way to
    // keep it LONGER than leaving it alone, and a delete/recover/delete cycle
    // would hold it forever. The recovery window is capped at the archive
    // deadline the story already had.
    seedStory(db, "pastArchiveCap", {
      state: "deleted",
      deleted_at: iso(NOW - 1 * DAY),
      expires_at: iso(NOW - 400 * DAY),
    });
    // The control: same fresh deletion, but well inside its archive deadline.
    // It must stay, or the cap has swallowed the ordinary recovery window.
    seedStory(db, "insideArchive", {
      state: "deleted",
      deleted_at: iso(NOW - 1 * DAY),
      expires_at: iso(NOW - 40 * DAY),
    });

    await enqueueDueStories(sc, CFG as any, NOW, 100);

    assert.deepEqual(
      db.rows("story_purge_queue").map((r) => r.story_id).sort(),
      ["pastArchiveCap"],
      "the cap must bind past the archive deadline and nowhere else",
    );
  });

  it("queues by the clock, not by the state flag, so an unswept story still ages out", async () => {
    // state='active' past its expiry: the row never got flipped because nothing
    // flipped it. Keying retention on the flag would retain it forever.
    seedStory(db, "unswept", { state: "active", expires_at: iso(NOW - 400 * DAY) });
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    assert.deepEqual(db.rows("story_purge_queue").map((r) => r.story_id), ["unswept"]);
  });

  it("throws rather than reporting an empty archive when the table cannot be read", async () => {
    db.readErrors.stories = { code: "57014", message: "canceling statement due to statement timeout" };
    await assert.rejects(() => enqueueDueStories(sc, CFG as any, NOW, 100));
  });
});

describe("the ledger is written before anything is destroyed", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); });

  it("captures the storage path while the story still exists", async () => {
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const entry = db.rows("story_purge_queue")[0];
    assert.equal(entry.storage_bucket, "post-media");
    assert.equal(entry.storage_path, storyPath("s1"));
    assert.equal(db.rows("stories").length, 1, "enqueueing destroys nothing");
    assert.ok(db.objects("post-media").has(storyPath("s1")), "the object is untouched at enqueue time");
  });

  it("does not reset a retrying entry's backoff when the story is seen again", async () => {
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    const entry = db.rows("story_purge_queue")[0];
    entry.attempts = 4;
    entry.next_attempt_at = iso(NOW + 4 * 60 * 60 * 1000);

    await enqueueDueStories(sc, CFG as any, NOW + 60_000, 100);

    const after = db.rows("story_purge_queue")[0];
    assert.equal(after.attempts, 4, "a re-enqueue must not restart a failing entry's backoff");
    assert.equal(db.rows("story_purge_queue").length, 1);
  });
});

describe("executing a purge", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); });

  it("deletes the object and the row, verifies both, and clears the ledger", async () => {
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.completed, 1);
    assert.equal(out.deferred, 0);
    assert.deepEqual(out.failures, []);
    assert.equal(db.rows("stories").length, 0, "the row is gone");
    assert.ok(!db.objects("post-media").has(storyPath("s1")), "the bytes are gone");
    assert.equal(db.rows("story_purge_queue").length, 0, "the ledger entry is settled and removed");
  });

  it("does NOT mark an object deleted when the read-back still finds it", async () => {
    // remove() resolves cleanly and changes nothing — the exact failure a
    // return-value check cannot see.
    db.removeIsALie = true;
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.completed, 0, "a lie must not be counted as a completed purge");
    assert.equal(out.deferred, 1);
    assert.equal(out.failures.length, 1);
    assert.match(out.failures[0], /still listed after remove/);
    const entry = db.rows("story_purge_queue")[0];
    assert.equal(entry.object_deleted_at, null, "nothing may claim the object was deleted");
    assert.equal(entry.row_deleted_at, null, "and the row must not be deleted on top of it");
    assert.equal(db.rows("stories").length, 1, "the archive entry survives so the bytes stay findable");
  });

  it("keeps the ledger entry and grows its backoff when storage rejects the delete", async () => {
    db.removeError = { message: "503 storage unavailable" };
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    await processPurgeQueue(sc, NOW, 100);

    const entry = db.rows("story_purge_queue")[0];
    assert.equal(entry.attempts, 1);
    assert.ok(Date.parse(entry.next_attempt_at) > NOW, "the retry is scheduled into the future");
    assert.match(entry.last_error, /503 storage unavailable/);
    assert.equal(db.rows("stories").length, 1);
  });

  it("resumes a half-finished purge without repeating the half it did", async () => {
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    // Simulate a crash after the object went but before the row did.
    db.objects("post-media").delete(storyPath("s1"));
    const entry = db.rows("story_purge_queue")[0];
    entry.object_deleted_at = iso(NOW - 60_000);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.completed, 1);
    assert.equal(db.rows("stories").length, 0);
    assert.equal(db.rows("story_purge_queue").length, 0);
  });
});

describe("the reference guard", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); });

  it("keeps the bytes when a Highlight still points at them, and still purges the story row", async () => {
    seedStory(db, "s1");
    db.rows("highlights").push({ id: "h1", owner_id: OWNER, media_url: storyUrl("s1") });
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.completed, 1);
    assert.equal(out.retained, 1);
    assert.ok(db.objects("post-media").has(storyPath("s1")), "a live Highlight's media must survive");
    assert.equal(db.rows("stories").length, 0, "the archive entry itself still ages out");
  });

  it("keeps the bytes for a Memory item and for a passport memory too", async () => {
    seedStory(db, "m1");
    seedStory(db, "p1");
    db.rows("memory_items").push({ id: "mi", media_url: storyUrl("m1") });
    db.rows("passport_memories").push({ id: "pm", photo_url: storyUrl("p1") });
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.retained, 2);
    assert.ok(db.objects("post-media").has(storyPath("m1")));
    assert.ok(db.objects("post-media").has(storyPath("p1")));
  });

  it("FAILS CLOSED: an unreadable highlights table keeps the bytes rather than guessing", async () => {
    seedStory(db, "s1");
    await enqueueDueStories(sc, CFG as any, NOW, 100);
    db.readErrors.highlights = { code: "57014", message: "statement timeout" };

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.ok(db.objects("post-media").has(storyPath("s1")), "an outage must never authorise a permanent delete");
    assert.equal(out.retained + out.deferred, 1);
    const surviving = db.rows("story_purge_queue")[0];
    if (surviving) assert.match(String(surviving.object_retained_reason ?? ""), /unreadable/);
  });

  it("treats a table that does not exist as an establishable absence of references", async () => {
    seedStory(db, "s1");
    db.readErrors.memory_items = { code: "42P01", message: 'relation "memory_items" does not exist' };
    await enqueueDueStories(sc, CFG as any, NOW, 100);

    const out = await processPurgeQueue(sc, NOW, 100);

    assert.equal(out.completed, 1);
    assert.equal(out.retained, 0, "a missing table holds no references — that is a result, not an outage");
    assert.ok(!db.objects("post-media").has(storyPath("s1")));
  });

  it("reports which table it could not read, rather than a bare boolean", async () => {
    db.readErrors.passport_memories = { code: "57014", message: "statement timeout" };
    const refs = await findSurvivingReferences(makeClient(db), [storyUrl("x")]);
    assert.match(refs.get(storyUrl("x"))!, /passport_memories\.photo_url unreadable/);
  });
});

describe("engagement purge", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); });

  it("purges viewers, reactions and replies at 30 days while the story itself stays", async () => {
    seedStory(db, "s1", { expires_at: iso(NOW - 31 * DAY) });
    db.rows("story_views").push({ story_id: "s1", viewer_id: "v1" });
    db.rows("story_reactions").push({ story_id: "s1", user_id: "v1", emoji: "🔥" });
    db.rows("story_replies").push({ id: "r1", story_id: "s1", user_id: "v1", message: "nice" });

    const out = await purgeExpiredEngagement(sc, CFG as any, NOW, 100);

    assert.deepEqual(out.failures, []);
    assert.equal(db.rows("story_views").length, 0);
    assert.equal(db.rows("story_reactions").length, 0);
    assert.equal(db.rows("story_replies").length, 0);
    assert.equal(db.rows("stories").length, 1, "the archive keeps the story for its full 365 days");
  });

  it("leaves engagement alone inside the 30-day window", async () => {
    seedStory(db, "s1", { expires_at: iso(NOW - 29 * DAY) });
    db.rows("story_views").push({ story_id: "s1", viewer_id: "v1" });

    await purgeExpiredEngagement(sc, CFG as any, NOW, 100);

    assert.equal(db.rows("story_views").length, 1);
  });

  it("reports a failure when rows survive the purge instead of counting it done", async () => {
    seedStory(db, "s1", { expires_at: iso(NOW - 31 * DAY) });
    db.rows("story_views").push({ story_id: "s1", viewer_id: "v1" });
    // A delete that resolves and changes nothing: the shape supabase-js gives
    // for a rejected statement.
    const sc2 = makeClient(db);
    const realFrom = sc2.from.bind(sc2);
    sc2.from = (t: string) => {
      const b = realFrom(t);
      if (t === "story_views") b.delete = () => ({ ...b, then: (r: any) => Promise.resolve({ error: null }).then(r) });
      return b;
    };

    const out = await purgeExpiredEngagement(sc2, CFG as any, NOW, 100);

    assert.ok(out.failures.some((f) => /story_views rows survived/.test(f)), `expected a survival failure, got ${JSON.stringify(out.failures)}`);
  });
});

describe("the scheduler never launders an attempt into health", () => {
  let db: FakeDb; let sc: any;
  beforeEach(() => { db = freshDb(); sc = makeClient(db); _resetStoryRetentionStatus(); });

  it("records a success only when the pass had no failures at all", async () => {
    seedStory(db, "s1");
    await runStoryRetentionTick(sc);

    const st = getStoryRetentionStatus();
    assert.ok(st.lastAttemptAt, "the attempt is recorded");
    assert.ok(st.lastSuccessAt, "and so is the success");
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(db.rows("job_health")[0].last_success_at, st.lastSuccessAt);
  });

  it("records the attempt but NOT a success when the archive cannot be read", async () => {
    db.readErrors.stories = { code: "57014", message: "statement timeout" };

    await runStoryRetentionTick(sc);

    const st = getStoryRetentionStatus();
    assert.ok(st.lastAttemptAt, "the attempt happened and is visible");
    assert.equal(st.lastSuccessAt, null, "a pass that could not look is not a success");
    assert.equal(st.consecutiveFailures, 1);
    assert.ok(st.lastFailures.length > 0, "and it reports the failure rather than zero work");
    assert.equal(db.rows("job_health")[0].last_success_at, undefined, "no success is persisted");
  });

  it("counts a configuration divergence as a failed pass, not a quiet substitution", async () => {
    seedStory(db, "s1");
    await runStoryRetentionTick(sc);
    _resetStoryRetentionStatus();

    const db2 = freshDb();
    seedStory(db2, "s1");
    const sc2 = makeClient(db2);
    const prev = process.env.STORY_ARCHIVE_RETENTION_DAYS;
    process.env.STORY_ARCHIVE_RETENTION_DAYS = "30";
    try {
      await runStoryRetentionTick(sc2);
    } finally {
      if (prev === undefined) delete process.env.STORY_ARCHIVE_RETENTION_DAYS;
      else process.env.STORY_ARCHIVE_RETENTION_DAYS = prev;
    }

    const st = getStoryRetentionStatus();
    assert.equal(st.lastSuccessAt, null, "an ignored override must not pass silently");
    assert.ok(st.lastFailures.some((f) => /STORY_ARCHIVE_RETENTION_DAYS/.test(f)));
  });
});

describe("one full pass", () => {
  it("reports every number an operator needs and destroys exactly what it should", async () => {
    const db = freshDb();
    const sc = makeClient(db);
    seedStory(db, "purgeMe");
    seedStory(db, "keepBytes");
    db.rows("highlights").push({ id: "h", media_url: storyUrl("keepBytes") });
    seedStory(db, "tooYoung", { expires_at: iso(NOW - 10 * DAY) });
    db.rows("story_views").push({ story_id: "purgeMe", viewer_id: "v" });

    const report = await runStoryRetention(sc, { now: NOW });

    assert.deepEqual(report.failures, []);
    assert.equal(report.enqueuedArchive, 2);
    assert.equal(report.completed, 2);
    assert.equal(report.retained, 1);
    assert.equal(report.backlog, 0);
    assert.deepEqual(db.rows("stories").map((r) => r.id), ["tooYoung"], "only the young story survives");
    assert.ok(!db.objects("post-media").has(storyPath("purgeMe")), "unreferenced bytes go");
    assert.ok(db.objects("post-media").has(storyPath("keepBytes")), "referenced bytes stay");
    assert.ok(db.objects("post-media").has(storyPath("tooYoung")), "in-window bytes stay");
  });

  // The ORDER of the two calls inside runStoryRetention is load-bearing, and
  // nothing but the order enforces it. This is the state production is in right
  // now: 2998 is not applied there, so `stories.deleted_at` does not exist.
  //
  // enqueueDueStories runs first and its second query names that column, so
  // PostgREST answers 42703 and the pass throws before purgeExpiredEngagement
  // is reached. Nothing is deleted. That is exactly why index.ts is allowed to
  // start this scheduler on a deployment whose database has not had 2998.
  //
  // The surviving rows are the assertion, not the rejection. The engagement
  // purge selects stories on `expires_at` alone, which still WORKS on such a
  // database — so if it ran first it would delete viewers, reactions and
  // replies with no purge ledger behind them, and runStoryRetention would still
  // reject afterwards. Asserting only the rejection would pass either way.
  // Mutation-tested by swapping the two calls: this case then fails on all
  // three counts, and with `readErrors.stories` instead of `missingColumns` it
  // did NOT — which is how the weaker first version of this test was caught.
  it("aborts before deleting any engagement row when deleted_at is not in the database", async () => {
    const db = freshDb();
    const sc = makeClient(db);
    seedStory(db, "old");
    db.rows("story_views").push({ story_id: "old", viewer_id: "v" });
    db.rows("story_reactions").push({ story_id: "old", user_id: "v" });
    db.rows("story_replies").push({ story_id: "old", user_id: "v", message: "hi" });

    db.missingColumns.stories = ["deleted_at"];

    // supabase-js hands back a plain object, not an Error, so match on its
    // fields rather than a message regex — and on the CODE, so this case cannot
    // pass on some unrelated rejection.
    await assert.rejects(
      () => runStoryRetention(sc, { now: NOW }),
      (err: any) => err?.code === "42703" && String(err?.message).includes("deleted_at"),
    );

    assert.equal(db.rows("story_views").length, 1, "viewers survive a database without 2998");
    assert.equal(db.rows("story_reactions").length, 1, "reactions survive a database without 2998");
    assert.equal(db.rows("story_replies").length, 1, "replies survive a database without 2998");
  });
});

describe("storage path splitting", () => {
  it("lists the directory, not the object — a full path returns an empty listing", () => {
    assert.deepEqual(splitStoragePath("stories/uid/abc.jpg"), { dir: "stories/uid", base: "abc.jpg" });
    assert.deepEqual(splitStoragePath("flat.jpg"), { dir: "", base: "flat.jpg" });
  });
});
