/**
 * Migration 3998 EXERCISED BY TWO CONCURRENT SESSIONS on a real database (census-telegraph T155).
 *
 * T155's last remainder: "the writer/trigger serialisation is argued and single-connection tested on
 * PGlite, not exercised by two concurrent sessions." 3998's claim is that the checkpoint writer
 * (telegraph_write_conversation_snapshot) and the four invalidation triggers on messages take ONE
 * per-thread advisory lock, so "a checkpoint being written and a message changing in the same thread
 * serialize: whichever commits second sees the other" — a checkpoint can never survive a change to a
 * message it was built from. Here two real psql sessions race, each holding its transaction open
 * with pg_sleep while the other arrives:
 *
 *   A  the WRITER commits second-to-arrive's view: writer holds the lock, an EDIT arrives → the edit
 *      WAITS for the writer, then deletes the checkpoint the writer just wrote. Nothing stale survives.
 *   B  the EDIT holds the lock, the WRITER arrives → the writer WAITS, then builds from the edited row.
 *   C  the writer holds the lock, a session row is INSERTED at or before the cursor → the insert waits,
 *      then deletes the checkpoint (a row after the cursor would not: it is in the replayed tail).
 *   D  control: the same edit in ANOTHER thread does not wait at all (the lock is per thread).
 *
 * "Waited" is measured, not assumed: the second session's statement takes at least the first's
 * sleep, and the control's does not.
 *
 * The flag telegraph_conversation_snapshots_enabled is turned on for this file and restored after.
 *
 * MUTANT (tgprod/mutants-b4.txt): SN1 the invalidation trigger takes no advisory lock → A is red
 * (the edit does not wait, and the writer's checkpoint survives built from the pre-edit body).
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { HAVE_DB, currentDatabaseUrl, deleteUser, exec, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;
const HOLD_SECONDS = 1.5;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

/** One psql session, run concurrently; resolves with its exit code, output and wall time. */
function session(script: string): Promise<{ status: number; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", currentDatabaseUrl()], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.end(script);
  });
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("3998 — the checkpoint writer and the invalidation triggers serialize across two sessions", { skip: SKIP }, () => {
  let alice = "";
  let flagWas: string | null = null;
  const threads: string[] = [];

  function thread(): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`);
    const id = out[out.length - 1]!;
    threads.push(id);
    return id;
  }
  function sessionRow(t: string, at: string, body: string): string {
    const out = svc(`INSERT INTO public.messages (thread_id, sender_id, msg_type, body, created_at) VALUES ('${t}', '${alice}', 'coordination_session', '${body}', '${at}') RETURNING id;`);
    return out[out.length - 1]!;
  }
  const snapshotOf = (t: string) => rows<{ rows: Array<{ body: string }> }>(`SELECT rows FROM public.conversation_snapshots WHERE thread_id = '${t}'`)[0] ?? null;
  const writer = (t: string, hold: number) =>
    `BEGIN;\nSET LOCAL ROLE service_role;\nSELECT (public.telegraph_write_conversation_snapshot('${t}', 'coordination_sessions')) ->> 'outcome';\nSELECT pg_sleep(${hold});\nCOMMIT;`;

  before(() => {
    alice = seedUser("sn_alice");
    flagWas = scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled'`);
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = 'telegraph_conversation_snapshots_enabled';`);
  });

  after(() => {
    if (flagWas !== null) exec(`UPDATE public.feature_flags SET enabled = ${flagWas === "true"} WHERE flag = 'telegraph_conversation_snapshots_enabled';`);
    for (const t of threads) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    if (alice) deleteUser(alice);
  });

  it("A: the writer holds the lock, an edit arrives — the edit WAITS, then removes the checkpoint; nothing stale survives", async () => {
    const t = thread();
    const m = sessionRow(t, "2026-05-01T10:00:00Z", "v1");
    const w = session(writer(t, HOLD_SECONDS));
    await pause(300);
    const e = session(`SET ROLE service_role;\nUPDATE public.messages SET body = 'v2-edited' WHERE id = '${m}';`);
    const [wr, er] = await Promise.all([w, e]);
    assert.equal(wr.status, 0, wr.stderr); assert.equal(er.status, 0, er.stderr);
    assert.match(wr.stdout, /written/);
    assert.ok(er.ms >= (HOLD_SECONDS - 0.4) * 1000, `the edit did not wait for the writer (${er.ms} ms)`);
    assert.equal(snapshotOf(t), null, "the checkpoint built from v1 does not survive the edit");
  });

  it("B: the edit holds the lock, the writer arrives — the writer WAITS, then builds from the edited row", async () => {
    const t = thread();
    const m = sessionRow(t, "2026-05-01T10:00:00Z", "v1");
    const e = session(`BEGIN;\nSET LOCAL ROLE service_role;\nUPDATE public.messages SET body = 'v2-edited' WHERE id = '${m}';\nSELECT pg_sleep(${HOLD_SECONDS});\nCOMMIT;`);
    await pause(300);
    const w = session(writer(t, 0));
    const [er, wr] = await Promise.all([e, w]);
    assert.equal(er.status, 0, er.stderr); assert.equal(wr.status, 0, wr.stderr);
    assert.ok(wr.ms >= (HOLD_SECONDS - 0.4) * 1000, `the writer did not wait for the edit (${wr.ms} ms)`);
    const snap = snapshotOf(t);
    assert.ok(snap, "the writer wrote after the edit committed");
    assert.deepEqual(snap!.rows.map((r) => r.body), ["v2-edited"], "built from the edited row, never the old one");
  });

  it("C: a session row inserted at or before the cursor while the writer holds the lock waits, then removes the checkpoint", async () => {
    const t = thread();
    sessionRow(t, "2026-05-01T10:00:00Z", "v1");
    sessionRow(t, "2026-05-01T11:00:00Z", "v2");
    const w = session(writer(t, HOLD_SECONDS));
    await pause(300);
    const i = session(`SET ROLE service_role;\nINSERT INTO public.messages (thread_id, sender_id, msg_type, body, created_at) VALUES ('${t}', '${alice}', 'coordination_session', 'late-but-earlier', '2026-05-01T10:30:00Z');`);
    const [wr, ir] = await Promise.all([w, i]);
    assert.equal(wr.status, 0, wr.stderr); assert.equal(ir.status, 0, ir.stderr);
    assert.ok(ir.ms >= (HOLD_SECONDS - 0.4) * 1000, `the insert did not wait (${ir.ms} ms)`);
    assert.equal(snapshotOf(t), null);
  });

  it("D (control): the same edit in ANOTHER thread does not wait — the lock is per thread", async () => {
    const t = thread();
    const other = thread();
    sessionRow(t, "2026-05-01T10:00:00Z", "v1");
    const mo = sessionRow(other, "2026-05-01T10:00:00Z", "x1");
    const w = session(writer(t, HOLD_SECONDS));
    await pause(300);
    const e = session(`SET ROLE service_role;\nUPDATE public.messages SET body = 'x2' WHERE id = '${mo}';`);
    const [wr, er] = await Promise.all([w, e]);
    assert.equal(wr.status, 0, wr.stderr); assert.equal(er.status, 0, er.stderr);
    assert.ok(er.ms < (HOLD_SECONDS - 0.4) * 1000, `an edit in another thread waited (${er.ms} ms)`);
    assert.ok(snapshotOf(t), "this thread's checkpoint is untouched");
  });
});
