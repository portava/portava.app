/**
 * Telegraph §9 shared transport (census-telegraph T107, §81) / migration 3748 —
 * N SIMULTANEOUS ride proposals carrying one request identity create exactly
 * ONE ride, on a real PostgreSQL, through the real route.
 *
 * WHAT IS PROVED HERE
 *   · 3748's state: `messages_idempotency_uniq` is UNIQUE (thread_id,
 *     sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL, and the
 *     read-only duplicate inspection finds no group holding two rows;
 *   · the race, FORCED: every messages INSERT is held until all N requests
 *     have issued one, so every request has already read "no ride with this
 *     identity" before any of them writes. Without that barrier one request
 *     can finish before the next reads and the race never happens (measured on
 *     a single-connection engine: the 23505 branch could be deleted and the
 *     suite stayed green). With it, Postgres refuses N-1 inserts (23505) and
 *     the route answers each loser with the winner's id;
 *   · distinct identities, sent simultaneously, are distinct rides;
 *   · another member's identical key is their own ride;
 *   · the key is in the column and NOT in the body.
 *
 * Each psql call is its own process and its own connection, so the held
 * inserts really do reach the server together.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import { HAVE_DB, currentDatabaseUrl, exec, rows, seedUser, deleteUser } from "./localDb.js";
import { makeSqlClient, wrapForJson } from "./sqlPostgrestAdapter.js";
import { _setTestClient } from "../../lib/http.js";
import telegraphCoordinationRouter from "../../routes/telegraphCoordination.js";

/** One psql process per statement; rows as parsed JSON; SQLSTATE on failure. */
function psqlJson(sql: string): Promise<any[]> {
  const wrapped = `${wrapForJson(sql)};`;
  return new Promise((resolve, reject) => {
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", currentDatabaseUrl()]);
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => {
      if (code === 0) { resolve(JSON.parse(out.trim() || "[]")); return; }
      const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(err);
      reject({ code: m?.[1], message: m?.[2] ?? err.trim() });
    });
    p.stdin.end(wrapped);
  });
}

const barrier = { n: 0, waiting: [] as Array<() => void> };
const client = makeSqlClient(async (sql) => {
  if (barrier.n > 0 && /^INSERT INTO public\."messages"/.test(sql)) {
    await new Promise<void>((release) => {
      barrier.waiting.push(release);
      if (barrier.waiting.length >= barrier.n) { const all = barrier.waiting.splice(0); barrier.n = 0; all.forEach((f) => f()); }
    });
  }
  return psqlJson(sql);
});

let server: http.Server | null = null;
let base = "";
let alice = "", bob = "";
const thread = randomUUID();

function post(as: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`threads/${thread}/coordination`, base);
    const payload = JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}
const ride = (key: string) => ({
  kind: "ACTION_PROPOSAL",
  payload: { action: "SPLIT_RIDE", title: "Share a ride back", requiresConfirmation: true, idempotencyKey: key },
});

describe("T107 / 3748 — one request identity is one ride, on a real database", { skip: !HAVE_DB }, () => {
  before(async () => {
    alice = seedUser("t107a"); bob = seedUser("t107b");
    exec(
      `INSERT INTO public.message_threads (id, thread_type) VALUES ('${thread}', 'group');\n` +
      `INSERT INTO public.message_thread_members (thread_id, user_id) VALUES ('${thread}', '${alice}'), ('${thread}', '${bob}');`,
    );
    _setTestClient(client, true);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", telegraphCoordinationRouter);
    await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}/api/`;
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (!HAVE_DB) return;
    exec(`DELETE FROM public.message_threads WHERE id = '${thread}';`);
    for (const u of [alice, bob]) if (u) deleteUser(u);
  });

  test("3748: the identity index is UNIQUE (thread_id, sender_id, idempotency_key) WHERE key IS NOT NULL", () => {
    const [ix] = rows<{ def: string; uniq: boolean; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisunique AS uniq, i.indisvalid AS valid
         FROM pg_index i WHERE i.indexrelid = to_regclass('public.messages_idempotency_uniq')`,
    );
    assert.ok(ix, "messages_idempotency_uniq is missing");
    assert.equal(ix.uniq, true);
    assert.equal(ix.valid, true);
    assert.match(ix.def, /\(thread_id, sender_id, idempotency_key\) WHERE \(idempotency_key IS NOT NULL\)/);
  });

  test("the read-only duplicate inspection finds no request identity held twice", () => {
    const d = rows(
      `SELECT thread_id, sender_id, idempotency_key, count(*) AS n FROM public.messages
        WHERE idempotency_key IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1`,
    );
    assert.deepEqual(d, []);
  });

  test("N SIMULTANEOUS requests with one identity: exactly ONE ride, and every caller gets its id", async () => {
    const N = 8;
    barrier.n = N;
    const rs = await Promise.all(Array.from({ length: N }, () => post(alice, ride("t107-race"))));
    assert.equal(barrier.n, 0, "the barrier never released: not all N requests reached the insert");
    const written = rows<{ id: string; body: string; idempotency_key: string }>(
      `SELECT id, body, idempotency_key FROM public.messages WHERE thread_id = '${thread}' AND idempotency_key = 't107-race'`,
    );
    assert.equal(written.length, 1, `rows=${written.length} statuses=${rs.map((r) => r.status).join(",")}`);
    assert.deepEqual(
      [...new Set(rs.map((r) => r.body?.id))],
      [written[0]!.id],
      `callers were handed different ids: ${JSON.stringify(rs.map((r) => r.body))}`,
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal(written[0]!.body.includes("t107-race"), false, "the identity leaked into the body");
  });

  test("distinct identities sent simultaneously are distinct rides", async () => {
    barrier.n = 4;
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => post(alice, ride(`t107-distinct-${i}`))));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201]);
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 4);
    const [n] = rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.messages WHERE thread_id = '${thread}' AND idempotency_key LIKE 't107-distinct-%'`);
    assert.equal(n!.n, 4);
  });

  test("another member's identical key is their own ride, never the first sender's", async () => {
    const r = await post(bob, ride("t107-race"));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [first] = rows<{ id: string }>(`SELECT id FROM public.messages WHERE thread_id = '${thread}' AND sender_id = '${alice}' AND idempotency_key = 't107-race'`);
    assert.notEqual(r.body.id, first!.id);
  });
});
