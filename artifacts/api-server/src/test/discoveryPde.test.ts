/**
 * PDE — the ranking half of ruling D5=B (lib/discoveryPde.ts).
 *
 * WHAT THESE TESTS ARE FOR
 * ========================
 * The engine's whole reason to exist is that it can be called on requests that
 * today never reach a ranker. That only helps if three properties hold, and all
 * three are the kind that rot silently:
 *
 *   1. It does not retrieve. D5=B is affordable precisely because it leaves
 *      external call volume alone — Overpass is rate-limited and the candidate
 *      cache in front of it keeps its 2-hour TTL. An engine that quietly grew a
 *      fetch would multiply Overpass traffic by the factor D5=B was chosen to
 *      avoid, and nothing else in CI would notice.
 *
 *   2. It never throws. Under D5=B this runs on EVERY discovery request rather
 *      than on the rare cache miss, so a throw here is a throw on the whole
 *      surface. Every sub-stage — the viewer loads, DRS, the analytics — is
 *      individually non-fatal, exactly as it was inline.
 *
 *   3. `served: false` writes NOTHING. A shadow run's result reaches no
 *      user; writing a `rank_events` impression for it would both fabricate an
 *      impression and put shadow data in the table D7=A exists to keep it out
 *      of, for the full 90-day retention.
 *
 * Also asserted: ranking is a permutation. A ranker that drops candidates would
 * make PDE-vs-legacy divergence unreadable, because "ranked differently" and
 * "has fewer items" would look the same in the comparison.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryPde.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadPdeViewer, rankForViewer, suppressWrites, type PdePlace } from "../lib/discoveryPde.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function places(n: number): (PdePlace & { name: string })[] {
  return Array.from({ length: n }, (_, i) => ({
    id:         i % 3 === 0 ? `db/${i}` : `osm/node/${i}`,
    name:       `place-${i}`,
    category:   i % 2 === 0 ? "food" : "nightlife",
    distanceKm: (i % 7) + 0.5,
    savedCount: i * 2,
    rating:     i % 5 === 0 ? null : 3 + (i % 3) * 0.5,
    tags:       [`Tag${i % 4}`],
    lat:        48.85 + i / 1000,
    lng:        2.35 + i / 1000,
    headerImageUrl: i % 4 === 0 ? "https://example.invalid/x.jpg" : null,
    description:    i % 4 === 0 ? "a place" : null,
  }));
}

const VIEWER = {
  userId:       "u-1",
  city:         "paris",
  followedIds:  new Set<string>(["u-2"]),
  interestTags: new Set<string>(["tag1"]),
};

/**
 * Supabase-ish stub that records every write it is asked to perform. Reads
 * resolve empty; the point is the write ledger, not the data.
 */
function recordingClient() {
  const writes: { table: string; op: string }[] = [];
  const client: any = {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq:     () => q,
        in:     () => q,
        gte:    () => q,
        lte:    () => q,
        order:  () => q,
        limit:  () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        single:      async () => ({ data: null, error: null }),
        insert: (..._a: unknown[]) => { writes.push({ table, op: "insert" }); return q; },
        upsert: (..._a: unknown[]) => { writes.push({ table, op: "upsert" }); return q; },
        update: (..._a: unknown[]) => { writes.push({ table, op: "update" }); return q; },
        delete: (..._a: unknown[]) => { writes.push({ table, op: "delete" }); return q; },
        then: (res: any) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return q;
    },
  };
  return { client, writes };
}

/** Runs fn with global fetch replaced by a detonator. */
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  let attempted = false;
  globalThis.fetch = (async () => {
    attempted = true;
    throw new Error("PDE attempted a network call");
  }) as typeof globalThis.fetch;
  try {
    const out = await fn();
    assert.equal(attempted, false, "PDE must not perform network retrieval");
    return out;
  } finally {
    globalThis.fetch = original;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PDE ranking (D5=B)", () => {
  it("A. ranks without retrieving — no network call of any kind", async () => {
    const { client } = recordingClient();
    const out = await withNoNetwork(() =>
      rankForViewer(places(12), VIEWER, { sc: client, served: false }),
    );
    assert.equal(out.stages.portavaRank, true);
    assert.equal(out.ranked.length, 12);
  });

  it("B. ranking is a permutation — nothing added, nothing dropped", async () => {
    const input = places(20);
    const { client } = recordingClient();
    const out = await rankForViewer(input, VIEWER, { sc: client, served: false });

    assert.equal(out.ranked.length, input.length);
    assert.deepEqual(
      out.ranked.map((p) => p.id).sort(),
      input.map((p) => p.id).sort(),
      "ranking must reorder, never filter",
    );
    // The caller's own objects come back, not copies — impression logging and
    // the response body both key off identity downstream.
    for (const p of out.ranked) assert.ok(input.includes(p as any));
  });

  it("C. every candidate is scored and reachable by id", async () => {
    const input = places(9);
    const { client } = recordingClient();
    const out = await rankForViewer(input, VIEWER, { sc: client, served: false });

    assert.equal(out.scoredById.size, input.length);
    for (const p of input) assert.ok(out.scoredById.has(p.id), `missing score for ${p.id}`);
  });

  it("D. served:false performs NO write — a shadow run leaves no trace", async () => {
    const { client, writes } = recordingClient();
    const out = await rankForViewer(places(15), VIEWER, { sc: client, served: false });

    assert.equal(out.stages.analytics, false);
    assert.deepEqual(writes, [], `expected zero writes, got ${JSON.stringify(writes)}`);
  });

  it("D2. and the suppression is load-bearing, not decorative", async () => {
    // The same run with served:true DOES write. This is the control: without it,
    // test D would still pass if the ranking pipeline had simply stopped calling
    // anything, and the guard would be protecting nothing.
    const shadow = recordingClient();
    const serve  = recordingClient();

    const shadowRun = await rankForViewer(places(15), VIEWER, { sc: shadow.client, served: false });
    await rankForViewer(places(15), VIEWER, { sc: serve.client, served: true });

    assert.ok(serve.writes.length > 0, "the serve path must still write — production behaviour is preserved");
    assert.ok(
      serve.writes.some((w) => w.table === "rank_events"),
      "the writes the shadow run avoids are rank_events writes specifically",
    );
    assert.equal(shadow.writes.length, 0);

    // The shadow run stops writes by two different mechanisms, and the counts
    // show both are doing work:
    //   - our own analytics emitters are SKIPPED outright (never called), and
    //   - everything downstream — DRS's per-item rank_events rows — is
    //     INTERCEPTED at the client, because we cannot ask it not to write.
    // So suppressedWrites is the downstream half: positive, and strictly less
    // than the serve path's total. If it were ever zero, the interceptor would
    // have stopped being reached and only the skips would be protecting us.
    assert.ok(
      shadowRun.stages.suppressedWrites > 0,
      "downstream writes must be intercepted, not merely absent",
    );
    assert.ok(
      shadowRun.stages.suppressedWrites < serve.writes.length,
      "the remainder is our own emitters, which are skipped rather than intercepted",
    );
  });

  it("E. a null client still ranks and never throws", async () => {
    const out = await rankForViewer(places(6), VIEWER, { sc: null, served: false });
    assert.equal(out.stages.portavaRank, true);
    assert.equal(out.ranked.length, 6);
    assert.equal(out.stages.analytics, false);
  });

  it("F. a client that throws on every call still yields the portavaRank order", async () => {
    const detonator: any = { from() { throw new Error("db down"); } };
    const input = places(10);

    const clean = await rankForViewer(input, VIEWER, { sc: null,       served: false });
    const under = await rankForViewer(input, VIEWER, { sc: detonator,  served: true  });

    assert.equal(under.ranked.length, input.length);
    assert.deepEqual(
      under.ranked.map((p) => p.id),
      clean.ranked.map((p) => p.id),
      "on DB failure the portavaRank order must be preserved, not scrambled",
    );
    assert.equal(under.stages.portavaRank, true);
  });

  it("G. an empty candidate set is not an error", async () => {
    const out = await rankForViewer([], VIEWER, { sc: null, served: true });
    assert.deepEqual(out.ranked, []);
    assert.equal(out.scoredById.size, 0);
  });

  it("H. ranking is deterministic for identical inputs", async () => {
    const input = places(14);
    const a = await rankForViewer(input, VIEWER, { sc: null, served: false });
    const b = await rankForViewer(input, VIEWER, { sc: null, served: false });
    assert.deepEqual(a.ranked.map((p) => p.id), b.ranked.map((p) => p.id));
  });

  it("I. stages report what ran — absence and failure stay distinguishable", async () => {
    const out = await rankForViewer(places(5), VIEWER, { sc: null, served: false });
    assert.equal(typeof out.stages.portavaRank, "boolean");
    assert.equal(typeof out.stages.drs, "boolean");
    assert.equal(typeof out.stages.analytics, "boolean");
    assert.ok(out.timings.totalMs >= 0);
  });
});

describe("write suppression (the device, not its callers)", () => {
  it("N. reads pass through untouched", async () => {
    const client: any = {
      from(_t: string) {
        const q: any = {
          select: () => q,
          eq:     () => q,
          maybeSingle: async () => ({ data: { interests: ["surf"] }, error: null }),
        };
        return q;
      },
    };
    let suppressed = 0;
    const guarded = suppressWrites(client, () => { suppressed += 1; });
    const { data } = await guarded.from("compass_user_preferences").select("interests").eq("user_id", "u").maybeSingle();

    assert.deepEqual(data, { interests: ["surf"] }, "a read must return real data");
    assert.equal(suppressed, 0, "a read is not a write");
  });

  it("O. every write verb is intercepted, and the real client never sees it", async () => {
    const { client, writes } = recordingClient();
    let suppressed = 0;
    const guarded = suppressWrites(client, () => { suppressed += 1; });

    await guarded.from("rank_events").insert({ a: 1 });
    await guarded.from("rank_events").upsert({ a: 1 });
    await guarded.from("rank_events").update({ a: 1 });
    await guarded.from("rank_events").delete();

    assert.equal(suppressed, 4);
    assert.deepEqual(writes, [], "not one write may reach the underlying client");
  });

  it("P. rpc is suppressed too — a procedure is an uninspectable write surface", async () => {
    let called = false;
    const client: any = { from: () => ({}), rpc: () => { called = true; return {}; } };
    let suppressed = 0;
    const guarded = suppressWrites(client, () => { suppressed += 1; });

    await guarded.rpc("some_procedure", { x: 1 });

    assert.equal(called, false);
    assert.equal(suppressed, 1);
  });

  it("Q. a suppressed write is still awaitable and chainable, so callers do not break", async () => {
    const { client } = recordingClient();
    const guarded = suppressWrites(client, () => {});

    // The shape DRS uses: .insert(...).then(ok, err)
    const settled = await new Promise<string>((resolve) => {
      guarded.from("rank_events").insert({ a: 1 }).then(
        () => resolve("fulfilled"),
        () => resolve("rejected"),
      );
    });
    assert.equal(settled, "fulfilled", "a suppressed write must resolve, never reject");

    // And the awaited value is a well-formed empty result.
    const res = await guarded.from("rank_events").insert({ a: 1 }).select().single();
    assert.equal(res.error, null);
  });

  it("R. a null client is returned unchanged rather than proxied", () => {
    assert.equal(suppressWrites(null, () => {}), null);
  });
});

describe("PDE viewer loading", () => {
  it("J. a null client yields an empty viewer rather than throwing", async () => {
    const v = await loadPdeViewer(null, "u-1", "paris");
    assert.equal(v.userId, "u-1");
    assert.equal(v.city, "paris");
    assert.equal(v.followedIds.size, 0);
    assert.equal(v.interestTags.size, 0);
  });

  it("K. a failing follow-graph read degrades to 'follows nobody', not to an error", async () => {
    const client: any = {
      from(table: string) {
        if (table === "user_follows") throw new Error("boom");
        const q: any = {
          select: () => q, eq: () => q,
          maybeSingle: async () => ({ data: { interests: ["Surf", "COFFEE"] }, error: null }),
        };
        return q;
      },
    };
    const v = await loadPdeViewer(client, "u-1", "lisbon");
    assert.equal(v.followedIds.size, 0);
    assert.deepEqual([...v.interestTags].sort(), ["coffee", "surf"], "interests are lowercased");
  });

  it("L. follows load, interests fail — the half that worked survives", async () => {
    const client: any = {
      from(table: string) {
        if (table === "compass_user_preferences") throw new Error("boom");
        const q: any = {
          select: () => q,
          eq: async () => ({ data: [{ following_id: "u-9" }, { following_id: "u-8" }], error: null }),
        };
        return q;
      },
    };
    const v = await loadPdeViewer(client, "u-1", null);
    assert.deepEqual([...v.followedIds].sort(), ["u-8", "u-9"]);
    assert.equal(v.interestTags.size, 0);
    assert.equal(v.city, null);
  });

  it("M. loadPdeViewer performs no network call", async () => {
    const v = await withNoNetwork(() => loadPdeViewer(null, "u-1", "paris"));
    assert.equal(v.userId, "u-1");
  });
});
