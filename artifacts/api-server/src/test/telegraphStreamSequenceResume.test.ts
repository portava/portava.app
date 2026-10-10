/**
 * census-telegraph T233 (§71) — the SSE stream replays on the per-thread SEQUENCE cursor.
 *
 * The fake models numeric `.gt`/`.order` on `sequence`, `.in`, the roster's
 * `left_at`, `blocks` (both directions, as readBlockExclusions asks), and
 * feature_flags. Messages are dated from the real clock (see
 * telegraphStreamResume.test.ts for why).
 *
 * Run: node --import tsx/esm --test src/test/telegraphStreamSequenceResume.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";
import { parseSequenceCursors, MAX_SEQUENCE_CURSORS } from "../services/telegraphStreamSequenceResume.js";

const ME = "e0000000-0000-4000-8000-000000000001";
const OTHER = "e0000000-0000-4000-8000-000000000002";
const CAROL = "e0000000-0000-4000-8000-000000000003";
const A = "e0000000-0000-4000-8000-0000000000aa";
const B = "e0000000-0000-4000-8000-0000000000bb";
const FOREIGN = "e0000000-0000-4000-8000-0000000000ff";
const TOKEN = "tok_seq";
const ON = { telegraph_sequence_resume_enabled: true, telegraph_message_kernel_enabled: true };
const BASE = Date.now() - 2 * 60 * 60 * 1000;
const at = (m: number) => new Date(BASE + m * 60_000).toISOString();

type Frame = { id?: string; event: string; data: any };

function readStream(server: http.Server, headers: Record<string, string>, query = ""): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: "127.0.0.1", port: addr.port, path: `/api/telegraph/stream?token=${TOKEN}${query}`, method: "GET", headers }, (res) => {
      let buf = ""; const frames: Frame[] = [];
      const finish = () => { try { req.destroy(); } catch { /* gone */ } resolve(frames); };
      const budget = setTimeout(finish, 2500); budget.unref?.();
      res.on("data", (c) => {
        buf += c; let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (raw.startsWith(":")) continue;
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
    });
    req.on("error", reject); req.end();
  });
}

function fake(world: { flags?: Record<string, boolean>; members?: any[]; messages?: any[]; blocks?: any[]; blocksError?: boolean; messagesError?: boolean }) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(world.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })),
    message_thread_members: world.members ?? [],
    messages: world.messages ?? [],
    blocks: world.blocks ?? [],
    profiles: [ME, OTHER, CAROL].map((id) => ({ id })),
  };
  const cmp = (c: string, a: any, b: any) => (c === "sequence" ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  function q(table: string) {
    let rows = [...(tables[table] ?? [])]; let single = false; let selected = "*";
    const o: any = {
      select(c = "*") { selected = c; return o; },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return o; },
      neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return o; },
      in(c: string, vs: any[]) { rows = rows.filter((r) => vs.map(String).includes(String(r[c]))); return o; },
      is(c: string, v: any) { if (v === null) rows = rows.filter((r) => r[c] == null); return o; },
      gt(c: string, v: any) { rows = rows.filter((r) => r[c] != null && cmp(c, r[c], v) > 0); return o; },
      gte(c: string, v: any) { rows = rows.filter((r) => r[c] != null && cmp(c, r[c], v) >= 0); return o; },
      order(c: string, opt: any = {}) { rows = [...rows].sort((a, b) => cmp(c, a[c], b[c])); if (opt.ascending === false) rows.reverse(); return o; },
      limit(n: number) { rows = rows.slice(0, n); return o; },
      maybeSingle() { single = true; return o; },
      then(res: (v: any) => void) {
        if (table === "blocks" && world.blocksError) return res({ data: null, error: { message: "x" } });
        if (table === "messages" && world.messagesError && selected.includes("sequence")) return res({ data: null, error: { message: "x" } });
        return res(single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null });
      },
    };
    return o;
  }
  return {
    auth: { async getUser(t: string) { return t === TOKEN ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad" } }; } },
    from: (t: string) => q(t),
  } as any;
}

async function withServer(client: any, fn: (s: http.Server) => Promise<void>) {
  _setTestServiceClient(client);
  const app = express(); app.use("/api", telegraphStreamRouter);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server); } finally { await new Promise<void>((r) => server.close(() => r())); _setTestServiceClient(null as any); }
}

const MEMBERS = [
  { thread_id: A, user_id: ME, left_at: null }, { thread_id: B, user_id: ME, left_at: null },
];
const msg = (id: string, thread: string, sender: string, sequence: number, minute: number) =>
  ({ id, thread_id: thread, sender_id: sender, msg_type: "text", subtype: null, created_at: at(minute), sequence });
const MESSAGES = [
  msg("a1", A, OTHER, 1, 0), msg("a2", A, OTHER, 2, 1), msg("a3", A, ME, 3, 2), msg("a4", A, CAROL, 4, 2),
  msg("b1", B, OTHER, 1, 3), msg("b2", B, OTHER, 2, 4),
  msg("f1", FOREIGN, OTHER, 1, 5),
];
const H = (v: string) => ({ "x-telegraph-sequence-cursors": v });
const replayed = (fr: Frame[]) => fr.filter((f) => f.event === "message.created").map((f) => f.data.payload.messageId);

describe("T233 §71: the stream replays on the sequence cursor", () => {
  it("replays EXACTLY what came after each acknowledged sequence — no boundary duplicate — and reports each thread's cursor", async () => {
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES }), async (s) => {
      const fr = await readStream(s, H(`${A}:2,${B}:1`));
      assert.deepEqual(replayed(fr), ["a4", "b2"], "a3 is the caller's own send: not a frame, but the cursor passes it");
      const r = fr.find((f) => f.event === "stream.resumed")!.data;
      assert.deepEqual(r.sequence, { resumed: true, threads: { [A]: { nextSequence: 4, hasMore: false }, [B]: { nextSequence: 2, hasMore: false } } });
      assert.equal(fr.find((f) => f.data?.payload?.messageId === "a4")!.data.payload.sequence, 4);
    });
  });

  it("a thread replayed by sequence is NOT replayed again by the timestamp cursor", async () => {
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES }), async (s) => {
      const fr = await readStream(s, { ...H(`${A}:0`), "last-event-id": at(-60) });
      const ids = replayed(fr);
      assert.deepEqual(ids, ["a1", "a2", "a4", "b1", "b2"], "A once by sequence, B by timestamp");
    });
  });

  it("a cursor naming a thread the caller is not in is dropped SILENTLY — absent from the answer, nothing replayed", async () => {
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES }), async (s) => {
      const fr = await readStream(s, H(`${FOREIGN}:0`));
      assert.deepEqual(replayed(fr), []);
      const r = fr.find((f) => f.event === "stream.resumed")!.data;
      assert.deepEqual(r.sequence.threads, {}, "the answer does not say the thread was refused");
    });
  });

  it("a LEFT member's cursor reaches nothing", async () => {
    const members = [{ thread_id: A, user_id: ME, left_at: at(1) }];
    await withServer(fake({ flags: ON, members, messages: MESSAGES }), async (s) => {
      assert.deepEqual(replayed(await readStream(s, H(`${A}:0`))), []);
    });
  });

  it("never across a block (either direction); unreadable blocks fail the sequence replay, not the stream", async () => {
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES, blocks: [{ blocker_id: OTHER, blocked_id: ME }] }), async (s) => {
      assert.deepEqual(replayed(await readStream(s, H(`${A}:0`))), ["a4"]);
    });
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES, blocksError: true }), async (s) => {
      const fr = await readStream(s, H(`${A}:0`));
      assert.deepEqual(replayed(fr), []);
      assert.deepEqual(fr.find((f) => f.event === "stream.resumed")!.data.sequence, { resumed: false, reason: "blocks_unreadable" });
    });
  });

  it("an unreadable message read says so (resumed: false) and the timestamp replay still covers those threads", async () => {
    await withServer(fake({ flags: ON, members: MEMBERS, messages: MESSAGES, messagesError: true }), async (s) => {
      const fr = await readStream(s, { ...H(`${A}:0`), "last-event-id": at(-60) });
      assert.deepEqual(fr.find((f) => f.event === "stream.resumed")!.data.sequence, { resumed: false, reason: "read_failed" });
      assert.ok(replayed(fr).includes("a1"), "thread A falls back to the timestamp replay");
    });
  });

  it("a long gap is bounded: 50 per thread, hasMore true, and the cursor stops at the last row served", async () => {
    const many = Array.from({ length: 70 }, (_, i) => msg(`m${i + 1}`, A, OTHER, i + 1, 0));
    await withServer(fake({ flags: ON, members: MEMBERS, messages: many }), async (s) => {
      const fr = await readStream(s, H(`${A}:0`));
      assert.equal(replayed(fr).length, 50);
      assert.deepEqual(fr.find((f) => f.event === "stream.resumed")!.data.sequence, { resumed: false, threads: { [A]: { nextSequence: 50, hasMore: true } } });
    });
  });

  for (const [label, flags] of [["flags OFF", {}], ["resume ON, kernel OFF", { telegraph_sequence_resume_enabled: true }]] as const) {
    it(`${label}: the header is ignored and the stream is byte-identical to one without it`, async () => {
      await withServer(fake({ flags: { ...flags }, members: MEMBERS, messages: MESSAGES }), async (s) => {
        const strip = (fr: Frame[]) => fr.map((f) => ({ event: f.event, data: f.data && { ...f.data, ts: undefined } })).filter((f) => f.event !== "connected");
        const withH = await readStream(s, { ...H(`${A}:0`), "last-event-id": at(-60) });
        const without = await readStream(s, { "last-event-id": at(-60) });
        assert.deepEqual(strip(withH), strip(without));
        assert.equal(withH.find((f) => f.event === "stream.resumed")!.data.sequence, undefined);
      });
    });
  }
});

describe("parseSequenceCursors", () => {
  it("keeps well-formed uuid:sequence pairs, drops the rest, caps the count", () => {
    const m = parseSequenceCursors(`${A}:3, junk, ${B}:-1, ${B}:x, not-a-uuid:4, ${B}:7`);
    assert.deepEqual([...m.entries()], [[A, 3], [B, 7]]);
    const many = Array.from({ length: 80 }, (_, i) => `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}:1`).join(",");
    assert.equal(parseSequenceCursors(many).size, MAX_SEQUENCE_CURSORS);
    assert.equal(parseSequenceCursors(undefined).size, 0);
  });
});
