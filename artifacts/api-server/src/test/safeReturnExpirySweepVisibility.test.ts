/**
 * A LIVE LOCATION SHARE THAT COULD NOT BE EXPIRED MUST NOT LOOK LIKE A QUIET TICK.
 *
 * `expireShare` is a LOSSY PROJECTION of `expireShareSettled` — its own header in
 * SafeReturnLiveShareService says so. It collapses two outcomes into one `null`:
 *
 *   no_match     the filter matched no row — already closed, or swept by someone
 *                else. Entirely normal.
 *   unavailable  the UPDATE did not complete. The share's state is UNKNOWN, and
 *                it is a live location share the person has already stopped
 *                agreeing to.
 *
 * `processExpiredLiveShares` discarded that `null`, so a sweep that failed for
 * EVERY share was indistinguishable from a sweep with nothing to do: both logged
 * nothing, both returned, and the tick reported success. The failure could only
 * be inferred afterwards, from a share that outlived its window.
 *
 * This is the same shape the Layover lane found one directory over in
 * `expireShare` itself, where `if (error || !data) return null` conflated
 * PGRST116 with a failed statement. Fixing the service and leaving the only
 * caller discarding the result would have moved the silence rather than removed
 * it.
 *
 * WHAT WOULD TURN THIS RED: go back to `expireShareSettled(...).catch(() => {})`
 * or to `expireShare`, or stop distinguishing `unavailable` from `no_match`, and
 * the first case fails. Make the sweep log at ERROR unconditionally and the
 * second fails.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/safeReturnExpirySweepVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processExpiredLiveShares } from "../lib/safeReturnScheduler.js";

/** One fake client: the stale-share read, then N update()s with a stated fate. */
function clientWith(staleIds: string[], updateFate: "ok" | "fail"): any {
  return {
    from(table: string) {
      // The service writes a `live_share_expired` event after a successful
      // expiry. Accepting it here is not scope creep: refusing it would make the
      // "ok" case fail for a reason that has nothing to do with what is asserted.
      if (table === "safe_return_events") return { insert: async () => ({ error: null }) } as any;
      if (table !== "safe_return_live_shares") throw new Error(`unexpected table ${table}`);
      const updateChain: any = {
        eq: () => updateChain,
        // `.lt("expires_at", …)` is in the real chain and was missing from the
        // first version of this fake. Its absence made the clean-sweep case
        // report `unavailable: 1` — the fake's shape, not the code's behaviour.
        lt: () => updateChain,
        select: () => updateChain,
        single: async () =>
          updateFate === "ok"
            ? { data: { id: staleIds[0], status: "expired" }, error: null }
            : { data: null, error: { code: "57014", message: "statement timeout" } },
        maybeSingle: async () =>
          updateFate === "ok"
            ? { data: { id: staleIds[0], status: "expired" }, error: null }
            : { data: null, error: { code: "57014", message: "statement timeout" } },
      };
      const readChain: any = {
        select: () => readChain,
        eq: () => readChain,
        not: () => readChain,
        lt: () => readChain,
        limit: async () => ({ data: staleIds.map((id) => ({ id })), error: null }),
        update: () => updateChain,
      };
      return readChain;
    },
  };
}

describe("the expiry sweep reports a share it could not expire", () => {
  it("an UPDATE that does not complete is COUNTED, not discarded", async () => {
    const r = await processExpiredLiveShares(clientWith(["share-a", "share-b"], "fail"));
    assert.equal(r.swept, true);
    assert.equal(r.unavailable, 2, "both shares are unaccounted for and the summary must say so");
    assert.equal(r.ok, 0);
    assert.equal(r.noMatch, 0, "a failed statement is NOT a matched-nothing update");
  });

  it("a clean sweep reports ok and zero unavailable — the alarm has to mean something", async () => {
    const r = await processExpiredLiveShares(clientWith(["share-a"], "ok"));
    assert.equal(r.swept, true);
    assert.equal(r.unavailable, 0);
    assert.equal(r.ok, 1);
  });

  it("nothing stale is a swept tick with nothing to do, not a failure", async () => {
    const r = await processExpiredLiveShares(clientWith([], "ok"));
    assert.deepEqual(r, { swept: true, ok: 0, noMatch: 0, unavailable: 0 });
  });

  // NOT TESTED, and the reason is worth writing down rather than leaving as a
  // gap: the seam is `client ?? getServiceClient()`, so passing null falls
  // through to the real factory and the `no_client` branch is unreachable from
  // outside. Reaching it would mean changing the seam to distinguish "no
  // argument" from "explicitly nothing" — contorting production so a test can
  // enter a branch. The branch is two lines and returns a constant; it does not
  // earn that.
});
