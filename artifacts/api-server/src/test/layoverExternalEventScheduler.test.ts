/**
 * The drain that makes the §11 event pipeline run, and the four outcomes it
 * must keep apart.
 *
 * `src/test/schedulerRegistration.test.ts` proves this worker is STARTED. That
 * is a different question from whether a pass does the right thing, and this
 * file is the second half: a scheduler that runs on time and drains the wrong
 * way is worse than one nobody started, because it looks alive.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverExternalEventScheduler.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLayoverExternalEventDrain } from "../lib/layoverExternalEventScheduler.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

/**
 * A client that RECORDS every table it is asked for. The point of most cases
 * below is what is NOT in this list.
 */
function spyClient(opts: { flagOn: boolean; pending?: any[]; failSelect?: boolean }) {
  const touched: string[] = [];
  const make = (table: string): any => {
    touched.push(table);
    const rows =
      table === "feature_flags"
        ? [{ flag: "layover_event_ingest_enabled", enabled: opts.flagOn }]
        : (opts.pending ?? []);
    const b: any = {
      select: () => b, eq: () => b, is: () => b, order: () => b, limit: () => b,
      update: () => b, insert: () => b, not: () => b,
      maybeSingle: async () =>
        opts.failSelect && table !== "feature_flags"
          ? { data: null, error: { message: "relation unavailable" } }
          : { data: rows[0] ?? null, error: null },
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: any) =>
        res(
          opts.failSelect && table !== "feature_flags"
            ? { data: null, error: { message: "relation unavailable" } }
            : { data: rows, error: null },
        ),
    };
    return b;
  };
  return { client: { from: make }, touched };
}

describe("the external-event drain keeps its four outcomes apart", () => {
  it("no service client is `no_client`, not an empty successful pass", async () => {
    const out = await runLayoverExternalEventDrain({ client: null, nowMs: NOW });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "no_client");
    assert.equal(out.drained, 0);
  });

  it("a CLOSED gate performs NO database read at all — not even a count", async () => {
    const { client, touched } = spyClient({ flagOn: false, pending: [{ event_id: "e1" }] });
    const out = await runLayoverExternalEventDrain({ client, nowMs: NOW });

    assert.equal(out.reason, "gate_closed");
    assert.equal(out.skipped, true);
    // THE POINT. A closed channel accumulates nothing to drain, so the pass must
    // not pay for a query — and must not touch the event table at all, which is
    // what makes "the flag is off" a cheap fact rather than a cheap-looking one.
    assert.deepEqual(
      touched.filter((t) => t !== "feature_flags"),
      [],
      `a closed gate touched: ${touched.join(", ")}`,
    );
  });

  it("an unreadable pending set is `read_failed` — never a quiet empty drain", async () => {
    const { client } = spyClient({ flagOn: true, failSelect: true });
    const out = await runLayoverExternalEventDrain({ client, nowMs: NOW });
    assert.equal(out.reason, "read_failed");
    assert.equal(out.skipped, true);
    assert.equal(
      out.drained,
      0,
      "an outage and a quiet day are opposite facts and must not share a report",
    );
  });

  it("an OPEN gate with nothing pending is a real pass, not a skip", async () => {
    const { client, touched } = spyClient({ flagOn: true, pending: [] });
    const out = await runLayoverExternalEventDrain({ client, nowMs: NOW });
    assert.equal(out.reason, null);
    assert.equal(out.skipped, false, "nothing to do is not the same as did not look");
    assert.equal(out.drained, 0);
    assert.ok(
      touched.includes("layover_external_events"),
      "an open gate must actually ask the event table",
    );
  });
});
