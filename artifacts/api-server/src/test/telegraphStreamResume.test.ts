/**
 * Telegraph §17.3 — reconnect resume.
 *
 * census-telegraph T233: "Reconnect resumes from the last acknowledged
 * conversation/event sequence | N | The SSE stream carries no cursor:
 * `routes/telegraphStream.ts:36-40` closes at 30 minutes with a `reconnect`
 * event and the client re-authenticates from scratch. Gap recovery is delegated
 * entirely to polling."
 *
 * WHAT IS RESUMABLE HERE AND WHAT IS NOT
 * ======================================
 * The event bus is in-memory and lossy by design (census T369), so there is no
 * durable event log to replay and there never will be one on this tree. What IS
 * durable is the CONVERSATION — `messages` rows — and that is what a resume
 * recovers. Transient events (typing, presence) are not replayed and cannot be:
 * replaying a typing indicator from four minutes ago would be a lie about the
 * present rather than a recovery of the past.
 *
 * THE CURSOR IS INCLUSIVE, AND THAT IS DELIBERATE
 * ===============================================
 * The boundary row is re-sent rather than skipped. `created_at` is not unique —
 * two messages can share a timestamp — so an exclusive cursor drops the second
 * one silently and forever. A duplicate is something the client already handles
 * (every replayed frame is marked `replay: true` and carries a messageId to
 * dedupe on); a gap is not recoverable by anything.
 *
 * A FAILED RESUME MUST SAY SO
 * ===========================
 * The interesting case is the unreadable table. supabase-js resolves
 * `{ data: null, error }`, so an unchecked read makes "your account has no
 * messages since then" byte-identical to "we could not look". A client that
 * reads the first as the truth stops polling and loses the conversation. The
 * `stream.resumed` frame therefore always states whether the gap was actually
 * closed, and `resumed: false` is the instruction to fall back to a full poll.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";

import { _setTestServiceClient } from "../lib/supabase.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";

const USER = { id: "e0000000-0000-0000-0000-000000000001", email: "resume@test.com" };
const OTHER = "e0000000-0000-0000-0000-000000000002";
const THREAD_A = "e0000000-0000-0000-0000-0000000000aa";
const THREAD_B = "e0000000-0000-0000-0000-0000000000bb";
const TOKEN = "tok_resume";

type Frame = { id?: string; event: string; data: any };

/** Read SSE frames until `stream.resumed` arrives (or the budget runs out). */
function readStream(server: http.Server, path: string): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        let buf = "";
        const frames: Frame[] = [];
        const finish = () => { try { req.destroy(); } catch { /* already gone */ } resolve(frames); };
        const budget = setTimeout(finish, 2500);
        budget.unref?.();
        res.on("data", (c) => {
          buf += c;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (raw.startsWith(":")) continue; // heartbeat
            const f: Frame = { event: "", data: null };
            for (const line of raw.split("\n")) {
              if (line.startsWith("id: ")) f.id = line.slice(4);
              else if (line.startsWith("event: ")) f.event = line.slice(7);
              else if (line.startsWith("data: ")) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = line.slice(6); } }
            }
            frames.push(f);
            if (f.event === "stream.resumed") { clearTimeout(budget); finish(); return; }
          }
        });
        res.on("error", () => { clearTimeout(budget); finish(); });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function makeFakeClient(opts: {
  members?: Array<Record<string, any>>;
  messages?: Array<Record<string, any>>;
  errorTables?: string[];
} = {}) {
  const tables: Record<string, Array<Record<string, any>>> = {
    message_thread_members: opts.members ?? [],
    messages: opts.messages ?? [],
  };
  function makeQuery(table: string) {
    let rows = [...(tables[table] ?? [])];
    let cols = "*";
    let maybe = false;
    const q: any = {
      select(f = "*") { cols = f; return q; },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return q; },
      neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return q; },
      in(c: string, vs: any[]) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte(c: string, v: any) { rows = rows.filter((r) => String(r[c]) >= String(v)); return q; },
      is(c: string, v: any) { if (v === null) rows = rows.filter((r) => r[c] == null); return q; },
      order(c: string, o: any = {}) {
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
        if (o && o.ascending === false) rows.reverse();
        return q;
      },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      maybeSingle() { maybe = true; return q; },
      then(resolve: (v: any) => void) {
        if ((opts.errorTables ?? []).includes(table)) {
          return resolve({ data: null, error: { message: `permission denied for relation ${table}`, code: "42501" } });
        }
        const project = (r: Record<string, any>) => {
          const f = cols.trim();
          if (!f || f === "*") return { ...r };
          const out: Record<string, any> = {};
          for (const c of f.split(",").map((x) => x.trim()).filter(Boolean)) {
            if (Object.prototype.hasOwnProperty.call(r, c)) out[c] = r[c];
          }
          return out;
        };
        const projected = rows.map(project);
        return resolve(maybe ? { data: projected[0] ?? null, error: null } : { data: projected, error: null });
      },
    };
    return q;
  }
  return {
    auth: { async getUser(t: string) { return t === TOKEN ? { data: { user: USER }, error: null } : { data: { user: null }, error: { message: "bad" } }; } },
    from(t: string) { return makeQuery(t); },
  } as any;
}

function withServer(client: any, fn: (s: http.Server) => Promise<void>) {
  return (async () => {
    _setTestServiceClient(client);
    const app = express();
    app.use(express.json());
    app.use("/api", telegraphStreamRouter);
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try { await fn(server); } finally {
      await new Promise<void>((r) => server.close(() => r()));
      _setTestServiceClient(null as any);
    }
  })();
}

const MEMBERS = [
  { thread_id: THREAD_A, user_id: USER.id, left_at: null },
  { thread_id: THREAD_B, user_id: USER.id, left_at: null },
];
/**
 * THE CONVERSATION IS DATED FROM THE REAL CLOCK, AND IT HAS TO BE.
 *
 * `MAX_RESUME_WINDOW_MS` in `routes/telegraphStream.ts` is twenty-four hours
 * wide and is measured against `Date.now()`: `parseCursor` refuses anything
 * older with `cursor_too_old` before a single row is read. These tests drive
 * that route over HTTP, so there is no `now` to inject — the fixture itself has
 * to land inside the window on whatever day the suite runs.
 *
 * Pinned to 2026-09-15 it did not. The cursors below were 09:00, 10:05 and
 * 10:06 on that date, so on 2026-09-16 the three tests using the earliest
 * cursor began asserting a replay against a refusal at 09:00Z, and the other
 * two followed at 10:05Z and 10:06Z: five failures in three stages inside
 * ninety minutes. Two of them — the unreadable roster and the unreadable
 * messages table — would have gone GREEN FOR THE WRONG REASON, since "nothing
 * was replayed" is equally true of a refused cursor; they survive as failures
 * only because they also pin `reason: "read_failed"`.
 *
 * Everything is therefore an age rather than a date. `BASE` is read once, so a
 * cursor and the message it points at cannot drift apart mid-file, and the
 * whole conversation sits three hours back: far inside the 24h window at every
 * hour of every day, and safely in the past, which `parseCursor` also demands
 * (a cursor more than 60s ahead of now is refused as `cursor_invalid`). Moving
 * the constants to a newer date would only re-arm the same trap.
 */
const BASE = Date.now() - 3 * 60 * 60 * 1000;

/** The instant `minutes` after `BASE`, as the ISO string `created_at` holds. */
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

/** An hour before the first message: a cursor that predates the conversation. */
const CURSOR_BEFORE_ALL = at(-60);

const MESSAGES = [
  { id: "m1", thread_id: THREAD_A, sender_id: OTHER, msg_type: "text", subtype: null, created_at: at(0) },
  { id: "m2", thread_id: THREAD_A, sender_id: OTHER, msg_type: "text", subtype: null, created_at: at(5) },
  { id: "m3", thread_id: THREAD_B, sender_id: OTHER, msg_type: "text", subtype: null, created_at: at(6) },
  { id: "m4", thread_id: THREAD_A, sender_id: USER.id, msg_type: "text", subtype: null, created_at: at(7) },
];

test("every frame carries an SSE id so EventSource can resume on its own", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}`);
    const connected = frames.find((f) => f.event === "connected");
    assert.ok(connected, "connected frame present");
    assert.ok(connected!.id, "connected frame carries an id: line");
  });
});

test("no cursor means no resume, and the client is told rather than left to assume", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}`);
    const r = frames.find((f) => f.event === "stream.resumed");
    assert.ok(r, "a stream.resumed frame is always emitted");
    assert.equal(r!.data.resumed, false);
    assert.equal(r!.data.reason, "no_cursor");
    assert.equal(r!.data.replayed, 0);
    assert.equal(frames.filter((f) => f.event === "message.created").length, 0);
  });
});

test("a cursor replays the messages missed while disconnected, own messages excluded", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const since = encodeURIComponent(at(5)); // exactly m2's timestamp
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=${since}`);
    const replays = frames.filter((f) => f.event === "message.created");
    const ids = replays.map((f) => f.data.payload.messageId);
    // INCLUSIVE: m2 sits exactly on the cursor and is re-sent rather than risked.
    assert.deepEqual(ids, ["m2", "m3"], "m1 predates the cursor; m4 is the caller's own");
    assert.ok(replays.every((f) => f.data.payload.replay === true), "replays are labelled");
    const r = frames.find((f) => f.event === "stream.resumed")!;
    assert.equal(r.data.resumed, true);
    assert.equal(r.data.reason, "ok");
    assert.equal(r.data.replayed, 2);
    assert.equal(r.data.truncated, false);
  });
});

test("Last-Event-ID is accepted as the cursor, which is what EventSource sends", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const addr = server.address() as { port: number };
    const frames = await new Promise<Frame[]>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1", port: addr.port, method: "GET",
          path: `/api/telegraph/stream?token=${TOKEN}`,
          headers: { "Last-Event-ID": at(6) }, // exactly m3's timestamp
        },
        (res) => {
          let buf = ""; const out: Frame[] = [];
          const done = () => { try { req.destroy(); } catch { /* gone */ } resolve(out); };
          const t = setTimeout(done, 2500); t.unref?.();
          res.on("data", (c) => {
            buf += c; let i: number;
            while ((i = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, i); buf = buf.slice(i + 2);
              if (raw.startsWith(":")) continue;
              const f: Frame = { event: "", data: null };
              for (const line of raw.split("\n")) {
                if (line.startsWith("id: ")) f.id = line.slice(4);
                else if (line.startsWith("event: ")) f.event = line.slice(7);
                else if (line.startsWith("data: ")) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = line.slice(6); } }
              }
              out.push(f);
              if (f.event === "stream.resumed") { clearTimeout(t); done(); return; }
            }
          });
        },
      );
      req.on("error", reject); req.end();
    });
    const ids = frames.filter((f) => f.event === "message.created").map((f) => f.data.payload.messageId);
    assert.deepEqual(ids, ["m3"]);
    assert.equal(frames.find((f) => f.event === "stream.resumed")!.data.resumed, true);
  });
});

test("a thread the caller has left is not replayed into their stream", async () => {
  const members = [
    { thread_id: THREAD_A, user_id: USER.id, left_at: null },
    // A fixed date: the roster read is `.is("left_at", null)`, so only whether
    // this is null is ever consulted — the value itself is never a clock.
    { thread_id: THREAD_B, user_id: USER.id, left_at: "2026-09-14T00:00:00.000Z" },
  ];
  await withServer(makeFakeClient({ members, messages: MESSAGES }), async (server) => {
    const since = encodeURIComponent(CURSOR_BEFORE_ALL);
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=${since}`);
    const ids = frames.filter((f) => f.event === "message.created").map((f) => f.data.payload.messageId);
    assert.deepEqual(ids, ["m1", "m2"], "THREAD_B is left; m3 must not be replayed");
  });
});

test("an unreadable roster resumes NOTHING and says so", async () => {
  await withServer(
    makeFakeClient({ members: MEMBERS, messages: MESSAGES, errorTables: ["message_thread_members"] }),
    async (server) => {
      const since = encodeURIComponent(CURSOR_BEFORE_ALL);
      const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=${since}`);
      assert.equal(frames.filter((f) => f.event === "message.created").length, 0,
        "an unknown roster admits nothing");
      const r = frames.find((f) => f.event === "stream.resumed")!;
      assert.equal(r.data.resumed, false, "the gap was NOT closed");
      assert.equal(r.data.reason, "read_failed");
    },
  );
});

test("an unreadable messages table resumes NOTHING and says so", async () => {
  await withServer(
    makeFakeClient({ members: MEMBERS, messages: MESSAGES, errorTables: ["messages"] }),
    async (server) => {
      const since = encodeURIComponent(CURSOR_BEFORE_ALL);
      const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=${since}`);
      assert.equal(frames.filter((f) => f.event === "message.created").length, 0);
      const r = frames.find((f) => f.event === "stream.resumed")!;
      assert.equal(r.data.resumed, false);
      assert.equal(r.data.reason, "read_failed");
    },
  );
});

test("a malformed cursor is refused as a cursor, not treated as the beginning of time", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=yesterday`);
    assert.equal(frames.filter((f) => f.event === "message.created").length, 0);
    const r = frames.find((f) => f.event === "stream.resumed")!;
    assert.equal(r.data.resumed, false);
    assert.equal(r.data.reason, "cursor_invalid");
  });
});

test("a cursor older than the resume window is refused rather than silently truncated", async () => {
  await withServer(makeFakeClient({ members: MEMBERS, messages: MESSAGES }), async (server) => {
    const frames = await readStream(server, `/api/telegraph/stream?token=${TOKEN}&since=2020-01-01T00:00:00.000Z`);
    assert.equal(frames.filter((f) => f.event === "message.created").length, 0);
    const r = frames.find((f) => f.event === "stream.resumed")!;
    assert.equal(r.data.resumed, false);
    assert.equal(r.data.reason, "cursor_too_old");
  });
});
