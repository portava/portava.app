/**
 * Direct-thread deduplication — absence of evidence is not evidence of absence.
 *
 * Two endpoints (POST /users/:id/open-thread and POST /message-requests/:id/accept)
 * look for an existing 1:1 thread and, if they do not find one, CREATE one. The
 * lookup made three chained reads and dropped the `.error` on all three.
 * supabase-js RESOLVES on a database error, so any one of them failing produced
 * exactly the same answer as "these two people have never spoken" — and the
 * caller then created a second DM thread. Two people ended up with two threads
 * and their history split across both, which no user action undoes. A transient
 * blip caused permanent damage.
 *
 * The membership scan was also unbounded, so PostgREST's row cap (Supabase
 * ships db-max-rows = 1000) truncated a heavy user's thread list and hid the
 * very thread being looked for — the same irreversible outcome, reached without
 * any error at all.
 *
 * The lookup now returns `{ undecided: true }` whenever it cannot PROVE the
 * absence, and the callers refuse instead of creating. These tests pin the
 * distinction: a proven absence must still return `{ threadId: null }`, or the
 * feature would simply stop working.
 *
 * Run: node --import tsx/esm --test src/test/messagingThreadDedupe.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { findDirectThreadBetween } from "../routes/messaging.js";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const C = "cccccccc-0000-0000-0000-00000000000c";
const T_DM = "dddddddd-0000-0000-0000-00000000000d";
const T_GROUP = "eeeeeeee-0000-0000-0000-00000000000e";

/** PostgREST's server-side collection cap. */
const ROW_CAP = 1000;

interface Opts {
  members: Array<{ thread_id: string; user_id: string }>;
  threads: Array<{ id: string; thread_type: string | null }>;
  /** table -> forced error; `membersEqError` targets only the first (eq user) read. */
  membersEqError?: { message: string };
  membersInError?: { message: string };
  threadsError?: { message: string };
}

let logs: Array<{ level: string; obj: any; msg: string }> = [];
const log = {
  error: (obj: any, msg: string) => logs.push({ level: "error", obj, msg }),
  warn: (obj: any, msg: string) => logs.push({ level: "warn", obj, msg }),
};

let queries = 0;

function client(o: Opts) {
  function b(table: string) {
    const self: any = {
      _t: table,
      _f: [] as Array<[string, string, any]>,
      _limit: null as number | null,
      select() { return self; },
      eq(c: string, v: any) { self._f.push(["eq", c, v]); return self; },
      in(c: string, v: any[]) { self._f.push(["in", c, v]); return self; },
      is() { return self; },
      limit(n: number) { self._limit = n; return self; },
      then(res: (v: any) => void, rej?: (e: unknown) => void) {
        queries++;
        const hasIn = self._f.some(([op]: any) => op === "in");
        if (table === "message_thread_members" && !hasIn && o.membersEqError) {
          return Promise.resolve({ data: null, error: o.membersEqError }).then(res, rej);
        }
        if (table === "message_thread_members" && hasIn && o.membersInError) {
          return Promise.resolve({ data: null, error: o.membersInError }).then(res, rej);
        }
        if (table === "message_threads" && o.threadsError) {
          return Promise.resolve({ data: null, error: o.threadsError }).then(res, rej);
        }
        let rows: any[] = table === "message_thread_members" ? o.members.slice() : o.threads.slice();
        for (const [op, c, v] of self._f) {
          if (op === "eq") rows = rows.filter((r) => r[c] === v);
          else if (op === "in") rows = rows.filter((r) => (v as any[]).includes(r[c]));
        }
        // PostgREST truncates the RESPONSE; an explicit limit above the server
        // cap is still clamped to it.
        const eff = self._limit === null ? ROW_CAP : Math.min(self._limit, ROW_CAP);
        return Promise.resolve({ data: rows.slice(0, eff), error: null }).then(res, rej);
      },
    };
    return self;
  }
  return { from: (t: string) => b(t) } as any;
}

const pair = (tid: string, ...users: string[]) => users.map((u) => ({ thread_id: tid, user_id: u }));

beforeEach(() => { logs = []; queries = 0; });

describe("findDirectThreadBetween — decided answers", () => {
  it("finds an existing direct thread (positive control)", async () => {
    const r = await findDirectThreadBetween(
      client({ members: pair(T_DM, A, B), threads: [{ id: T_DM, thread_type: "direct" }] }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: T_DM });
    assert.ok(queries >= 3, `fixture check: expected the lookup to issue its reads, saw ${queries}`);
  });

  it("accepts a legacy NULL thread_type as a direct thread", async () => {
    const r = await findDirectThreadBetween(
      client({ members: pair(T_DM, A, B), threads: [{ id: T_DM, thread_type: null }] }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: T_DM });
  });

  it("a proven absence still returns null so the caller can create", async () => {
    const r = await findDirectThreadBetween(
      client({ members: pair(T_DM, A, C), threads: [{ id: T_DM, thread_type: "direct" }] }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: null },
      "refusing on a genuine absence would stop anyone from ever opening a first conversation");
    assert.deepEqual(logs, [], "a proven absence is not a failure");
  });

  it("a user with no threads at all returns null after ONE read", async () => {
    const r = await findDirectThreadBetween(client({ members: [], threads: [] }), A, B, log);
    assert.deepEqual(r, { threadId: null });
    assert.equal(queries, 1, "no point scanning rosters for someone with no threads");
  });

  it("does NOT hijack a group thread that happens to contain both people", async () => {
    const r = await findDirectThreadBetween(
      client({
        members: [...pair(T_GROUP, A, B, C)],
        threads: [{ id: T_GROUP, thread_type: "trip" }],
      }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: null }, "a three-member trip chat is not this pair's DM");
  });

  it("does NOT reuse a two-member GROUP thread as the DM", async () => {
    const r = await findDirectThreadBetween(
      client({ members: pair(T_GROUP, A, B), threads: [{ id: T_GROUP, thread_type: "circle" }] }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: null },
      "a circle chat with exactly two members would otherwise be hijacked as the DM");
  });
});

describe("findDirectThreadBetween — an unprovable absence is UNDECIDED, never 'no thread'", () => {
  const cases: Array<[string, Partial<Opts>, RegExp]> = [
    ["the membership read fails", { membersEqError: { message: "57014 timeout" } }, /membership read failed/i],
    ["the roster read fails", { membersInError: { message: "08006 connection failure" } }, /roster read failed/i],
    ["the thread-type read fails", { threadsError: { message: "42501 permission denied" } }, /thread-type read failed/i],
  ];

  for (const [name, extra, re] of cases) {
    it(`${name} -> undecided, logged`, async () => {
      const r = await findDirectThreadBetween(
        client({ members: pair(T_DM, A, B), threads: [{ id: T_DM, thread_type: "direct" }], ...extra }),
        A, B, log,
      );
      assert.deepEqual(r, { undecided: true },
        "returning { threadId: null } here makes the caller create a duplicate DM thread that nobody can merge back");
      const hit = logs.filter((l) => l.level === "error" && re.test(l.msg));
      assert.equal(hit.length, 1, `expected the failure to be named; saw ${JSON.stringify(logs.map((l) => l.msg))}`);
    });
  }
});

describe("findDirectThreadBetween — the membership scan is bounded and truncation is refused", () => {
  it("the scan carries an explicit limit", async () => {
    let seenLimit: number | null = null;
    const base = client({ members: pair(T_DM, A, B), threads: [{ id: T_DM, thread_type: "direct" }] });
    const wrapped = {
      from: (t: string) => {
        const bld = base.from(t);
        const origLimit = bld.limit.bind(bld);
        bld.limit = (n: number) => { if (seenLimit === null) seenLimit = n; return origLimit(n); };
        return bld;
      },
    } as any;
    await findDirectThreadBetween(wrapped, A, B, log);
    assert.ok(seenLimit !== null && seenLimit > 0,
      "unbounded, PostgREST truncates the thread list and the existing DM can fall off the end");
  });

  it("a truncated membership scan is UNDECIDED rather than 'no thread'", async () => {
    // A heavy user: the thread the lookup wants sits past the row cap. This is
    // the case no in-memory double discovers for you and that produces the
    // damage with NO error anywhere.
    const members = [
      ...Array.from({ length: ROW_CAP }, (_, i) => ({ thread_id: `bulk-${i}`, user_id: A })),
      ...pair(T_DM, A, B),
    ];
    const r = await findDirectThreadBetween(
      client({ members, threads: [{ id: T_DM, thread_type: "direct" }] }),
      A, B, log,
    );
    assert.deepEqual(r, { undecided: true },
      "past the cap the scan cannot prove absence, and the caller's answer to 'absent' is to create a duplicate");
    assert.equal(logs.filter((l) => /hit the cap/i.test(l.msg)).length, 1,
      "hitting the cap must be reported — silent truncation is how this stayed invisible");
  });

  it("a large-but-untruncated scan still resolves normally", async () => {
    const members = [
      ...Array.from({ length: ROW_CAP - 2 }, (_, i) => ({ thread_id: `bulk-${i}`, user_id: A })),
      ...pair(T_DM, A, B),
    ];
    const r = await findDirectThreadBetween(
      client({ members, threads: [{ id: T_DM, thread_type: "direct" }] }),
      A, B, log,
    );
    assert.deepEqual(r, { threadId: T_DM }, "the cap must not refuse work it can actually do");
  });
});
