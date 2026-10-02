/**
 * sensingRetentionScheduler — the TTL sweep for the anonymous sensing store.
 *
 * Two properties are load-bearing and both are asserted against behaviour rather
 * than against prose:
 *
 *   1. IT MUST NOT RUN WHERE THE TABLE IS ABSENT. Migration 2315 is applied to
 *      portava-ci and not to production, so on the machine this sweep will
 *      actually boot on, the RPC must never be called. "Called it and got an
 *      error" is not the same as "did not call it", and the tests below assert
 *      the RPC list is EMPTY, not merely that the result was a skip.
 *   2. IT MUST FAIL CLOSED, WITH A REASON. `skipped: true` alone made a
 *      permanently broken sweep indistinguishable from a correctly idle one —
 *      the defect lib/intelRetentionScheduler's header records. Each refusal
 *      names itself.
 *
 * No database and no Supabase credential env var is named in this file.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSensingRetentionSweep,
  startSensingRetentionScheduler,
  stopSensingRetentionScheduler,
  SENSING_RETENTION_INTERVAL_MS,
  SENSING_RETENTION_SWEEP_INTERVAL_SECONDS,
} from "../lib/sensingRetentionScheduler.js";
import { _resetSensingStorePresence } from "../lib/sensingAnonService.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A client whose only interesting axis is whether the table exists. The probe is
 * a HEAD select (`{ head: true }`); everything else on this fake exists so a
 * mis-shaped call is a loud failure rather than a silent undefined.
 */
function client(opts: {
  present: boolean;
  deleted?: number | string;
  rpcError?: boolean;
  /** The 3110 publication purge's answer, keyed SEPARATELY from the contribution one. */
  publications?: number | string;
  pubsError?: boolean;
}) {
  const state = { probes: 0, rpc: [] as Array<{ name: string; args: any }> };
  return {
    state,
    from(table: string) {
      assert.equal(table, "sensing_anon_contributions", "the sweep probed some other table");
      return {
        select(_cols: string, options?: any) {
          assert.equal(options?.head, true, "the presence probe must be a HEAD read — it must return no rows");
          return {
            limit: async () => {
              state.probes++;
              return opts.present
                ? { data: null, error: null }
                : { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
            },
          };
        },
      };
    },
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args });
      if (name === "purge_expired_sensing_publications") {
        return opts.pubsError
          ? { data: null, error: { message: "function does not exist" } }
          : { data: opts.publications ?? 0, error: null };
      }
      assert.equal(name, "purge_expired_sensing_contributions", "the sweep called an RPC nobody wired");
      return opts.rpcError
        ? { data: null, error: { message: "boom" } }
        : { data: opts.deleted ?? 0, error: null };
    },
  };
}

describe("sensing TTL sweep — must not run where the table is absent", () => {
  beforeEach(() => _resetSensingStorePresence());

  it("does not sweep without a client", async () => {
    const r = await runSensingRetentionSweep({ client: null });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "no_client");
    assert.equal(r.deleted, 0);
  });

  it("probes, finds no table, and NEVER calls the purge RPC", async () => {
    const c = client({ present: false, deleted: 999 });
    const r = await runSensingRetentionSweep({ client: c });
    assert.equal(r.reason, "store_absent");
    assert.equal(r.skipped, true);
    assert.equal(c.state.probes, 1, "it must actually look");
    assert.deepEqual(c.state.rpc, [], "an irreversible DELETE was attempted against a database with no such table");
  });

  it("store_absent is a distinct answer from error — a permanent refusal must not read as a transient failure", async () => {
    const absent = await runSensingRetentionSweep({ client: client({ present: false }) });
    _resetSensingStorePresence();
    const failing = await runSensingRetentionSweep({ client: client({ present: true, rpcError: true }) });
    assert.equal(absent.reason, "store_absent");
    assert.equal(failing.reason, "error");
    assert.notEqual(absent.reason, failing.reason);
  });
});

describe("sensing TTL sweep — the sweep itself", () => {
  beforeEach(() => _resetSensingStorePresence());

  it("goes through the SECURITY DEFINER functions, not a raw delete", async () => {
    const c = client({ present: true, deleted: 4, publications: 2 });
    const r = await runSensingRetentionSweep({ client: c, now: new Date("2026-09-07T12:00:00.000Z") });
    assert.equal(r.deleted, 4);
    assert.equal(r.publicationsDeleted, 2);
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    // BOTH stores, named exactly, in dependency-free order. Asserting only a
    // count would let a pass that swept one store twice look identical to a
    // pass that swept both.
    assert.deepEqual(
      c.state.rpc.map((x) => x.name),
      ["purge_expired_sensing_contributions", "purge_expired_sensing_publications"],
    );
  });

  it("reports the two stores SEPARATELY — a sum would hide a store that never swept", async () => {
    // The whole reason `publicationsDeleted` is its own field. 4 + 2 = 6 reads
    // identically to 6 + 0, so a summed count cannot answer "did the publication
    // TTL run at all", which is the question the 3110 privacy bound turns on.
    const c = client({ present: true, deleted: 4, publications: 2 });
    const r = await runSensingRetentionSweep({ client: c });
    assert.equal(r.deleted, 4);
    assert.equal(r.publicationsDeleted, 2);
    assert.notEqual(r.deleted, 6);
  });

  it("a bigint publication count arrives as a STRING and is still counted", async () => {
    const r = await runSensingRetentionSweep({ client: client({ present: true, publications: "900" }) });
    assert.equal(r.publicationsDeleted, 900);
  });

  it("the publication purge failing does NOT fail the contribution sweep", async () => {
    // 3110 is applied to no database yet, so on every machine this boots on
    // today the publication RPC does not exist. If its absence turned a
    // successful contribution purge into `reason: "error"`, wiring the new sweep
    // would have STOPPED the sweep that was already working.
    const c = client({ present: true, deleted: 7, pubsError: true });
    const r = await runSensingRetentionSweep({ client: c });
    assert.equal(r.skipped, false, "a failed publication purge must not skip the pass");
    assert.equal(r.reason, null);
    assert.equal(r.deleted, 7, "the contributions that WERE purged must still be reported");
    assert.equal(r.publicationsDeleted, null, "null is 'not swept' and must not read as 'nothing expired'");
    assert.notEqual(r.publicationsDeleted, 0);
  });

  it("null and 0 are different answers, and 0 is only reachable by actually sweeping", async () => {
    const swept = await runSensingRetentionSweep({ client: client({ present: true, publications: 0 }) });
    assert.equal(swept.publicationsDeleted, 0, "the RPC answered 0 — that IS a sweep");
    _resetSensingStorePresence();
    const notSwept = await runSensingRetentionSweep({ client: client({ present: false }) });
    assert.equal(notSwept.publicationsDeleted, null);
  });

  it("the publication purge is given the SAME instant as the contribution purge", async () => {
    // Two clocks in one pass would let a row be expired for one sweep and live
    // for the other in the same hour.
    const c = client({ present: true, publications: 1 });
    await runSensingRetentionSweep({ client: c, now: new Date("2026-09-07T12:00:00.000Z") });
    const pub = c.state.rpc.find((x) => x.name === "purge_expired_sensing_publications");
    assert.ok(pub, "the publication purge did not run");
    assert.deepEqual(pub!.args, { p_now: "2026-09-07T12:00:00.000Z" });
    assert.deepEqual(pub!.args, c.state.rpc[0]!.args);
  });

  it("supplies the instant rather than letting the database read a clock", async () => {
    const c = client({ present: true });
    await runSensingRetentionSweep({ client: c, now: new Date("2026-09-07T12:00:00.000Z") });
    assert.deepEqual(c.state.rpc[0]!.args, { p_now: "2026-09-07T12:00:00.000Z" });
  });

  it("counts a bigint returned as a STRING — PostgREST may not emit int8 as a number", async () => {
    // The same regression lib/intelRetentionScheduler carries a note about: a
    // `typeof data === "number"` guard silently reports 0 for every real purge,
    // making a working sweep look like an idle one.
    const r = await runSensingRetentionSweep({ client: client({ present: true, deleted: "1200" }) });
    assert.equal(r.deleted, 1200);
    assert.equal(r.skipped, false);
  });

  it("an rpc error reports a skip with reason error, never a false success", async () => {
    const r = await runSensingRetentionSweep({ client: client({ present: true, rpcError: true }) });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "error");
    assert.equal(r.deleted, 0);
  });

  it("re-probes after an absent answer, so applying 2315 needs no restart", async () => {
    const absent = client({ present: false });
    assert.equal((await runSensingRetentionSweep({ client: absent })).reason, "store_absent");
    // No reset here on purpose: absence must NOT have been cached.
    const applied = client({ present: true, deleted: 3 });
    const r = await runSensingRetentionSweep({ client: applied });
    assert.equal(r.reason, null);
    assert.equal(r.deleted, 3);
  });

  it("caches a positive probe — the table does not stop existing", async () => {
    const c = client({ present: true, deleted: 1 });
    await runSensingRetentionSweep({ client: c });
    await runSensingRetentionSweep({ client: c });
    assert.equal(c.state.probes, 1, "the probe ran twice for a table that cannot disappear");
    // Two passes, two stores each. The count is spelled out rather than written
    // as `2` so that adding a third sweep to the pass fails HERE, loudly,
    // instead of being absorbed by a number nobody re-reads.
    assert.deepEqual(
      c.state.rpc.map((x) => x.name),
      [
        "purge_expired_sensing_contributions",
        "purge_expired_sensing_publications",
        "purge_expired_sensing_contributions",
        "purge_expired_sensing_publications",
      ],
    );
  });
});

describe("sensing TTL sweep — registration and cadence", () => {
  it("start is idempotent and stop is safe to call twice", () => {
    startSensingRetentionScheduler();
    startSensingRetentionScheduler();
    stopSensingRetentionScheduler();
    stopSensingRetentionScheduler();
  });

  it("has a positive cadence derived from its env var", () => {
    assert.ok(SENSING_RETENTION_SWEEP_INTERVAL_SECONDS > 0);
    assert.equal(SENSING_RETENTION_INTERVAL_MS, SENSING_RETENTION_SWEEP_INTERVAL_SECONDS * 1000);
  });

  it("is registered in index.ts — a scheduler nothing starts is not a sweep", () => {
    // The defect this whole file exists for is a purge function with exactly one
    // reference in the repository: its own definition. An unregistered scheduler
    // is the same defect one layer up.
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    assert.match(index, /import \{ startSensingRetentionScheduler \} from "\.\/lib\/sensingRetentionScheduler\.js"/);
    assert.match(index, /^\s*startSensingRetentionScheduler\(\);/m);
  });

  it("nothing in src/migrations schedules this with pg_cron, which is why a Node sweep exists", () => {
    // Premise for the whole design: if a migration scheduled the purge, this
    // scheduler would be a second sweeper racing it.
    const dir = join(SRC, "migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    assert.ok(sql.length > 100, "premise: the migration directory was found");
    // COMMENTS STRIPPED, and the pattern is the CALL rather than the word.
    // 2600_event_start_transition_flag.sql says "pg_cron not installed" in a
    // header comment explaining why the Node scheduler exists — and this scan
    // read that prose as a migration scheduling a sweep. Fifth instance of the
    // same defect in this tree today (checkStateMachineWriters,
    // checkProjectionConsumers, check-guard-coverage, checkGuardReachability);
    // a comment is not a statement.
    //
    // Not weakened: a migration that actually schedules still matches
    // `cron.schedule(`, and one that installs the extension still matches the
    // CREATE EXTENSION form.
    const stripSqlComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    const SCHEDULES = /\bcron\s*\.\s*schedule\s*\(|create\s+extension[^;]*\bpg_cron\b/i;
    const scheduled = sql.filter((f) => SCHEDULES.test(stripSqlComments(readFileSync(join(dir, f), "utf8"))));
    assert.deepEqual(scheduled, [], "a migration schedules a sweep — the Node scheduler would double it");
  });
});
