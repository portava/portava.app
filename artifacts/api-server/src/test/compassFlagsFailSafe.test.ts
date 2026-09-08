/**
 * Compass feature flags — an unreadable `feature_flags` table must not
 * DISENGAGE the safety stops.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Compass loaded `LIKE 'COMPASS_%'` in three places — compass/flags.ts,
 * CompassPipeline and CompassFrontLoadEngine — each with its own copy of the
 * query and its own `try/catch`. supabase-js RESOLVES on a database error, so
 * none of those catches ever fired and all three answered the same thing for an
 * unreadable table: `{}`, i.e. "every Compass flag is off".
 *
 * That is safe for the CAPABILITY half of the population (`COMPASS_ENABLED`,
 * `COMPASS_FEED_ENABLED`, `COMPASS_TELEGRAPH`, `COMPASS_<TYPE>_ENABLED`): off
 * is the safe default. It is NOT safe for the STOP half.
 * `COMPASS_<TYPE>_SAFETY_BLOCK` means "stop showing this content type", and
 * CompassSafetyFilter rule 15 reads it straight out of this map. An empty map
 * lifted every one of those stops — the emergency switch disengaging precisely
 * when the database is unhealthy, which is when an operator reaches for it.
 * CompassFallbackFeedBuilder feeds `getFlags()` into the same filter, so the
 * degraded feed had it too.
 *
 * ── THE PAIRING ─────────────────────────────────────────────────────────────
 * A readable-but-EMPTY `feature_flags` table and a FAILED read both used to
 * produce `{}`, so any assertion satisfied by one was satisfied by the other.
 * Every failure case below is paired with the readable-empty twin and asserts
 * the opposite: empty → the block is off (nothing was configured); unreadable →
 * the block is ENGAGED.
 *
 * ── WHY A LOCAL `.like` SHIM ────────────────────────────────────────────────
 * helpers/failClosedSupabase.ts is the contract-checked double for injected
 * read failures, and it does not model `.like`. Rather than reshape production
 * code to fit the double, the wrapper below adds `.like` on top of the real
 * builder, so error injection, `count`, and the thenable semantics all remain
 * the helper's. The shim does NOT filter — it records the operand and returns
 * every row — so each fixture seeds only `COMPASS_`-prefixed rows and the
 * prefix operand is asserted separately.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassFlagsFailSafe.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  fetchCompassFlags,
  getFlags,
  isEnabled,
  isCompassEnabled,
  invalidateFlagsCache,
  FAILSAFE_COMPASS_FLAGS,
  COMPASS_FLAG_PREFIX,
} from "../compass/flags.js";
import { runSafetyFilter } from "../compass/CompassSafetyFilter.js";
import { runPipeline } from "../compass/CompassPipeline.js";
import { buildFrontLoadPayload } from "../compass/CompassFrontLoadEngine.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

const USER   = "aaaaaaaa-0000-4000-a000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-a000-000000000002";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

/** Every terminal read against feature_flags, as the `.like` operand it carried. */
let likeOperands: string[] = [];
/** Number of feature_flags reads actually ISSUED — counted, not assumed. */
let flagReads = 0;

function client(opts: { flags?: Record<string, any>[]; fail?: boolean }) {
  const inner = makeFailClosedClient({
    rows: { feature_flags: opts.flags ?? [], compass_frontload_rules: [] },
    failOn: (ctx) => {
      if (ctx.table !== "feature_flags") return null;
      flagReads++;
      return opts.fail ? READ_FAIL : null;
    },
  });
  return {
    ...inner,
    from(table: string) {
      const b = inner.from(table);
      if (typeof b.like !== "function") {
        b.like = (_col: string, pattern: string) => { likeOperands.push(pattern); return b; };
      }
      return b;
    },
  } as any;
}

beforeEach(() => { likeOperands = []; flagReads = 0; invalidateFlagsCache(); });

const LIVE_ROWS = [
  { flag: "COMPASS_ENABLED", enabled: true },
  { flag: "COMPASS_FEED_ENABLED", enabled: true },
  { flag: "COMPASS_BUDDY_ENABLED", enabled: true },
];

/** A buddy item that clears every other rule in CompassSafetyFilter. */
const CLEAN_BUDDY = {
  id: "item-1",
  type: "buddy",
  authorId: AUTHOR,
} as unknown as CompassItem;

const VIEWER: CompassProfile = {
  userId: USER,
  blockedUserIds: [],
  blockerUserIds: [],
  mutedUserIds: [],
} as unknown as CompassProfile;

let scenarios = 0;

// ═══════════════════════════════════════════════════════════════════════════
// The loader itself
// ═══════════════════════════════════════════════════════════════════════════

describe("fetchCompassFlags", () => {
  it("HEALTHY: reads live rows, ok:true, one request, COMPASS_% operand", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: LIVE_ROWS }));
    assert.equal(load.ok, true);
    assert.equal(load.flags["COMPASS_ENABLED"], true);
    assert.equal(load.flags["COMPASS_FEED_ENABLED"], true);
    assert.equal(flagReads, 1, `expected exactly 1 feature_flags read, saw ${flagReads}`);
    assert.deepEqual(likeOperands, [COMPASS_FLAG_PREFIX]);
  });

  it("HEALTHY TWIN: a readable, EMPTY table is ok:true with NO safety block set", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: [] }));
    assert.equal(load.ok, true);
    assert.deepEqual(load.flags, {});
    // The distinction the whole file turns on: nothing configured ≠ engaged.
    assert.notEqual(load.flags["COMPASS_BUDDY_SAFETY_BLOCK"], true);
  });

  it("FAILURE: ok:false and the fail-safe map, with every _SAFETY_BLOCK engaged", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: LIVE_ROWS, fail: true }));
    assert.equal(load.ok, false);
    assert.equal((load.error as any)?.code, "08006");
    assert.equal(load.flags, FAILSAFE_COMPASS_FLAGS);

    const blockKeys = Object.keys(FAILSAFE_COMPASS_FLAGS);
    assert.ok(blockKeys.length >= 11, `expected the whole item-type vocabulary, saw ${blockKeys.length}`);
    for (const k of blockKeys) {
      assert.match(k, /^COMPASS_[A-Z_]+_SAFETY_BLOCK$/, `${k} is not a stop-shaped flag`);
      assert.equal(FAILSAFE_COMPASS_FLAGS[k], true, `${k} must be ENGAGED on a failed read`);
    }
  });

  it("FAILURE: capability gates still read OFF — the fail-safe map is not 'all true'", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: LIVE_ROWS, fail: true }));
    assert.notEqual(load.flags["COMPASS_ENABLED"], true);
    assert.notEqual(load.flags["COMPASS_FEED_ENABLED"], true);
    assert.notEqual(load.flags["COMPASS_TELEGRAPH"], true);
    // Launch control is deliberately NOT engaged — engaging it without a
    // readable per-region allowlist would deny every item with a country.
    assert.notEqual(load.flags["COMPASS_LAUNCH_CONTROL_ENABLED"], true);
    assert.notEqual(load.flags["COMPASS_COUNTRY_LAUNCH_REQUIRED"], true);
  });

  it("a null client is not a failure — no rows, ok:true, zero requests", async () => {
    scenarios++;
    const load = await fetchCompassFlags(null);
    assert.equal(load.ok, true);
    assert.deepEqual(load.flags, {});
    assert.equal(flagReads, 0);
  });

  it("a THROWN read is NOT answered with the fail-safe map", async () => {
    scenarios++;
    // Measured against @supabase/supabase-js 2.108.2 pointed at an unreachable
    // host: a network failure RESOLVES `{ error: { message: "TypeError: fetch
    // failed", code: "" }, status: 0 }`. postgrest-js catches fetch errors
    // itself, so no database or network fault reaches a `catch`. What does is a
    // client that is not a query builder — a wiring bug — and blanking every
    // content type in response to that would hide the bug behind an empty feed.
    const notABuilder = { from: () => { throw new TypeError("db.from(...).select is not a function"); } } as any;
    const load = await fetchCompassFlags(notABuilder);
    assert.equal(load.ok, false);
    assert.deepEqual(load.flags, {});
    assert.notEqual(load.flags["COMPASS_PLACE_SAFETY_BLOCK"], true);
  });

  it("the fail-safe map is frozen", () => {
    scenarios++;
    assert.equal(Object.isFrozen(FAILSAFE_COMPASS_FLAGS), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getFlags / isEnabled — the cached surface
// ═══════════════════════════════════════════════════════════════════════════

describe("getFlags cache", () => {
  it("HEALTHY: a successful load is cached — a second call issues no request", async () => {
    scenarios++;
    const c = client({ flags: LIVE_ROWS });
    assert.equal(await isCompassEnabled(c), true);
    assert.equal(flagReads, 1);
    assert.equal(await isCompassEnabled(c), true);
    assert.equal(flagReads, 1, "a fresh cache must not re-read");
  });

  it("FAILURE is NOT cached — recovery is immediate, not 30 s later", async () => {
    scenarios++;
    const broken = client({ flags: LIVE_ROWS, fail: true });
    assert.equal(await isCompassEnabled(broken), false);
    assert.equal(await isEnabled(broken, "COMPASS_BUDDY_SAFETY_BLOCK"), true);
    const readsWhileBroken = flagReads;
    assert.equal(readsWhileBroken, 2, "each call must retry rather than serve a cached failure");

    // Same process, database now healthy: the live value must be visible at once.
    const healthy = client({ flags: LIVE_ROWS });
    assert.equal(await isCompassEnabled(healthy), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The consequence: CompassSafetyFilter rule 15
// ═══════════════════════════════════════════════════════════════════════════

describe("CompassSafetyFilter rule 15 — the stop that used to disengage", () => {
  it("HEALTHY TWIN: readable-empty flags let a clean buddy item through", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: [] }));
    const r = runSafetyFilter(CLEAN_BUDDY, VIEWER, null, load.flags);
    assert.equal(r.allowed, true, `fixture guard: the item must otherwise pass (got ${r.reason})`);
  });

  it("HEALTHY TWIN: an explicit block row blocks it", async () => {
    scenarios++;
    const load = await fetchCompassFlags(
      client({ flags: [{ flag: "COMPASS_BUDDY_SAFETY_BLOCK", enabled: true }] }),
    );
    const r = runSafetyFilter(CLEAN_BUDDY, VIEWER, null, load.flags);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "type_safety_block:buddy");
  });

  it("FAILURE: an unreadable feature_flags table now BLOCKS instead of admitting", async () => {
    scenarios++;
    const load = await fetchCompassFlags(client({ flags: [], fail: true }));
    const r = runSafetyFilter(CLEAN_BUDDY, VIEWER, null, load.flags);
    // Before the fix this was `allowed: true` — the same answer as the
    // readable-empty twin above, which is exactly the indistinguishability.
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "type_safety_block:buddy");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// All THREE loaders agree
// ═══════════════════════════════════════════════════════════════════════════

describe("the three COMPASS_% loaders agree on what 'unreadable' means", () => {
  it("flags.ts, CompassPipeline and CompassFrontLoadEngine all engage the stops", async () => {
    scenarios++;
    const fromFlagsModule = (await fetchCompassFlags(client({ flags: LIVE_ROWS, fail: true }))).flags;

    // CompassPipeline: the batch must come back with the buddy item safety-blocked.
    const summary = await runPipeline(
      [CLEAN_BUDDY],
      VIEWER,
      { state: "normal" } as unknown as CompassContext,
      client({ flags: LIVE_ROWS, fail: true }),
    );
    // blockedCount is the SAFETY FILTER's own tally, which is the gate under
    // test. (This bare fixture item is rejected by a later stage for reasons
    // unrelated to flags in BOTH arms, so passedCount cannot discriminate and
    // is deliberately not asserted — blockedCount is the discriminator.)
    assert.equal(summary.inputCount, 1);
    assert.equal(summary.blockedCount, 1, "the safety filter must have blocked the item");

    // CompassFrontLoadEngine: the tier-0 preload item carries the same map.
    const payload = await buildFrontLoadPayload(
      client({ flags: LIVE_ROWS, fail: true }),
      USER,
      VIEWER,
      { networkHint: "offline" },
    );
    const flagItem = payload.tier0.find((i) => i.type === "feature_flags");
    assert.ok(flagItem, "tier0 must still carry a feature_flags item");
    const fromFrontLoad = flagItem!.data as Record<string, boolean>;

    for (const key of Object.keys(FAILSAFE_COMPASS_FLAGS)) {
      assert.equal(fromFlagsModule[key], true, `flags.ts disagrees on ${key}`);
      assert.equal(fromFrontLoad[key], true, `CompassFrontLoadEngine disagrees on ${key}`);
    }
    assert.deepEqual(fromFrontLoad, { ...FAILSAFE_COMPASS_FLAGS });
  });

  it("HEALTHY TWIN: with a readable table all three carry the live values", async () => {
    scenarios++;
    const fromFlagsModule = (await fetchCompassFlags(client({ flags: LIVE_ROWS }))).flags;
    assert.equal(fromFlagsModule["COMPASS_ENABLED"], true);

    const summary = await runPipeline(
      [CLEAN_BUDDY],
      VIEWER,
      { state: "normal" } as unknown as CompassContext,
      client({ flags: LIVE_ROWS }),
    );
    assert.equal(summary.inputCount, 1);
    assert.equal(summary.blockedCount, 0, "a readable flag table must not block the item");

    const payload = await buildFrontLoadPayload(
      client({ flags: LIVE_ROWS }), USER, VIEWER, { networkHint: "offline" },
    );
    const flagItem = payload.tier0.find((i) => i.type === "feature_flags");
    assert.deepEqual(flagItem!.data, {
      COMPASS_ENABLED: true, COMPASS_FEED_ENABLED: true, COMPASS_BUDDY_ENABLED: true,
    });
  });
});

describe("vacuity", () => {
  it("exercised a non-zero number of scenarios", () => {
    assert.ok(scenarios >= 13, `expected >= 13 scenarios, ran ${scenarios}`);
  });
});
