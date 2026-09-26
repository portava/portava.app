/**
 * Telegraph §7 T80 — "Text edits retain an Edited marker AND version history."
 *
 * The marker half was already real: `PATCH /api/threads/:t/messages/:m` sets
 * `edited_at` and every reader surfaces it as `editedAt`. The census recorded
 * the other half as absent — "the update overwrites `body` in place and
 * `message_edits` does not exist in the schema".
 *
 * Half of that is now out of date. `message_edits` IS in the schema: migration
 * 2811 defines it (`message_id, editor_id, version, previous_body, edited_at`,
 * `UNIQUE (message_id, version)`, `version >= 1`) and its own table comment
 * ends "No writer today." This file is about the writer, and about the reader
 * that makes the writer observable.
 *
 * ── THE DEPLOYMENT FACT THAT SHAPES EVERY TEST BELOW ────────────────────────
 * Migration 2811 is NOT APPLIED to production. The runbook's D2 rehearsal ran
 * it on portava-ci inside `BEGIN; … ROLLBACK;`, so it passed and left nothing
 * behind, and the runbook's own absent-object tables still list `message_edits`
 * under "all absent". So the writer has to survive a deployment where its table
 * is not there — and it must survive it LOUDLY.
 *
 * That gives the three rules this file pins, in the order they matter:
 *
 *   1. A MISSING TABLE MUST NOT BECOME A SILENT SUCCESS. When `message_edits`
 *      is absent the edit still goes through — refusing to let anyone edit a
 *      message on production because a side table is unapplied would be a
 *      regression, not a fix — but the response says `recorded: false` and
 *      names why. The GET does NOT answer `{ versions: [] }`; an empty list is
 *      a claim that this message was never edited, and that claim is false.
 *      This is the silent-zero shape the standing rules name: a PostgREST
 *      refusal RESOLVES with `{data: null, error}`, so `?? []` would turn
 *      "I cannot see the history" into "there is no history".
 *
 *   2. A NON-SCHEMA FAILURE MUST NOT LOSE THE PRIOR VERSION. The history row is
 *      written BEFORE the body is overwritten, and if that write fails for any
 *      reason other than the table being absent the edit is REFUSED and `body`
 *      is left alone. The opposite order loses the old text for good the first
 *      time the insert fails. Ordering is the whole guarantee here, so there is
 *      a test that fails if the two writes are swapped.
 *
 *   3. HISTORY IS RE-AUTHORIZED AT READ TIME, like every other Telegraph read
 *      (§14.2 "read authorization is dynamic"). A previous body is message
 *      content: a non-member, a departed member, and a member whose §14.3
 *      window opens after the message was sent all get a refusal, not a list.
 *
 * ── HOW THIS WAS SEEN TO GO RED ─────────────────────────────────────────────
 * Written before the writer existed. On the unmodified tree the four
 * "records a version" tests failed on `recorded: false` / a 404 from the
 * missing GET route, and the ordering test failed because the body was
 * overwritten with no history row in sight. Mutations recorded in the lane
 * report; every one is a single-line change to `routes/messaging.ts` or
 * `services/telegraph/messageEdits.ts`.
 *
 * Run: node --import tsx/esm --test src/test/telegraphMessageEditHistory.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";
import {
  EDIT_HISTORY_UNAVAILABLE,
  isEditHistorySchemaAbsent,
  nextEditVersion,
  orderEditsNewestFirst,
} from "../services/telegraph/messageEdits.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "eeeeeeee-0000-4000-8000-00000000000e";
const M_MINE = "11110000-0000-4000-8000-00000000000a";
const M_DELETED = "11110000-0000-4000-8000-00000000000d";

const NOW = Date.now();
const mins = (n: number) => new Date(NOW + n * 60_000).toISOString();

// ── the pure half ────────────────────────────────────────────────────────────

describe("T80 — edit-history primitives", () => {
  it("numbers the FIRST edit 1, because version 1 is the first edit and not the original", () => {
    assert.equal(nextEditVersion([]), 1);
  });

  it("numbers from the highest version present, not from the row count", () => {
    // A gap must not hand back a version that is already taken: the table's
    // UNIQUE (message_id, version) would reject it and the edit would fail for
    // a reason that has nothing to do with the edit.
    assert.equal(nextEditVersion([{ version: 1 }, { version: 3 }]), 4);
    assert.equal(nextEditVersion([{ version: 2 }]), 3);
  });

  it("recognises an absent table, and does NOT mistake an ordinary failure for one", () => {
    assert.equal(isEditHistorySchemaAbsent({ code: "42P01" }), true);
    assert.equal(isEditHistorySchemaAbsent({ code: "PGRST205" }), true);
    // The distinction rule 2 rests on. A deadlock, a permission denial or a
    // constraint violation is NOT "the table is unapplied", and treating it as
    // one would let the body be overwritten with the old text unrecorded.
    assert.equal(isEditHistorySchemaAbsent({ code: "XX000" }), false);
    assert.equal(isEditHistorySchemaAbsent({ code: "40P01" }), false);
    assert.equal(isEditHistorySchemaAbsent({ code: "23505" }), false);
    assert.equal(isEditHistorySchemaAbsent(null), false);
  });

  it("orders versions newest first", () => {
    const out = orderEditsNewestFirst([
      { version: 1, previous_body: "first", editor_id: ALICE, edited_at: mins(-30) },
      { version: 3, previous_body: "third", editor_id: ALICE, edited_at: mins(-10) },
      { version: 2, previous_body: "second", editor_id: ALICE, edited_at: mins(-20) },
    ]);
    assert.deepEqual(out.map((v) => v.version), [3, 2, 1]);
    assert.equal(out[0].previousBody, "third");
  });

  it("names the deployment fact rather than shrugging", () => {
    assert.match(EDIT_HISTORY_UNAVAILABLE, /2811/);
    assert.match(EDIT_HISTORY_UNAVAILABLE, /message_edits/);
  });
});

// ── the HTTP half ────────────────────────────────────────────────────────────

interface State {
  /** Table whose every statement fails with this code. */
  failTable?: string;
  failCode?: string;
  /** Members of THREAD, as `message_thread_members` rows. */
  members?: Array<{ user_id: string; left_at: string | null; visible_from?: string | null }>;
  /** Seed rows for message_edits. */
  edits?: Array<Record<string, unknown>>;
  /** Fail only the `messages` UPDATE, to test the compensation path. */
  failMessageUpdate?: boolean;
  /**
   * Fail only the `message_edits` SELECT, leaving its INSERT working.
   *
   * This exists because a mutation would not otherwise land. Failing the whole
   * table hides the read guard behind the insert guard: with both statements
   * broken, deleting the read's `else if (existingEditsErr)` branch still ends
   * in a refusal, because the insert then fails the same way. Only a state
   * where the version number is unknowable but the write would succeed
   * separates them — and that is the genuinely dangerous case, since the route
   * would otherwise number the next version from an empty list and either
   * collide with an existing version or silently restart the history at 1.
   */
  failEditsReadOnly?: string;
  /**
   * Fail only the `message_edits` INSERT, leaving its SELECT working.
   *
   * The mirror of `failEditsReadOnly`, and needed for the same reason. Failing
   * the whole table hides the insert guard behind the read guard: the read
   * refuses first, so deleting the insert's refusal changes nothing. Only a
   * state where the version is known but cannot be written separates them, and
   * that is the case the ordering guarantee is actually about — the history
   * write is the last thing that can fail before `body` is overwritten.
   */
  failEditsInsertOnly?: string;
  /**
   * Seed `feature_flags` so `telegraph_history_bound_enabled` reads as on.
   *
   * This is TEST DATA, not a product change: no flag default moves and no
   * migration turns anything on. It exists because the §14.3 window branch on
   * the history read is unreachable while the bound is off — `visibleFromOf`
   * returns null and `withinWindow` admits everything — so a mutation that
   * deletes the window check cannot land against a flag-off fixture. Modelling
   * the row is the only way to exercise the branch at all.
   */
  historyBound?: boolean;
}

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function makeClient(state: State) {
  const db: Record<string, any[]> = {
    message_thread_members: (state.members ?? [
      { thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, last_read_at: null },
    ]).map((m) => ({ thread_id: THREAD, last_read_at: null, ...m })),
    messages: [
      {
        id: M_MINE,
        thread_id: THREAD,
        sender_id: ALICE,
        body: "the original text",
        deleted_at: null,
        edited_at: null,
        created_at: mins(-60),
      },
      {
        id: M_DELETED,
        thread_id: THREAD,
        sender_id: ALICE,
        body: "",
        deleted_at: mins(-5),
        edited_at: null,
        created_at: mins(-60),
      },
    ],
    message_edits: copy(state.edits ?? []),
    message_threads: [{ id: THREAD, is_e2ee: false, last_message_at: mins(-60) }],
    profiles: [{ id: ALICE, preferred_language: "en", preferred_message_language: "en" }],
    message_translations: [],
    feature_flags: state.historyBound
      ? [{ flag: "telegraph_history_bound_enabled", enabled: true }]
      : [],
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: any = null;
    let pendingInsert: any = null;
    let pendingDelete = false;

    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const err = () => {
      if (state.failTable === table) {
        return { message: `injected failure on ${table}`, code: state.failCode ?? "XX000" };
      }
      if (state.failMessageUpdate && table === "messages" && pendingUpdate) {
        return { message: "injected failure on the messages UPDATE", code: "XX000" };
      }
      if (state.failEditsReadOnly && table === "message_edits" && !pendingInsert && !pendingDelete && !pendingUpdate) {
        return { message: "injected failure on the message_edits SELECT", code: state.failEditsReadOnly };
      }
      if (state.failEditsInsertOnly && table === "message_edits" && pendingInsert) {
        return { message: "injected failure on the message_edits INSERT", code: state.failEditsInsertOnly };
      }
      return null;
    };

    const settle = () => {
      const e = err();
      if (e) return { data: null, error: e, count: null };
      if (pendingInsert) {
        const rows = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        // The real table has UNIQUE (message_id, version); a fake that does not
        // enforce it would let a version-numbering bug pass unnoticed.
        for (const r of rows) {
          if (
            table === "message_edits" &&
            (db[table] ?? []).some(
              (x) => x.message_id === r.message_id && x.version === r.version,
            )
          ) {
            return {
              data: null,
              error: { message: "duplicate key value violates message_edits_version_uniq", code: "23505" },
              count: null,
            };
          }
          (db[table] ??= []).push({ ...r });
        }
        return { data: copy(rows), error: null, count: null };
      }
      if (pendingDelete) {
        const hit = rowsNow();
        db[table] = (db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: copy(hit), error: null, count: null };
      }
      if (pendingUpdate) {
        const hit = rowsNow();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: copy(hit), error: null, count: null };
      }
      return { data: copy(rowsNow()), error: null, count: null };
    };

    const target: any = {
      select() { return proxy; },
      insert(payload: any) { pendingInsert = payload; return proxy; },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      delete() { pendingDelete = true; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gte(col: string, val: any) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      order() { return proxy; },
      limit() { return proxy; },
      maybeSingle() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : ((s.data as any[]) ?? [])[0] ?? null, error: s.error });
      },
      single() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : ((s.data as any[]) ?? [])[0] ?? null, error: s.error });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let baseUrl = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}

async function call(method: string, path: string, asUser: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("T80 — PATCH records a version", () => {
  it("writes message_edits version 1 carrying the PREVIOUS body, not the new one", async () => {
    const c = useState({});
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "the corrected text" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.body, "the corrected text");
    assert.equal(r.body.versionHistory.recorded, true);
    assert.equal(r.body.versionHistory.version, 1);

    const rows = (c as any)._db.message_edits;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, M_MINE);
    assert.equal(rows[0].editor_id, ALICE);
    assert.equal(rows[0].version, 1);
    // The point of the whole row. Storing the NEW body would make the history
    // a list of what the message already says.
    assert.equal(rows[0].previous_body, "the original text");
  });

  it("a second edit records version 2 carrying the FIRST edit's text", async () => {
    const c = useState({});
    await call("PATCH", `/api/threads/${THREAD}/messages/${M_MINE}`, ALICE, { body: "second" });
    const r2 = await call("PATCH", `/api/threads/${THREAD}/messages/${M_MINE}`, ALICE, { body: "third" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.versionHistory.version, 2);

    const rows = (c as any)._db.message_edits.slice().sort((a: any, b: any) => a.version - b.version);
    assert.deepEqual(rows.map((x: any) => x.previous_body), ["the original text", "second"]);
    // And the message itself now says the newest thing.
    assert.equal((c as any)._db.messages.find((m: any) => m.id === M_MINE).body, "third");
  });
});

describe("T80 — a missing message_edits is reported, never swallowed", () => {
  it("the edit still lands, and the response says the history was NOT recorded", async () => {
    const c = useState({ failTable: "message_edits", failCode: "42P01" });
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "edited on a deployment without 2811" },
    );
    // The edit is NOT refused: production runs without 2811 today and a
    // traveller must still be able to correct a typo.
    assert.equal(r.status, 200);
    assert.equal(r.body.body, "edited on a deployment without 2811");
    assert.equal((c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "edited on a deployment without 2811");
    // But it does not CLAIM a version was kept.
    assert.equal(r.body.versionHistory.recorded, false);
    assert.equal(r.body.versionHistory.reason, EDIT_HISTORY_UNAVAILABLE);
    assert.equal(r.body.versionHistory.version, null);
  });

  it("GET refuses with a named reason and NOT an empty list", async () => {
    useState({ failTable: "message_edits", failCode: "PGRST205" });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, ALICE);
    // The silent-zero shape this whole file exists to prevent: 200 + [] would
    // tell the caller this message has never been edited, which nobody knows.
    assert.notEqual(r.status, 200);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    // The reason names the deployment fact, so an operator reading a log knows
    // this is an unapplied migration and not a broken query.
    assert.equal(r.body.message, EDIT_HISTORY_UNAVAILABLE);
    assert.equal(r.body.versions, undefined);
  });
});

describe("T80 — a non-schema failure must not lose the previous body", () => {
  it("refuses the edit and leaves `body` untouched when the history write fails", async () => {
    const c = useState({ failTable: "message_edits", failCode: "XX000" });
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "this must not land" },
    );
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    // The guarantee: the old text is still there to be recorded on a retry.
    assert.equal(
      (c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "the original text",
    );
  });

  it("refuses when the version is KNOWN but cannot be written — `body` survives", async () => {
    // The ordering guarantee, isolated. The history read succeeds, so the
    // version number is known; only the write fails. If the route recorded the
    // edit AFTER overwriting `messages.body` — or simply carried on past a
    // failed insert — "the original text" would be gone with nothing holding
    // it, and no retry could ever recover it.
    const c = useState({ failEditsInsertOnly: "XX000" });
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "this must not land either" },
    );
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(
      (c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "the original text",
    );
    assert.equal((c as any)._db.messages.find((m: any) => m.id === M_MINE).edited_at, null);
  });

  it("a 23505 collision is NOT treated as the absent table", async () => {
    // 23505 is the code `UNIQUE (message_id, version)` raises. It means two
    // edits raced, not that migration 2811 is unapplied, and it must refuse
    // rather than answer 200 with `recorded: false` — which would tell the
    // sender their edit landed unversioned when in fact it did not land.
    const c = useState({ failEditsInsertOnly: "23505" });
    const r = await call("PATCH", `/api/threads/${THREAD}/messages/${M_MINE}`, ALICE, { body: "raced" });
    assert.equal(r.status, 503);
    assert.equal(
      (c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "the original text",
    );
  });

  it("refuses when the version number is UNKNOWABLE, even though the insert would work", async () => {
    // The read guard on its own, in the one state `UNIQUE (message_id,
    // version)` cannot rescue: a history with a GAP.
    //
    // Versions 2 and 3 exist and 1 does not. That is not a contrived shape —
    // the compensation path in this very route produces it, by deleting the
    // version row it wrote when the body update failed afterwards. If an
    // unreadable history were treated as "no edits yet", the route would number
    // this edit 1, the insert would SUCCEED because 1 is free, and the stored
    // history would then claim that the message's ORIGINAL text was the body it
    // held just now — out of order and silently wrong, with no constraint
    // violated and nothing to notice later.
    const c = useState({
      failEditsReadOnly: "XX000",
      edits: [
        { id: "e2", message_id: M_MINE, editor_id: ALICE, version: 2, previous_body: "the real v2", edited_at: mins(-20) },
        { id: "e3", message_id: M_MINE, editor_id: ALICE, version: 3, previous_body: "the real v3", edited_at: mins(-10) },
      ],
    });
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "must not land on an unknown version" },
    );
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(
      (c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "the original text",
    );
    // And nothing was appended on top of a history it could not read.
    assert.equal((c as any)._db.message_edits.length, 2);
    assert.deepEqual(
      (c as any)._db.message_edits.map((e: any) => e.version).sort(),
      [2, 3],
    );
  });

  it("compensates the orphan version row when the body update itself fails", async () => {
    // The history row goes first, so a failed body update would otherwise leave
    // a version claiming an edit that never happened — and burn that version
    // number under UNIQUE (message_id, version) so the next edit collides.
    const c = useState({ failMessageUpdate: true });
    const r = await call(
      "PATCH",
      `/api/threads/${THREAD}/messages/${M_MINE}`,
      ALICE,
      { body: "never lands" },
    );
    assert.notEqual(r.status, 200);
    assert.equal((c as any)._db.message_edits.length, 0);
    assert.equal(
      (c as any)._db.messages.find((m: any) => m.id === M_MINE).body,
      "the original text",
    );
  });
});

describe("T80 — GET /threads/:t/messages/:m/edits", () => {
  it("returns the versions newest-first to a member", async () => {
    useState({
      edits: [
        { id: "e1", message_id: M_MINE, editor_id: ALICE, version: 1, previous_body: "v0", edited_at: mins(-30) },
        { id: "e2", message_id: M_MINE, editor_id: ALICE, version: 2, previous_body: "v1", edited_at: mins(-10) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.versions.map((v: any) => v.version), [2, 1]);
    assert.equal(r.body.versions[0].previousBody, "v1");
    assert.equal(r.body.currentBody, "the original text");
  });

  it("refuses a NON-MEMBER rather than handing them previous bodies", async () => {
    useState({
      edits: [
        { id: "e1", message_id: M_MINE, editor_id: ALICE, version: 1, previous_body: "a secret earlier draft", edited_at: mins(-30) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, CAROL);
    assert.equal(r.status, 403);
    assert.equal(JSON.stringify(r.body).includes("a secret earlier draft"), false);
  });

  it("refuses a DEPARTED member — a save is not a permanent grant (§14.2)", async () => {
    useState({
      members: [
        { user_id: ALICE, left_at: null },
        { user_id: BOB, left_at: mins(-1) },
      ],
      edits: [
        { id: "e1", message_id: M_MINE, editor_id: ALICE, version: 1, previous_body: "earlier", edited_at: mins(-30) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, BOB);
    assert.equal(r.status, 403);
  });

  it("refuses a member whose §14.3 window opens AFTER the message was sent", async () => {
    // A member who joined later can read neither the message nor the drafts it
    // passed through. Without the window check the edit history would be a way
    // around the bound: the current body stays hidden by the thread read, while
    // every earlier body comes back from here.
    useState({
      historyBound: true,
      members: [
        { user_id: ALICE, left_at: null, visible_from_at: null } as any,
        // The message was created at mins(-60); this member's window opens at
        // mins(-30), so the message is behind them.
        { user_id: BOB, left_at: null, visible_from_at: mins(-30) } as any,
      ],
      edits: [
        { id: "e1", message_id: M_MINE, editor_id: ALICE, version: 1, previous_body: "a draft from before BOB joined", edited_at: mins(-40) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, BOB);
    assert.equal(r.status, 403);
    assert.equal(JSON.stringify(r.body).includes("a draft from before BOB joined"), false);
  });

  it("serves a member whose §14.3 window opens BEFORE the message", async () => {
    // The other side of the same branch, so the refusal above is not simply
    // "the bound refuses everyone".
    useState({
      historyBound: true,
      members: [
        { user_id: ALICE, left_at: null, visible_from_at: null } as any,
        { user_id: BOB, left_at: null, visible_from_at: mins(-90) } as any,
      ],
      edits: [
        { id: "e1", message_id: M_MINE, editor_id: ALICE, version: 1, previous_body: "an earlier draft", edited_at: mins(-40) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.versions[0].previousBody, "an earlier draft");
  });

  it("does not serve the history of a DELETED/unsent message (§7.4)", async () => {
    useState({
      edits: [
        { id: "e1", message_id: M_DELETED, editor_id: ALICE, version: 1, previous_body: "the unsent text", edited_at: mins(-30) },
      ],
    });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_DELETED}/edits`, BOB);
    assert.equal(r.status, 404);
    assert.equal(JSON.stringify(r.body).includes("the unsent text"), false);
  });

  it("an unreadable membership refuses rather than reporting no history", async () => {
    useState({ failTable: "message_thread_members", failCode: "XX000" });
    const r = await call("GET", `/api/threads/${THREAD}/messages/${M_MINE}/edits`, BOB);
    assert.equal(r.status, 503);
    assert.equal(r.body.versions, undefined);
  });
});
