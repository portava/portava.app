/**
 * fetchBlockedSet — the shared bidirectional block-set helper.
 *
 * Verifies:
 *   - both directions are collapsed into one set (caller-blocked + blocked-caller)
 *   - the counter-party id is returned, never the caller's own id
 *   - a read error returns null (fail-closed) so callers "show nobody"
 *   - a thrown client also returns null
 *
 * Run: node --import tsx/esm --test src/test/blocksLib.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBlockedSet } from "../lib/blocks.js";

const ME    = "11111111-1111-4111-8111-111111111111";
const A      = "22222222-2222-4222-8222-222222222222"; // ME blocked A
const B      = "33333333-3333-4333-8333-333333333333"; // B blocked ME
const OTHER  = "44444444-4444-4444-8444-444444444444"; // unrelated block

/** Minimal fake that answers .from("blocks").select().or() with `.or` parsing. */
function makeClient(rows: any[], opts: { error?: boolean; throws?: boolean } = {}) {
  return {
    from(_table: string) {
      const b: any = {
        select() { return b; },
        or(expr: string) {
          if (opts.throws) throw new Error("boom");
          if (opts.error) return Promise.resolve({ data: null, error: { message: "db down" } });
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
            return m ? { col: m[1], val: m[3] } : null;
          }).filter(Boolean) as { col: string; val: string }[];
          const matched = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
          return Promise.resolve({ data: matched, error: null });
        },
      };
      return b;
    },
  } as any;
}

describe("fetchBlockedSet", () => {
  it("collapses both directions into one set of counter-party ids", async () => {
    const client = makeClient([
      { blocker_id: ME, blocked_id: A },   // ME blocked A
      { blocker_id: B,  blocked_id: ME },  // B blocked ME
      { blocker_id: OTHER, blocked_id: "someone-else" }, // unrelated — filtered by .or
    ]);
    const set = await fetchBlockedSet(client, ME);
    assert.ok(set instanceof Set);
    assert.ok(set!.has(A), "A (blocked by ME) should be in the set");
    assert.ok(set!.has(B), "B (who blocked ME) should be in the set");
    assert.ok(!set!.has(ME), "the caller's own id is never added");
    assert.equal(set!.size, 2);
  });

  it("returns an empty set when there are no blocks", async () => {
    const set = await fetchBlockedSet(makeClient([]), ME);
    assert.ok(set instanceof Set);
    assert.equal(set!.size, 0);
  });

  it("returns null (fail-closed) on a read error", async () => {
    const set = await fetchBlockedSet(makeClient([], { error: true }), ME);
    assert.equal(set, null);
  });

  it("returns null (fail-closed) when the client throws", async () => {
    const set = await fetchBlockedSet(makeClient([], { throws: true }), ME);
    assert.equal(set, null);
  });
});
