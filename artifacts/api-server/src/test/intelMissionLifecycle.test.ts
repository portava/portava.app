/**
 * IG §16/§22 mission lifecycle — complete (with negative-result acceptance) and
 * decline-without-penalty.
 *
 * Proves: completeMission advances only an ACCEPTED mission and records the result
 * (negative accepted like any other); declineMission works from dispatched OR
 * accepted and writes NO penalty/conduct field (only status + reason); both guard
 * their source state and surface a DB CHECK rejection (e.g. missing
 * evidence_contract required shape) distinctly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completeMission, declineMission, MISSION_RESULTS } from "../services/intel/CoverageService.js";

/** Fake client: guarded update…eq/in…select().maybeSingle(). `checkFail` simulates
 *  a DB CHECK rejecting the update (returns an error like the evidence-shape CHECK). */
function makeDb(seed: any[], opts: { checkFail?: boolean } = {}) {
  const rows = seed.map((r) => ({ ...r }));
  return {
    _rows: rows,
    from(_table: string) {
      let op: "select" | "update" = "select";
      let patch: any = null;
      const eqs: [string, any][] = [];
      const ins: [string, any[]][] = [];
      const match = (r: any) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));
      function exec() {
        if (op === "update") {
          if (opts.checkFail) return { data: null, error: { message: "new row violates check constraint" } };
          const hit = rows.find(match);
          if (!hit) return { data: null, error: null };
          Object.assign(hit, patch);
          return { data: hit, error: null };
        }
        return { data: rows.filter(match), error: null };
      }
      const b: any = {
        select() { return b; },
        update(p: any) { op = "update"; patch = p; return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        in(c: string, vs: any[]) { ins.push([c, vs]); return b; },
        maybeSingle() { return Promise.resolve(exec()); },
        then(r: (x: any) => any) { return Promise.resolve(exec()).then(r); },
      };
      return b;
    },
  };
}

describe("completeMission — §16 negative-result acceptance", () => {
  it("completes an ACCEPTED mission and records the result", async () => {
    const db = makeDb([{ id: "m1", status: "accepted" }]);
    const out = await completeMission(db as any, "m1", "negative");
    assert.equal(out.ok, true);
    assert.equal(db._rows[0].status, "completed");
    assert.equal(db._rows[0].result, "negative", "a negative result is a valid completion");
    assert.ok(db._rows[0].completed_at);
  });

  it("refuses to complete a mission that is not accepted", async () => {
    const db = makeDb([{ id: "m1", status: "dispatched" }]);
    const out = await completeMission(db as any, "m1", "positive");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not_completable");
  });

  it("rejects an unknown result", async () => {
    const db = makeDb([{ id: "m1", status: "accepted" }]);
    const out = await completeMission(db as any, "m1", "bogus" as any);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "invalid_result");
  });

  it("surfaces a DB CHECK rejection (e.g. evidence_contract shape) as a reason", async () => {
    const db = makeDb([{ id: "m1", status: "accepted" }], { checkFail: true });
    const out = await completeMission(db as any, "m1", "positive");
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /check constraint/);
  });

  it("accepts every declared result value", () => {
    assert.deepEqual([...MISSION_RESULTS], ["positive", "negative", "inconclusive"]);
  });
});

describe("declineMission — §22 decline without penalty", () => {
  it("declines from 'dispatched' and writes NO penalty field", async () => {
    const db = makeDb([{ id: "m1", status: "dispatched" }]);
    const out = await declineMission(db as any, "m1", "felt unsafe");
    assert.equal(out.ok, true);
    assert.equal(db._rows[0].status, "declined");
    assert.equal(db._rows[0].decline_reason, "felt unsafe");
    // The guarantee: no penalty/conduct field is ever touched.
    assert.equal("penalty" in db._rows[0], false);
    assert.equal("conduct_penalty" in db._rows[0], false);
  });

  it("declines from 'accepted' too", async () => {
    const db = makeDb([{ id: "m1", status: "accepted" }]);
    const out = await declineMission(db as any, "m1");
    assert.equal(out.ok, true);
    assert.equal(db._rows[0].status, "declined");
  });

  it("refuses to decline a candidate (never dispatched)", async () => {
    const db = makeDb([{ id: "m1", status: "candidate" }]);
    const out = await declineMission(db as any, "m1");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not_declinable");
  });
});
