/**
 * census-layover L159 — `lib/layoverCheckpointExpirySweep.ts` (lane LAYOVER,
 * census drive 2026-10-23).
 *
 * Spec §17: "Operational checkpoints — short-lived operational + bounded
 * diagnostics." The operational half was already short-lived (every read is
 * bounded by `expires_at > now`); nothing deleted an expired row, so the
 * diagnostic tail was unbounded. This pins the job that bounds it:
 *   - 2992 applied: every row whose `expires_at` has passed is deleted (the
 *     boundary included), live rows are kept, the count is what the database
 *     confirmed, the batch bound is honoured, and no other table is touched;
 *   - 2992 unapplied: the probe answers absent and nothing else is issued,
 *     and that resting state is never a failure;
 *   - failures are failures (read, delete, no client), never a quiet zero;
 *   - it runs: the presence expiry scheduler's tick, which index.ts starts,
 *     runs this phase after its own.
 *
 * The real-schema half (2992's table, the route that writes rows, the reader
 * that hides them) is `src/test/db/layoverCheckpointExpiry.db.test.ts`.
 *
 * Run: node --import tsx/esm --test src/test/layoverCheckpointExpirySweep.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  runLayoverCheckpointExpirySweep,
  runLayoverCheckpointExpiryTick,
  layoverCheckpointExpiryFailureState,
  _resetLayoverCheckpointExpiryFailureState,
} from "../lib/layoverCheckpointExpirySweep.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function checkpoint(id: string, expiresInMin: number): Record<string, any> {
  return {
    id, session_id: `session-${id}`, checkpoint_type: "LANDSIDE_EXIT", observed_at: at(-240), received_at: at(-240),
    source: "TRAVELLER", confidence: "MEDIUM", dedup_key: `LANDSIDE_EXIT:${id}`, expires_at: at(expiresInMin),
    metadata: {}, created_at: at(-240),
  };
}

/** Records every table and operation the sweep issues. */
function recorded(t: Record<string, any[]>, opts: Parameters<typeof makeLayoverDb>[1] = {}) {
  const db = makeLayoverDb(t, opts) as any;
  const ops: string[] = [];
  const wrap = (name: string) => {
    const b = db.from(name);
    for (const op of ["select", "delete", "insert", "update", "upsert"]) {
      const orig = b[op];
      b[op] = (...a: any[]) => { ops.push(`${name}:${op}`); return orig(...a); };
    }
    return b;
  };
  return { ops, db: { ...db, from: wrap } };
}

const ABSENT = { code: "PGRST205", message: "Could not find the table 'public.layover_checkpoints' in the schema cache" };

describe("L159 — 2992 applied: an expired check-in leaves storage at its own expires_at", () => {
  it("deletes every row whose expiry has passed (the boundary included) and keeps every live one", async () => {
    const t: Record<string, any[]> = {
      layover_checkpoints: [checkpoint("c-old", -600), checkpoint("c-expired", -1), checkpoint("c-boundary", 0), checkpoint("c-live", 1), checkpoint("c-live-long", 600)],
    };
    const out = await runLayoverCheckpointExpirySweep({ client: makeLayoverDb(t), now: NOW });
    assert.deepEqual(out, { outcome: "swept", reason: null, deleted: 3, complete: true });
    assert.deepEqual(t.layover_checkpoints.map((r) => r.id).sort(), ["c-live", "c-live-long"]);
  });

  it("the cutoff is the exact complement of readTravellerCheckpoints' `expires_at > now`: the boundary row is one no reader can see", async () => {
    const src = readFileSync(new URL("../services/layover/LayoverCheckpointStore.ts", import.meta.url), "utf8");
    assert.match(src, /\.gt\("expires_at", new Date\(nowMs\)\.toISOString\(\)\)/, "the reader's filter this sweep complements");
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-boundary", 0)] };
    await runLayoverCheckpointExpirySweep({ client: makeLayoverDb(t), now: NOW });
    assert.equal(t.layover_checkpoints.length, 0);
  });

  it("nothing due is `idle` — a measurement — and no DELETE is issued", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-live", 30)] };
    const { db, ops } = recorded(t);
    const out = await runLayoverCheckpointExpirySweep({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "idle", reason: null, deleted: 0, complete: true });
    assert.ok(!ops.includes("layover_checkpoints:delete"), ops.join(","));
    assert.equal(t.layover_checkpoints.length, 1);
  });

  it("bounded: a full batch deletes only the oldest-expiring rows and reports complete: false", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("b", -20), checkpoint("a", -30), checkpoint("c", -10)] };
    const out = await runLayoverCheckpointExpirySweep({ client: makeLayoverDb(t), now: NOW, batchSize: 2 });
    assert.deepEqual(out, { outcome: "swept", reason: null, deleted: 2, complete: false });
    assert.deepEqual(t.layover_checkpoints.map((r) => r.id), ["c"]);
  });

  it("only the checkpoint table is touched, by key: no event per deleted row, no session read", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-expired", -5)], layover_events: [], layover_sessions: [] };
    const { db, ops } = recorded(t);
    await runLayoverCheckpointExpirySweep({ client: db, now: NOW });
    assert.ok(ops.every((o) => o.startsWith("layover_checkpoints:")), ops.join(","));
    assert.equal(t.layover_events.length, 0);
  });

  it("a row whose expiry moved forward between the read and the DELETE is no longer due and stays", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-moved", -5)] };
    const inner = makeLayoverDb(t) as any;
    const racing = {
      ...inner,
      from: (name: string) => {
        const b = inner.from(name);
        const del = b.delete;
        b.delete = () => { t.layover_checkpoints[0].expires_at = at(60); return del(); };
        return b;
      },
    };
    const out = await runLayoverCheckpointExpirySweep({ client: racing, now: NOW });
    assert.equal(out.deleted, 0);
    assert.equal(t.layover_checkpoints.length, 1);
  });
});

describe("L159 — 2992 unapplied: inert, and not a failure", () => {
  beforeEach(() => _resetLayoverCheckpointExpiryFailureState());

  it("the probe answers absent and NOTHING beyond the probe is issued", async () => {
    const { db, ops } = recorded({}, { failures: { "layover_checkpoints:select": ABSENT } });
    const out = await runLayoverCheckpointExpirySweep({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "refused", reason: "table_absent", deleted: 0, complete: false });
    assert.deepEqual(ops, ["layover_checkpoints:select"], "one probe, no due-row read, no DELETE");
  });

  it("ticks over an absent table neither escalate nor clear the failure ledger", async () => {
    for (let i = 0; i < 4; i++) {
      await runLayoverCheckpointExpiryTick({ client: makeLayoverDb({}, { failures: { "layover_checkpoints:select": ABSENT } }), now: NOW });
    }
    assert.deepEqual(layoverCheckpointExpiryFailureState(), { consecutiveFailures: 0, lastError: null });
  });

  it("no service client: refused no_client, and that IS counted — it is a misconfiguration", async () => {
    const out = await runLayoverCheckpointExpiryTick({ client: null, now: NOW });
    assert.deepEqual(out, { outcome: "refused", reason: "no_client", deleted: 0, complete: false });
    assert.equal(layoverCheckpointExpiryFailureState().consecutiveFailures, 1);
  });
});

describe("L159 — failures are failures, never a quiet zero", () => {
  beforeEach(() => _resetLayoverCheckpointExpiryFailureState());

  it("the probe passes and the due-row read fails: read_failed, nothing deleted, counted", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-expired", -5)] };
    const inner = makeLayoverDb(t) as any;
    let selects = 0;
    const db = {
      ...inner,
      from: (name: string) => {
        const b = inner.from(name);
        const sel = b.select;
        b.select = (...a: any[]) => {
          selects += 1;
          if (selects === 2) return makeLayoverDb({}, { failures: { "layover_checkpoints:select": { message: "down" } } }).from("layover_checkpoints").select(...a);
          return sel(...a);
        };
        return b;
      },
    };
    const out = await runLayoverCheckpointExpiryTick({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "failed", reason: "read_failed", deleted: 0, complete: false });
    assert.equal(t.layover_checkpoints.length, 1);
    assert.equal(layoverCheckpointExpiryFailureState().consecutiveFailures, 1);
  });

  it("the DELETE is refused: delete_failed, the rows stay, counted; a later clean pass resets the ledger", async () => {
    const t: Record<string, any[]> = { layover_checkpoints: [checkpoint("c-expired", -5)] };
    const out = await runLayoverCheckpointExpiryTick({ client: makeLayoverDb(t, { failures: { "layover_checkpoints:delete": { message: "denied" } } }), now: NOW });
    assert.deepEqual(out, { outcome: "failed", reason: "delete_failed", deleted: 0, complete: false });
    assert.equal(t.layover_checkpoints.length, 1);
    assert.equal(layoverCheckpointExpiryFailureState().consecutiveFailures, 1);
    const clean = await runLayoverCheckpointExpiryTick({ client: makeLayoverDb(t), now: NOW });
    assert.equal(clean.outcome, "swept");
    assert.deepEqual(layoverCheckpointExpiryFailureState(), { consecutiveFailures: 0, lastError: null });
  });
});

describe("L159 — it is a scheduled phase, not an exported function nothing calls", () => {
  it("the presence expiry scheduler's tick — the one index.ts starts — runs the checkpoint phase after its own", () => {
    const sched = readFileSync(new URL("../lib/layoverPresenceExpiryScheduler.ts", import.meta.url), "utf8");
    const start = sched.slice(sched.indexOf("export function startLayoverPresenceExpiryScheduler"), sched.indexOf("export function stopLayoverPresenceExpiryScheduler"));
    assert.match(start, /runLayoverPresenceExpiryTick\(\)\.then\(\(\) => runLayoverCheckpointExpiryTick\(\)\)/, "the timer runs presence, then checkpoints");
    assert.match(sched, /import \{ runLayoverCheckpointExpiryTick \} from "\.\/layoverCheckpointExpirySweep\.js";/);
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const calls = index.split("\n").filter((l) => !/^\s*import\b/.test(l) && /\bstartLayoverPresenceExpiryScheduler\(\);/.test(l));
    assert.equal(calls.length, 1, "index.ts starts the scheduler that carries this phase");
  });

  it("a failing checkpoint phase never stops the loop: the tick never rejects", async () => {
    const throwing = { from: () => { throw new Error("boom"); } };
    const out = await runLayoverCheckpointExpiryTick({ client: throwing, now: NOW });
    assert.equal(out.outcome === "refused" || out.outcome === "failed", true, JSON.stringify(out));
  });
});
