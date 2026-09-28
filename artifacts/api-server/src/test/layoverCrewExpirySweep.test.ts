/**
 * layoverCrewExpiryScheduler — census-layover L196, the half migration 2984
 * deliberately did not ship.
 *
 * 2984's own header says it plainly, under EXPIRY IS A COLUMN, NOT A JOB:
 *
 *   > L196 asks for "expiration jobs" and this migration does NOT provide one
 *   > … There is no scheduler in this tree … shipping a column named
 *   > `expires_at` that nothing sweeps would be a retention promise nothing
 *   > keeps. So the column is a FILTER, not a promise … The row survives until
 *   > something deletes it. That is honest and it is not retention.
 *
 * This is the something. The properties below are the ones that make it
 * retention rather than decoration, and each is asserted against behaviour:
 *
 *   1. IT MUST NOT RUN WHERE THE TABLES ARE ABSENT. 2984 is applied to no
 *      database in this repository's own capability snapshot. A probe that
 *      errors for ANY reason answers "absent", and the DELETE is then never
 *      issued — "issued it and got an error" is not "did not issue it", so the
 *      tests assert the delete list is EMPTY rather than merely that the
 *      result was a skip.
 *   2. IT MUST FAIL CLOSED, WITH A REASON. A sweep that deleted nothing
 *      because it could not read and a sweep that deleted nothing because
 *      nothing was due must not be the same value. `deleted: 0` is a COUNT and
 *      is only ever returned from a pass that actually ran.
 *   3. IT MUST DISTINGUISH PARTIAL COMPLETION FROM AN IDLE SUCCESSFUL SWEEP.
 *      The sweep is batched, so a full batch means "there is probably more"
 *      and must not read as "the table is now clean".
 *   4. ITS CLOCK IS INJECTED. A sweep whose cutoff came from `Date.now()`
 *      could only be tested against the wall clock, which is how a fixed-date
 *      test bomb gets planted in exactly this kind of module.
 *
 * No database and no Supabase credential env var is named in this file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLayoverCrewExpirySweep,
  startLayoverCrewExpiryScheduler,
  stopLayoverCrewExpiryScheduler,
  layoverCrewExpiryFailureState,
  _resetLayoverCrewExpiryFailureState,
  runLayoverCrewExpiryTick,
  LAYOVER_CREW_EXPIRY_INTERVAL_MS,
  LAYOVER_CREW_EXPIRY_BATCH_SIZE,
} from "../lib/layoverCrewExpiryScheduler.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = new Date("2031-03-04T09:15:00.000Z");

/**
 * A fake whose only interesting axes are whether the table exists and what the
 * expired-id read answers. Every method that is NOT part of the sweep's
 * contract throws, so a mis-shaped call is a loud failure rather than a silent
 * undefined that the assertions below would read as a pass.
 */
function client(opts: {
  present: boolean;
  /** Rows the bounded id read answers with, or an error. */
  expired?: Array<{ id: string }>;
  readError?: boolean;
  deleteError?: boolean;
  probeThrows?: boolean;
  /** Ids the DELETE reports it actually removed, when that is fewer than asked. */
  deleteConfirms?: string[];
}) {
  const state = {
    probes: 0,
    /** Every DELETE the sweep issued, with the ids it targeted. */
    deletes: [] as string[][],
    /** The `expires_at` cutoff the bounded read was given. */
    cutoffs: [] as string[],
    limits: [] as number[],
  };
  return {
    state,
    from(table: string) {
      assert.equal(table, "layover_crews", "the sweep touched some table other than layover_crews");
      return {
        // ── presence probe: select(cols, { head: true }).limit(1) ──────────
        // ── bounded read:   select("id").lt("expires_at", iso).limit(n) ────
        select(cols: string, options?: any) {
          if (options?.head === true) {
            return {
              limit: async () => {
                state.probes++;
                if (opts.probeThrows) throw new Error("socket hang up");
                return opts.present
                  ? { data: null, error: null }
                  : { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
              },
            };
          }
          assert.equal(cols, "id", "the bounded read must select ids and nothing else — a sweep has no business reading a crew's contents");
          return {
            lt(column: string, value: string) {
              assert.equal(column, "expires_at");
              state.cutoffs.push(value);
              return {
                order() {
                  return this;
                },
                limit: async (n: number) => {
                  state.limits.push(n);
                  if (opts.readError) return { data: null, error: { message: "permission denied for table layover_crews" } };
                  return { data: opts.expired ?? [], error: null };
                },
              };
            },
          };
        },
        delete() {
          return {
            in: async (column: string, ids: string[]) => {
              assert.equal(column, "id");
              state.deletes.push(ids);
              if (opts.deleteError) return { data: null, error: { message: "deadlock detected" } };
              const confirmed = opts.deleteConfirms ?? ids;
              return { data: confirmed.map((id) => ({ id })), error: null };
            },
          };
        },
      };
    },
  };
}

describe("L196 crew expiry sweep — must not run where 2984 is unapplied", () => {
  it("refuses without a client, and names why", async () => {
    const r = await runLayoverCrewExpirySweep({ client: null, now: NOW });
    assert.equal(r.outcome, "refused");
    assert.equal(r.reason, "no_client");
    assert.equal(r.deleted, 0);
  });

  it("does not issue a DELETE when the crew tables are absent", async () => {
    const c = client({ present: false });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "refused");
    assert.equal(r.reason, "tables_absent");
    assert.equal(c.state.probes, 1);
    assert.deepEqual(c.state.deletes, [], "a DELETE was issued against a database that has no crew tables");
  });

  it("treats a probe that THROWS as absent, not as present", async () => {
    // supabase-js resolves on database errors, but a DNS or TLS failure inside
    // fetch can still throw. Either way the answer is "do not touch the table".
    const c = client({ present: true, probeThrows: true });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "refused");
    assert.equal(r.reason, "tables_absent");
    assert.deepEqual(c.state.deletes, []);
  });
});

describe("L196 crew expiry sweep — fail closed, never a plausible zero", () => {
  it("a failed id read is NOT a clean zero", async () => {
    const c = client({ present: true, readError: true });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "failed");
    assert.equal(r.reason, "read_failed");
    assert.equal(r.deleted, 0);
    assert.deepEqual(c.state.deletes, [], "ids that could not be read must not be deleted");
    assert.notEqual(r.outcome, "swept", "a sweep that could not read the table must not report a sweep");
  });

  it("a failed DELETE is reported as failed, not as the rows it hoped to remove", async () => {
    const c = client({ present: true, expired: [{ id: "a" }, { id: "b" }], deleteError: true });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "failed");
    assert.equal(r.reason, "delete_failed");
    assert.equal(r.deleted, 0, "the count must be what the database confirmed, not what was attempted");
  });

  it("a successful sweep with nothing due is an IDLE PASS, distinct from every refusal", async () => {
    const c = client({ present: true, expired: [] });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "idle");
    assert.equal(r.reason, null);
    assert.equal(r.deleted, 0);
    assert.equal(r.complete, true);
    assert.deepEqual(c.state.deletes, [], "an empty expired set must not produce an unbounded DELETE");
  });
});

describe("L196 crew expiry sweep — bounded, and honest about partial completion", () => {
  it("deletes exactly the expired ids it read", async () => {
    const c = client({ present: true, expired: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "swept");
    assert.equal(r.deleted, 3);
    assert.deepEqual(c.state.deletes, [["c1", "c2", "c3"]]);
  });

  it("counts what the database CONFIRMED, not what it targeted", async () => {
    // Three ids were due when they were read; by the time the DELETE ran, one
    // was already gone — a concurrent sweep, or a cascade from a deleted
    // session or profile, both of which 2984 declares. Reporting 3 would be a
    // retention claim about a row this pass did not remove.
    const c = client({
      present: true,
      expired: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      deleteConfirms: ["c1", "c3"],
    });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.equal(r.outcome, "swept");
    assert.equal(r.deleted, 2, "the count must be the database's answer, not the size of the request");
  });

  it("bounds the read by the configured batch size", async () => {
    const c = client({ present: true, expired: [] });
    await runLayoverCrewExpirySweep({ client: c, now: NOW, batchSize: 7 });
    assert.deepEqual(c.state.limits, [7]);
  });

  it("a FULL batch reports complete:false — more rows are probably due", async () => {
    const expired = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` }));
    const c = client({ present: true, expired });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW, batchSize: 5 });
    assert.equal(r.outcome, "swept");
    assert.equal(r.deleted, 5);
    assert.equal(r.complete, false, "a full batch must not read as 'the table is now clean'");
  });

  it("a PARTIAL batch reports complete:true", async () => {
    const c = client({ present: true, expired: [{ id: "c1" }] });
    const r = await runLayoverCrewExpirySweep({ client: c, now: NOW, batchSize: 5 });
    assert.equal(r.complete, true);
  });

  it("the default batch size is bounded and small", () => {
    assert.ok(Number.isInteger(LAYOVER_CREW_EXPIRY_BATCH_SIZE));
    assert.ok(LAYOVER_CREW_EXPIRY_BATCH_SIZE > 0 && LAYOVER_CREW_EXPIRY_BATCH_SIZE <= 1000);
  });
});

describe("L196 crew expiry sweep — the clock is injected", () => {
  it("uses the instant it was given as the cutoff, not the wall clock", async () => {
    const c = client({ present: true, expired: [] });
    await runLayoverCrewExpirySweep({ client: c, now: NOW });
    assert.deepEqual(c.state.cutoffs, [NOW.toISOString()]);
  });

  it("two different instants produce two different cutoffs", async () => {
    const other = new Date("2019-12-31T23:59:59.000Z");
    const c = client({ present: true, expired: [] });
    await runLayoverCrewExpirySweep({ client: c, now: NOW });
    await runLayoverCrewExpirySweep({ client: c, now: other });
    assert.deepEqual(c.state.cutoffs, [NOW.toISOString(), other.toISOString()]);
  });

  it("carries no fixed-date literal of its own", () => {
    // A scheduler is exactly where a date bomb breeds: a cutoff written as a
    // literal passes for years and then does not.
    const src = readFileSync(resolve(SRC, "lib/layoverCrewExpiryScheduler.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.equal(
      /\b(19|20|21)\d{2}-\d{2}-\d{2}\b/.test(code),
      false,
      "a date literal in the sweep's own code is a time bomb",
    );
    assert.equal(/Date\.now\(\)/.test(code), false, "the cutoff must come from the injected clock");
  });
});

describe("L196 crew expiry sweep — the failure ledger", () => {
  it("counts consecutive failures and clears only on a pass that actually ran", async () => {
    _resetLayoverCrewExpiryFailureState();
    const broken = client({ present: true, readError: true });
    await runLayoverCrewExpiryTick({ client: broken, now: NOW });
    await runLayoverCrewExpiryTick({ client: broken, now: NOW });
    assert.equal(layoverCrewExpiryFailureState().consecutiveFailures, 2);
    assert.notEqual(layoverCrewExpiryFailureState().lastError, null);

    const healthy = client({ present: true, expired: [] });
    await runLayoverCrewExpiryTick({ client: healthy, now: NOW });
    assert.equal(layoverCrewExpiryFailureState().consecutiveFailures, 0);
    assert.equal(layoverCrewExpiryFailureState().lastError, null);
    _resetLayoverCrewExpiryFailureState();
  });

  it("an ABSENT table is not a failure — it is the documented inert state", async () => {
    _resetLayoverCrewExpiryFailureState();
    const c = client({ present: false });
    await runLayoverCrewExpiryTick({ client: c, now: NOW });
    assert.equal(
      layoverCrewExpiryFailureState().consecutiveFailures,
      0,
      "2984 is unapplied on every database in this repository's snapshot; alerting on that forever would train the alert away",
    );
    _resetLayoverCrewExpiryFailureState();
  });

  it("a tick never rejects, whatever the client does", async () => {
    _resetLayoverCrewExpiryFailureState();
    const hostile = {
      from() {
        throw new Error("client exploded");
      },
    };
    const r = await runLayoverCrewExpiryTick({ client: hostile, now: NOW });
    assert.equal(r.outcome, "refused");
    _resetLayoverCrewExpiryFailureState();
  });
});

describe("L196 crew expiry scheduler — start/stop", () => {
  it("start is idempotent and stop is safe to call twice", () => {
    startLayoverCrewExpiryScheduler();
    startLayoverCrewExpiryScheduler();
    stopLayoverCrewExpiryScheduler();
    stopLayoverCrewExpiryScheduler();
    // Reaching here without a hang or a throw IS the assertion: a second start
    // that opened a second timer would leave the process alive.
    assert.ok(LAYOVER_CREW_EXPIRY_INTERVAL_MS > 0);
  });
});
