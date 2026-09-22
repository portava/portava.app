/**
 * Story archive — the recovery flow and the dates the archive shows.
 *
 * WHAT IS PINNED, AND THE TRAP EACH ONE GUARDS
 * --------------------------------------------
 *   - Recovery restores to `expired`, never to `active`. Trap: an undo button
 *     that re-publishes a weeks-old Story into other people's feeds. The test
 *     asserts `expires_at` is untouched, because that is what every
 *     audience-facing predicate reads.
 *   - Recovery after the window answers 410 and changes nothing. Trap: a 200
 *     for a Story the hourly purge deletes twenty minutes later.
 *   - A non-owner gets `not_found`, the same answer as for a Story that does
 *     not exist. Trap: using recovery as an oracle for other people's deletions.
 *   - An update that matches ZERO rows is a failure, not a success. Trap:
 *     supabase-js errors nothing when an update matches nothing, so a
 *     concurrent purge would otherwise get a cheerful 200.
 *   - A recovered row that still carries `deleted_at` is a failure. Trap: the
 *     route trusting migration 2998's trigger to exist. If the migration is not
 *     applied, the clock keeps running on a "recovered" Story and the purge
 *     takes it — so the route checks the state it actually got back.
 *   - `/stories/retention-policy` is REACHABLE through the composed router.
 *     Trap: `/stories/:id` capturing it and answering "invalid story id",
 *     which is exactly what happens if the routers are registered the other
 *     way round.
 *
 * Every assertion is about the row that exists afterwards, or about an exact
 * status code — never `!== 200`, which a 404 from an unmounted route satisfies
 * just as well as a considered refusal.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/storyArchiveRecovery.test.ts
 */
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Express } from "express";

import apiRouter from "../routes/index.js";
import { retentionDatesFor } from "../routes/storyArchive.js";
import { _setTestClient } from "../lib/http.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";
const STORY = "aaaaaaaa-1111-2222-3333-444444444444";
const DAY = 24 * 60 * 60 * 1000;
const CFG = { archiveRetentionDays: 365, deletedRecoveryDays: 30, engagementRetentionDays: 30 };

// ── a stories table double that applies the filters the route relies on ──────

interface Store {
  /** Every stories row this fake holds. `row` is the first, for the single-row cases. */
  rows: any[];
  readError: any | null;
  /** Set true to make the update match nothing, as a concurrent purge would. */
  updateMatchesNothing: boolean;
  /** Set true to simulate migration 2998 NOT being applied: deleted_at survives. */
  triggerMissing: boolean;
  updates: any[];
}

function client(store: Store): any {
  return {
    from(table: string) {
      // requireUser's ban gate reads profiles.account_status on EVERY
      // authenticated request and refuses with 503 when it cannot. Answering it
      // here keeps this suite about the recovery route; leaving it out makes
      // every case fail identically for a reason that has nothing to do with
      // the thing under test.
      if (table === "profiles") {
        const b: any = {
          select() { return b; },
          eq() { return b; },
          maybeSingle() { return Promise.resolve({ data: { account_status: "active" }, error: null }); },
          then(res: any, rej: any) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
        };
        return b;
      }
      if (table !== "stories") throw new Error(`unexpected table ${table}`);
      // The filters are APPLIED, not recorded. A fake that ignores `.in("state",
      // ...)` would let the archive listing return deleted stories and the test
      // would still pass — which is the one thing these listings must not do.
      const filters: Array<(r: any) => boolean> = [];
      let patch: any = null;
      let mode: "select" | "update" = "select";
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN = Infinity;
      const matched = () => {
        let out = store.rows.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const c = orderCol;
          out = [...out].sort((a, z) => {
            const av = String(a[c] ?? ""); const zv = String(z[c] ?? "");
            return orderAsc ? (av < zv ? -1 : av > zv ? 1 : 0) : (av > zv ? -1 : av < zv ? 1 : 0);
          });
        }
        return out.slice(0, limitN);
      };
      const b: any = {
        select() { return b; },
        update(p: any) { mode = "update"; patch = p; return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        in(c: string, vals: any[]) { filters.push((r) => vals.includes(r[c])); return b; },
        not(c: string, op: string, v: any) {
          if (op === "is" && v === null) filters.push((r) => r[c] !== null && r[c] !== undefined);
          else throw new Error(`fake: unsupported not(${op})`);
          return b;
        },
        order(c: string, o: any = {}) { orderCol = c; orderAsc = o.ascending !== false; return b; },
        limit(n: number) { limitN = n; return b; },
        maybeSingle() {
          if (store.readError) return Promise.resolve({ data: null, error: store.readError });
          const hit = matched()[0] ?? null;
          return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
        },
        then(res: any, rej: any) {
          if (store.readError) return Promise.resolve({ data: null, error: store.readError }).then(res, rej);
          if (mode === "update") {
            store.updates.push(patch);
            const target = store.updateMatchesNothing ? null : (matched()[0] ?? null);
            if (!target) return Promise.resolve({ data: [], error: null }).then(res, rej);
            Object.assign(target, patch);
            // migration 2998's trigger clears deleted_at on the way out of
            // 'deleted'. The fake does it too, unless the test is asking what
            // happens when the migration is absent.
            if (!store.triggerMissing && target.state !== "deleted") target.deleted_at = null;
            return Promise.resolve({ data: [{ ...target }], error: null }).then(res, rej);
          }
          return Promise.resolve({ data: matched().map((r) => ({ ...r })), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

// ── a server, with auth stubbed to a chosen caller ──────────────────────────

let server: http.Server;
let base = "";
let caller = OWNER;

before(async () => {
  const app: Express = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    // requireUser reads the bearer token through supabase auth; stubbing the
    // header the same way the other route suites do keeps this about the route.
    req.headers.authorization = `Bearer test-${caller}`;
    next();
  });
  app.use("/api", apiRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

// The auth seam: requireUser is driven by the service client's auth.getUser.
function withAuth(sc: any) {
  sc.auth = {
    async getUser(token: string) {
      const id = String(token).replace(/^test-/, "");
      return { data: { user: { id } }, error: null };
    },
  };
  return sc;
}

async function post(path: string) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function deletedStory(deletedDaysAgo: number) {
  return {
    id: STORY,
    owner_id: OWNER,
    state: "deleted",
    expires_at: new Date(Date.now() - 100 * DAY).toISOString(),
    deleted_at: new Date(Date.now() - deletedDaysAgo * DAY).toISOString(),
    saved_to_highlight_id: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("retentionDatesFor", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");

  it("dates an archived story from its expiry, not from its creation", () => {
    const d = retentionDatesFor(
      { state: "expired", expires_at: new Date(now - 10 * DAY).toISOString(), deleted_at: null },
      CFG, now,
    );
    assert.equal(d.purgeAt, new Date(now - 10 * DAY + 365 * DAY).toISOString());
    assert.equal(d.engagementPurgeAt, new Date(now - 10 * DAY + 30 * DAY).toISOString());
    assert.equal(d.recoverableUntil, null, "an expired story was never deleted");
    assert.equal(d.recoverable, false);
  });

  it("dates a deleted story from deleted_at, and says it is recoverable", () => {
    const d = retentionDatesFor(deletedStory(5), CFG, Date.now());
    assert.equal(d.recoverable, true);
    assert.ok(d.recoverableUntil);
    assert.equal(d.purgeAt, d.recoverableUntil, "a deleted story's purge date IS the end of its window");
  });

  it("says a story deleted 31 days ago is no longer recoverable", () => {
    const d = retentionDatesFor(deletedStory(31), CFG, Date.now());
    assert.equal(d.recoverable, false);
  });

  // ── how recovery affects the purge date ──────────────────────────────────
  // The owner asked for this to be specified and tested, 2026-09-22:
  // "Specify and test how recovery affects its eventual purge date, including
  // repeated delete/recover cycles and stories already past their normal
  // retention deadline."

  it("does not restart the archive clock when a story is recovered", () => {
    // Deleted 5 days ago, expired 100 days ago. Recovery puts it back in the
    // archive; its purge date is the one it always had — expiry + 365 — not
    // 365 days from the recovery.
    const expiresAt = new Date(now - 100 * DAY).toISOString();
    const recovered = retentionDatesFor({ state: "expired", expires_at: expiresAt, deleted_at: null }, CFG, now);
    assert.equal(
      recovered.purgeAt,
      new Date(now - 100 * DAY + 365 * DAY).toISOString(),
      "recovery must not buy the story a fresh 365 days",
    );
    assert.equal(recovered.recoverableUntil, null);
  });

  it("says so when recovering a story would restore it straight into the next purge", () => {
    // Expired 400 days ago: past the 365-day archive deadline. The owner can
    // still recover it — the recovery window has not closed — but what comes
    // back is due immediately, and a bare "restored" would stop being true
    // within the hour.
    const d = retentionDatesFor(
      {
        state: "deleted",
        expires_at: new Date(now - 400 * DAY).toISOString(),
        deleted_at: new Date(now - 1 * DAY).toISOString(),
      },
      CFG, now,
    );
    assert.equal(d.purgeImminent, true, "a story past its archive deadline must not be restored silently");
  });

  it("does not claim a purge is imminent for a story well inside its archive", () => {
    const d = retentionDatesFor(deletedStory(1), CFG, Date.now());
    assert.equal(d.purgeImminent, false);
  });

  it("caps the recovery window at the archive deadline rather than extending past it", () => {
    // Expired 360 days ago, deleted today. 30 days from `deleted_at` would run
    // to day 390 — 25 days past the archive deadline this story already had.
    // Deleting is a request to remove something SOONER; it must not be a way to
    // keep it longer than leaving it alone would have.
    const d = retentionDatesFor(
      {
        state: "deleted",
        expires_at: new Date(now - 360 * DAY).toISOString(),
        deleted_at: new Date(now).toISOString(),
      },
      CFG, now,
    );
    const archiveDeadline = new Date(now - 360 * DAY + 365 * DAY).toISOString();
    assert.equal(d.recoverableUntil, archiveDeadline, "the window must end at the archive deadline");
    assert.equal(d.purgeAt, archiveDeadline);
    assert.ok(
      Date.parse(d.recoverableUntil!) < now + 30 * DAY,
      "the window must be SHORTER than the nominal 30 days here, and the archive shows the real date",
    );
  });

  it("gives the full recovery window when the archive deadline is far away", () => {
    // Expired yesterday, deleted today: the cap is 364 days out, so the 30-day
    // window applies untouched. The cap must not shorten the ordinary case.
    const d = retentionDatesFor(
      {
        state: "deleted",
        expires_at: new Date(now - 1 * DAY).toISOString(),
        deleted_at: new Date(now).toISOString(),
      },
      CFG, now,
    );
    assert.equal(d.recoverableUntil, new Date(now + 30 * DAY).toISOString());
  });

  it("cannot be held open indefinitely by repeating delete and recover", () => {
    // Each cycle sets a FRESH deleted_at — the 2998 trigger only refuses to
    // move it while the row stays deleted, which is the repeat-delete case the
    // owner's decision names. Without the archive cap, a caller cycling
    // delete/recover/delete every 29 days would renew the window forever.
    // With it, the end date can only move toward a fixed point.
    const expiresAt = new Date(now - 300 * DAY).toISOString();
    const archiveDeadline = now - 300 * DAY + 365 * DAY;

    let last = Infinity;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // 10 days pass between cycles; each delete stamps deleted_at afresh.
      const at = now + cycle * 10 * DAY;
      const d = retentionDatesFor(
        { state: "deleted", expires_at: expiresAt, deleted_at: new Date(at).toISOString() },
        CFG, at,
      );
      const endsAt = Date.parse(d.recoverableUntil!);
      assert.ok(
        endsAt <= archiveDeadline,
        `cycle ${cycle}: window ends ${new Date(endsAt).toISOString()}, past the archive deadline ${new Date(archiveDeadline).toISOString()}`,
      );
      // Once the cap binds, further cycles cannot push it out again.
      if (last !== Infinity) assert.ok(endsAt <= last + 10 * DAY, `cycle ${cycle}: the window grew`);
      last = endsAt;
    }
    assert.equal(last, archiveDeadline, "the last cycles must all land on the fixed archive deadline");
  });

  it("promises no purge date for a story whose media belongs to a Highlight", () => {
    const d = retentionDatesFor(
      { state: "saved", expires_at: new Date(now - 400 * DAY).toISOString(), saved_to_highlight_id: "h1" },
      CFG, now,
    );
    assert.equal(d.purgeAt, null, "this job never queues it, so naming a date would be a promise it does not keep");
  });

  it("promises no purge date for a moderator-removed story", () => {
    const d = retentionDatesFor({ state: "removed", expires_at: new Date(now - 400 * DAY).toISOString() }, CFG, now);
    assert.equal(d.purgeAt, null);
  });
});

describe("GET /stories/retention-policy", () => {
  beforeEach(() => { caller = OWNER; _setTestClient(withAuth(client({ row: null, readError: null, updateMatchesNothing: false, triggerMissing: false, updates: [] })), true); });

  it("is reachable through the composed router and is not captured by /stories/:id", async () => {
    const res = await get("/api/stories/retention-policy");
    assert.equal(res.status, 200, "a 400 here means /stories/:id captured the path");
    assert.equal(res.body.effective.archiveRetentionDays, 365);
    assert.equal(res.body.effective.audienceWindowHours, 24);
    assert.equal(res.body.effective.deletedRecoveryDays, 30);
    assert.deepEqual(res.body.divergences, [], "a default deployment diverges from nothing");
  });
});

describe("GET /stories/archive", () => {
  let store: Store;
  beforeEach(() => {
    store = {
      rows: [
        { id: "s-exp", owner_id: OWNER, state: "expired", expires_at: new Date(Date.now() - 3 * DAY).toISOString(), deleted_at: null, saved_to_highlight_id: null },
        { id: "s-sav", owner_id: OWNER, state: "saved", expires_at: new Date(Date.now() - 9 * DAY).toISOString(), deleted_at: null, saved_to_highlight_id: "h1" },
        { id: "s-del", owner_id: OWNER, state: "deleted", expires_at: new Date(Date.now() - 5 * DAY).toISOString(), deleted_at: new Date(Date.now() - 1 * DAY).toISOString(), saved_to_highlight_id: null },
        { id: "s-act", owner_id: OWNER, state: "active", expires_at: new Date(Date.now() + 10 * 3600_000).toISOString(), deleted_at: null, saved_to_highlight_id: null },
        { id: "s-other", owner_id: STRANGER, state: "expired", expires_at: new Date(Date.now() - 2 * DAY).toISOString(), deleted_at: null, saved_to_highlight_id: null },
      ],
      readError: null, updateMatchesNothing: false, triggerMissing: false, updates: [],
    };
    caller = OWNER;
    _setTestClient(withAuth(client(store)), true);
  });

  it("lists the owner's expired and saved stories and nobody else's", async () => {
    const res = await get("/api/stories/archive");
    assert.equal(res.status, 200);
    const ids = res.body.stories.map((r: any) => r.id).sort();
    assert.deepEqual(ids, ["s-exp", "s-sav"]);
  });

  it("does not list a deleted story in the archive", async () => {
    // Decision 2: an owner-deleted story leaves normal access IMMEDIATELY. If
    // it still appeared here, "deleted" would be a label rather than a state.
    const res = await get("/api/stories/archive");
    assert.ok(!res.body.stories.some((r: any) => r.id === "s-del"), "a deleted story is not archive content");
  });

  it("does not list a story that is still up", async () => {
    const res = await get("/api/stories/archive");
    assert.ok(!res.body.stories.some((r: any) => r.id === "s-act"));
  });

  it("carries the retention dates, so the screen does not compute its own", async () => {
    const res = await get("/api/stories/archive");
    const exp = res.body.stories.find((r: any) => r.id === "s-exp");
    assert.ok(exp.retention, "every row must carry its dates");
    assert.equal(exp.retention.purgeAt, new Date(Date.parse(exp.expires_at) + 365 * DAY).toISOString());
    const saved = res.body.stories.find((r: any) => r.id === "s-sav");
    assert.equal(saved.retention.purgeAt, null, "a story whose media belongs to a Highlight has no purge date to promise");
  });

  it("does not report a failed read as an empty archive", async () => {
    store.readError = { code: "57014", message: "statement timeout" };
    const res = await get("/api/stories/archive");
    assert.equal(res.status, 500, "an outage must not render as 'you have no stories'");
  });
});

describe("GET /stories/archive/deleted", () => {
  let store: Store;
  beforeEach(() => {
    store = {
      rows: [
        { id: "d-fresh", owner_id: OWNER, state: "deleted", expires_at: new Date(Date.now() - 40 * DAY).toISOString(), deleted_at: new Date(Date.now() - 2 * DAY).toISOString(), saved_to_highlight_id: null },
        { id: "d-lapsed", owner_id: OWNER, state: "deleted", expires_at: new Date(Date.now() - 80 * DAY).toISOString(), deleted_at: new Date(Date.now() - 31 * DAY).toISOString(), saved_to_highlight_id: null },
        { id: "d-past-cap", owner_id: OWNER, state: "deleted", expires_at: new Date(Date.now() - 400 * DAY).toISOString(), deleted_at: new Date(Date.now() - 1 * DAY).toISOString(), saved_to_highlight_id: null },
        { id: "d-other", owner_id: STRANGER, state: "deleted", expires_at: new Date(Date.now() - 10 * DAY).toISOString(), deleted_at: new Date(Date.now() - 1 * DAY).toISOString(), saved_to_highlight_id: null },
        { id: "s-exp", owner_id: OWNER, state: "expired", expires_at: new Date(Date.now() - 3 * DAY).toISOString(), deleted_at: null, saved_to_highlight_id: null },
      ],
      readError: null, updateMatchesNothing: false, triggerMissing: false, updates: [],
    };
    caller = OWNER;
    _setTestClient(withAuth(client(store)), true);
  });

  it("offers only the deletions the recovery route would actually accept", async () => {
    // `d-lapsed` is past its 30 days; `d-past-cap` was deleted yesterday but its
    // archive deadline went by 35 days ago, so the capped window has closed
    // too. The rows survive until the hourly purge reaches them — showing them
    // would put a Recover button next to a story that answers 410.
    const res = await get("/api/stories/archive/deleted");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stories.map((r: any) => r.id), ["d-fresh"]);
  });

  it("shows nothing of anyone else's", async () => {
    const res = await get("/api/stories/archive/deleted");
    assert.ok(!res.body.stories.some((r: any) => r.id === "d-other"));
  });

  it("carries the date the window actually closes", async () => {
    const res = await get("/api/stories/archive/deleted");
    const row = res.body.stories[0];
    assert.equal(row.retention.recoverableUntil, new Date(Date.parse(row.deleted_at) + 30 * DAY).toISOString());
    assert.equal(row.retention.recoverable, true);
  });

  it("does not report a failed read as nothing to recover", async () => {
    store.readError = { code: "57014", message: "statement timeout" };
    const res = await get("/api/stories/archive/deleted");
    assert.equal(res.status, 500);
  });
});

describe("POST /stories/:id/repost", () => {
  let store: Store;
  const archived = () => ({
    id: STORY, owner_id: OWNER, state: "expired",
    expires_at: new Date(Date.now() - 30 * DAY).toISOString(),
    deleted_at: null, saved_to_highlight_id: null,
  });
  beforeEach(() => {
    store = { rows: [archived()], readError: null, updateMatchesNothing: false, triggerMissing: false, updates: [] };
    caller = OWNER;
    _setTestClient(withAuth(client(store)), true);
  });

  it("puts an archived story back up for a fresh 24 hours", async () => {
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.equal(res.status, 200);
    assert.equal(store.rows[0].state, "active");
    const remaining = Date.parse(store.rows[0].expires_at) - Date.now();
    assert.ok(remaining > 23 * 3600_000 && remaining <= 24 * 3600_000, `expected ~24h, got ${remaining}ms`);
  });

  it("restarts the archive clock, because this is a publication and not a rescue", async () => {
    const res = await post(`/api/stories/${STORY}/repost`);
    const purgeAt = Date.parse(res.body.retention.purgeAt);
    assert.ok(
      purgeAt > Date.now() + 364 * DAY,
      "a reposted story's archive runs from its NEW expiry, not the one it had a month ago",
    );
  });

  it("refuses to repost a deleted story, so recovery cannot be skipped", async () => {
    // Reposting a deleted story would re-publish it in one step, bypassing the
    // recovery flow and its window entirely.
    store.rows = [{ ...archived(), state: "deleted", deleted_at: new Date().toISOString() }];
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.equal(res.status, 400);
    assert.equal(store.rows[0].state, "deleted", "the row is untouched");
  });

  it("refuses to repost a moderator-removed story", async () => {
    store.rows = [{ ...archived(), state: "removed" }];
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.equal(res.status, 400);
    assert.equal(store.rows[0].state, "removed");
  });

  it("answers a non-owner with not_found, the same as for a story that does not exist", async () => {
    caller = STRANGER;
    _setTestClient(withAuth(client(store)), true);
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.equal(res.status, 404);
    assert.equal(store.rows[0].state, "expired", "a stranger's request changed nothing");
  });

  it("does not answer 200 when the update matched zero rows", async () => {
    store.updateMatchesNothing = true;
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.equal(res.status, 500, "a story that was not reposted must not be reported as reposted");
  });

  it("does not turn a table outage into a missing story", async () => {
    store.readError = { code: "57014", message: "statement timeout" };
    const res = await post(`/api/stories/${STORY}/repost`);
    assert.notEqual(res.status, 404);
    assert.equal(res.status, 500);
  });
});

describe("POST /stories/:id/recover", () => {
  let store: Store;
  beforeEach(() => {
    caller = OWNER;
    store = { rows: [deletedStory(5)], readError: null, updateMatchesNothing: false, triggerMissing: false, updates: [] };
    _setTestClient(withAuth(client(store)), true);
  });

  it("restores the story to the archive without re-publishing it", async () => {
    const before = store.rows[0].expires_at;
    const res = await post(`/api/stories/${STORY}/recover`);

    assert.equal(res.status, 200);
    assert.equal(store.rows[0].state, "expired", "recovered to the archive, NOT to active");
    assert.equal(store.rows[0].expires_at, before, "expires_at is untouched, so the audience is not re-served");
    assert.equal(store.rows[0].deleted_at, null, "the recovery clock stops");
    assert.equal(res.body.retention.recoverable, false, "it is no longer deleted, so nothing to recover");
  });

  it("writes state only, leaving deleted_at to the database trigger", async () => {
    await post(`/api/stories/${STORY}/recover`);
    assert.deepEqual(store.updates, [{ state: "expired" }], "a second copy of the freeze rule here would be the weaker one");
  });

  it("refuses after the window with 410 and changes nothing", async () => {
    store.rows = [deletedStory(31)];
    const res = await post(`/api/stories/${STORY}/recover`);

    assert.equal(res.status, 410);
    assert.equal(res.body.error, "recovery_window_closed");
    assert.equal(store.rows[0].state, "deleted", "the row is untouched");
    assert.deepEqual(store.updates, [], "and no write was even attempted");
  });

  it("answers a non-owner with not_found, the same as for a story that does not exist", async () => {
    caller = STRANGER;
    const present = await post(`/api/stories/${STORY}/recover`);
    store.rows = [];
    const absent = await post(`/api/stories/${STORY}/recover`);

    assert.equal(present.status, absent.status, "a stranger cannot tell the two apart");
    assert.equal(present.status, 404);
    assert.deepEqual(store.updates, []);
  });

  it("refuses to recover a story that was never deleted", async () => {
    store.rows = [{ ...deletedStory(5), state: "expired", deleted_at: null }];
    const res = await post(`/api/stories/${STORY}/recover`);
    assert.equal(res.status, 400);
    assert.deepEqual(store.updates, []);
  });

  it("does not answer 200 when the update matched zero rows", async () => {
    // What a concurrent purge looks like from here: the pre-read saw the row,
    // the update matched nothing, and supabase-js errors nothing about it.
    store.updateMatchesNothing = true;
    const res = await post(`/api/stories/${STORY}/recover`);
    assert.equal(res.status, 500, "a story that was not recovered must not be reported as recovered");
  });

  it("refuses when the recovered row still carries deleted_at", async () => {
    // Migration 2998 not applied: nothing clears the clock, so the purge would
    // take this "recovered" story on its next pass.
    store.triggerMissing = true;
    const res = await post(`/api/stories/${STORY}/recover`);
    assert.equal(res.status, 500, "the route must not report a recovery the database did not complete");
  });

  it("does not turn a table outage into a missing story", async () => {
    store.readError = { code: "57014", message: "statement timeout" };
    const res = await post(`/api/stories/${STORY}/recover`);
    assert.notEqual(res.status, 404, "an outage is not an answer about the owner's content");
    assert.equal(res.status, 500);
  });
});
