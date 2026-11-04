/**
 * census-telegraph T347 / T348 (lane TELEGRAPH batch 3) — §28 SLO-02 and SLO-03 measured.
 *
 *   SLO-02 duplicate canonical messages: counted EXACTLY from the canonical store
 *     (migration 3937's telegraph_duplicate_canonical_messages(), read by lib/telegraphCanonicalSlo.ts)
 *     and served by the audited diagnostics read. 0 → ok; n → n violations (capped); unreadable →
 *     unknown and "unavailable", NEVER a zero.
 *   SLO-03 unsend-after-seen: every verdict of the locked unsend function is counted where it is
 *     decided (services/telegraph/unsend.ts unsendBeforeSeen): a verdict is ok, no verdict is unknown,
 *     and `unsent` while the function reports a recipient who had seen it is a violation.
 *
 * MUTANTS (tgprod/mutants-b3.txt): SL1 an unreadable count reported as 0; SL2 duplicates recorded ok;
 * SL3 the diagnostics read omits the exact count; SL4 a failed unsend verdict counted ok; SL5 the
 * contradictory verdict counted ok.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphCanonicalSlo.test.ts
 */
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";

import { measureDuplicateCanonicalMessages, VIOLATION_RECORD_CAP } from "../lib/telegraphCanonicalSlo.js";
import { telegraphSloSnapshot, _resetTelegraphMetrics } from "../domain/telegraph/services/telegraphObservability.js";
import { unsendBeforeSeen } from "../services/telegraph/unsend.js";
import { _setTestClient } from "../lib/http.js";
import diagnosticsRouter from "../routes/telegraphDiagnostics.js";
import { makeFakeClient, startRouter, type RouterHarness } from "./telegraphCertificationHarness.js";

const reading = (id: string) => telegraphSloSnapshot().find((s) => s.id === id)!;
const rpcAnswer = (answer: { data?: unknown; error?: unknown } | (() => never)) => ({
  rpc: async () => (typeof answer === "function" ? answer() : { data: answer.data ?? null, error: answer.error ?? null }),
});

beforeEach(() => _resetTelegraphMetrics());

describe("SLO-02 — duplicate canonical messages, exact (T347)", () => {
  it("0 duplicates among N keyed sends is measured ok, and says how many keys the contract covers", async () => {
    const r = await measureDuplicateCanonicalMessages(rpcAnswer({ data: [{ duplicate_rows: 0, keyed_groups: 12 }] }));
    assert.deepEqual(r, { status: "measured", duplicateRows: 0, keyedGroups: 12 });
    assert.deepEqual([reading("SLO-02").ok, reading("SLO-02").violations, reading("SLO-02").unknown], [1, 0, 0]);
    assert.equal(reading("SLO-02").meetsTarget, true);
  });

  it("n duplicates are n violations (bigint strings read as numbers), and the target is missed", async () => {
    const r = await measureDuplicateCanonicalMessages(rpcAnswer({ data: [{ duplicate_rows: "3", keyed_groups: "40" }] }));
    assert.deepEqual(r, { status: "measured", duplicateRows: 3, keyedGroups: 40 });
    assert.equal(reading("SLO-02").violations, 3);
    assert.equal(reading("SLO-02").meetsTarget, false);
  });

  it("a flood is capped so it cannot swamp the counter", async () => {
    await measureDuplicateCanonicalMessages(rpcAnswer({ data: [{ duplicate_rows: 50_000, keyed_groups: 60_000 }] }));
    assert.equal(reading("SLO-02").violations, VIOLATION_RECORD_CAP);
  });

  for (const [why, answer] of [
    ["the function is absent (3937 not applied)", { error: { code: "PGRST202", message: "Could not find the function" } }],
    ["the answer is not a count", { data: [{ duplicate_rows: null, keyed_groups: 1 }] }],
    ["the read throws", () => { throw new Error("socket"); }],
  ] as const) {
    it(`${why}: unavailable and unknown — never a zero`, async () => {
      const r = await measureDuplicateCanonicalMessages(rpcAnswer(answer as any));
      assert.equal(r.status, "unavailable");
      assert.deepEqual([reading("SLO-02").ok, reading("SLO-02").unknown], [0, 1]);
      assert.equal(reading("SLO-02").meetsTarget, true, "an unknown is not a violation; it is counted as unknown");
    });
  }
});

describe("SLO-03 — unsend-after-seen, counted at the locked function (T348)", () => {
  const input = { messageId: "m-1", actorId: "a-1", threadId: "t-1" };
  it("unsent and refused verdicts are ok; no verdict is unknown; a self-contradicting verdict is a violation", async () => {
    await unsendBeforeSeen(rpcAnswer({ data: { outcome: "unsent", seenBy: 0, recipientCount: 1, unsentAt: "2026-10-24T00:00:00Z" } }) as any, input);
    await unsendBeforeSeen(rpcAnswer({ data: { outcome: "seen", seenBy: 1, recipientCount: 1 } }) as any, input);
    assert.deepEqual([reading("SLO-03").ok, reading("SLO-03").violations, reading("SLO-03").unknown], [2, 0, 0]);
    await unsendBeforeSeen(rpcAnswer({ error: { code: "57014" } }) as any, input);
    await unsendBeforeSeen(rpcAnswer({ data: { outcome: "made-up" } }) as any, input);
    await unsendBeforeSeen(rpcAnswer(() => { throw new Error("socket"); }) as any, input);
    assert.equal(reading("SLO-03").unknown, 3);
    await unsendBeforeSeen(rpcAnswer({ data: { outcome: "unsent", seenBy: 1, recipientCount: 2 } }) as any, input);
    assert.equal(reading("SLO-03").violations, 1);
    assert.equal(reading("SLO-03").meetsTarget, false);
  });
});

describe("the audited diagnostics read serves the exact count", () => {
  const ADMIN = "aaaaaaaa-0000-4000-8000-0000000000ad";
  let h: RouterHarness;
  before(async () => { h = await startRouter(diagnosticsRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });

  it("canonicalAudit is the store's answer, and SLO-02 in the same response reflects it", async () => {
    const c = makeFakeClient({ feature_flags: [], profiles: [{ id: ADMIN, handle: "ops", role: "admin" }], admin_access_log: [] } as any);
    (c as any).rpc = async (name: string) => (name === "telegraph_duplicate_canonical_messages" ? { data: [{ duplicate_rows: 0, keyed_groups: 7 }], error: null } : { data: null, error: { message: "not modelled" } });
    _setTestClient(c, true);
    const r = await fetch(`${h.base}/telegraph/diagnostics`, { headers: { authorization: `Bearer ${ADMIN}`, "x-admin-access-reason": "checking SLO-02 after a release" } });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.canonicalAudit, { status: "measured", duplicateRows: 0, keyedGroups: 7 });
    const slo2 = body.slos.find((s: any) => s.id === "SLO-02");
    assert.equal(slo2.ok, 1);
    assert.equal(slo2.status, "measured");
  });

  it("an unreadable count is served as unavailable with its reason, never as zero", async () => {
    const c = makeFakeClient({ feature_flags: [], profiles: [{ id: ADMIN, handle: "ops", role: "admin" }], admin_access_log: [] } as any);
    _setTestClient(c, true);
    const r = await fetch(`${h.base}/telegraph/diagnostics`, { headers: { authorization: `Bearer ${ADMIN}`, "x-admin-access-reason": "checking SLO-02 after a release" } });
    const body = await r.json() as any;
    assert.equal(body.canonicalAudit.status, "unavailable");
    assert.match(body.canonicalAudit.reason, /not a count of zero/);
  });
});
