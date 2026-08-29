/**
 * Discovery L2 cache cleanup.
 *
 * THE GAP THIS IS WRITTEN AGAINST (2026-08-28)
 * -------------------------------------------
 * `discovery_cache` and `discovery_geocode_cache` both carry `expires_at`, and
 * nothing ever deleted an expired row. `readPlacesFromDb` returns stale rows
 * rather than removing them; `readGeocodeFromDb` returns null past expiry but
 * leaves the row; the only DELETEs in the module are content-matched
 * invalidations, never expiry-driven.
 *
 * Measured on production: `discovery_cache` held 90 rows of which **86 were
 * expired** — 96% dead, oldest from 2026-07-21.
 *
 * THE PROPERTY THAT MATTERS MOST HERE is the one that is easy to get backwards:
 * purging AT expiry would be a regression, not a fix. Rows past `expires_at` are
 * still served — that is serve point 3, `L2_stale`, which serves the stale rows
 * and revalidates in the background. Deleting them on expiry would convert every
 * stale-but-serviceable hit into a cold fetch against a rate-limited dependency.
 * So the cutoff must be measured PAST expiry, and there is a test below that
 * fails if the window is ever collapsed to zero.
 *
 * Pure and offline — a fake client records the query it would have issued.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiscoveryRetentionHours,
  purgeExpiredDiscoveryCache,
  DISCOVERY_CACHE_TABLES,
  CLEANUP_INTERVAL_MS,
} from "../lib/discoveryCacheCleanup.js";

interface Issued { table: string; column: string; cutoff: string }

/** Records each delete and reports a fixed count, or fails a chosen table. */
function fakeClient(opts: { failOn?: string; throwOn?: string } = {}) {
  const issued: Issued[] = [];
  return {
    issued,
    from(table: string) {
      return {
        delete(_o: unknown) {
          return {
            lt(column: string, cutoff: string) {
              issued.push({ table, column, cutoff });
              if (opts.throwOn === table) throw new Error(`boom ${table}`);
              if (opts.failOn === table) return Promise.resolve({ error: { message: "nope" }, count: null });
              return Promise.resolve({ error: null, count: 7 });
            },
          };
        },
      };
    },
  };
}

describe("parseDiscoveryRetentionHours", () => {
  it("defaults to 7 days when unset or unparseable", () => {
    assert.equal(parseDiscoveryRetentionHours(undefined), 168);
    assert.equal(parseDiscoveryRetentionHours(""), 168);
    assert.equal(parseDiscoveryRetentionHours("banana"), 168);
  });

  it("REJECTS zero and negatives rather than honouring them", () => {
    // A retention of 0 would delete rows the instant they expire — precisely the
    // behaviour stale-while-revalidate depends on NOT happening.
    assert.equal(parseDiscoveryRetentionHours("0"), 168);
    assert.equal(parseDiscoveryRetentionHours("-5"), 168);
  });

  it("honours a valid override", () => {
    assert.equal(parseDiscoveryRetentionHours("24"), 24);
    assert.equal(parseDiscoveryRetentionHours("0.5"), 0.5);
  });
});

describe("purgeExpiredDiscoveryCache", () => {
  it("purges BOTH L2 tables on expires_at", async () => {
    const c = fakeClient();
    const r = await purgeExpiredDiscoveryCache({ client: c as any, retentionHours: 168 });

    assert.deepEqual(c.issued.map((i) => i.table), [...DISCOVERY_CACHE_TABLES]);
    for (const i of c.issued) assert.equal(i.column, "expires_at");
    assert.deepEqual(r.deleted, { discovery_cache: 7, discovery_geocode_cache: 7 });
    assert.equal(r.error, null);
  });

  it("cuts off strictly IN THE PAST relative to expiry, never at it", async () => {
    // The load-bearing assertion. If the cutoff were `now`, every stale row that
    // L2_stale still serves would be deleted out from under the SWR path.
    const c = fakeClient();
    const before = Date.now();
    await purgeExpiredDiscoveryCache({ client: c as any, retentionHours: 168 });

    const cutoffMs = new Date(c.issued[0]!.cutoff).getTime();
    const windowMs = 168 * 60 * 60 * 1000;
    assert.ok(cutoffMs <= before - windowMs + 1_000,
      "cutoff must be at least the retention window in the past");
    assert.ok(cutoffMs < before, "cutoff must never be now or later");
  });

  it("a longer retention window pushes the cutoff further back", async () => {
    const short = fakeClient();
    const long = fakeClient();
    await purgeExpiredDiscoveryCache({ client: short as any, retentionHours: 24 });
    await purgeExpiredDiscoveryCache({ client: long as any, retentionHours: 720 });
    assert.ok(
      new Date(long.issued[0]!.cutoff).getTime() < new Date(short.issued[0]!.cutoff).getTime(),
      "30 days must reach further back than 1 day",
    );
  });

  it("one table failing does not skip the other", async () => {
    const c = fakeClient({ failOn: "discovery_cache" });
    const r = await purgeExpiredDiscoveryCache({ client: c as any, retentionHours: 168 });
    assert.equal(r.deleted.discovery_cache, null, "the failing table reports null");
    assert.equal(r.deleted.discovery_geocode_cache, 7, "the other table still ran");
    assert.ok(r.error, "the failure is reported, not swallowed silently");
  });

  it("a THROW in one table does not take down the pass", async () => {
    const c = fakeClient({ throwOn: "discovery_cache" });
    const r = await purgeExpiredDiscoveryCache({ client: c as any, retentionHours: 168 });
    assert.equal(r.deleted.discovery_cache, null);
    assert.equal(r.deleted.discovery_geocode_cache, 7);
    assert.ok(r.error);
  });

  it("no client is a skip, not a crash and not a false success", async () => {
    const r = await purgeExpiredDiscoveryCache({ client: null as any, retentionHours: 168 });
    assert.deepEqual(r.deleted, { discovery_cache: null, discovery_geocode_cache: null });
    assert.equal(r.error, null);
  });

  it("runs daily", () => {
    assert.equal(CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1_000);
  });
});
