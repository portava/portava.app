/**
 * Compass must not disclose a non-public hidden gem.
 *
 * ─── THE DEFECT THIS FILE WAS WRITTEN AGAINST ────────────────────────────────
 *
 * `hidden_gems` carries a five-value `sensitivity_level`: public, approximate,
 * reveal_after_save, reveal_after_acceptance, protected. Four of the five exist
 * precisely because the gem's EXISTENCE and location are not meant to be handed
 * to everyone — `reveal_after_save` and `reveal_after_acceptance` are earned,
 * and `protected` is never given.
 *
 * The database says so itself. Migration 0043's SELECT policy is
 *
 *     hidden_gems_public_read: status = 'active' AND sensitivity_level = 'public'
 *
 * and `HiddenGemPrivacyGuard.mayDiscloseGemIdentity` is that policy written as a
 * predicate, for the surfaces that read through the SERVICE client and therefore
 * bypass RLS. Its own docstring says it "matches CompassHiddenGemService's
 * inclusion rule, so Compass and the media surfaces agree on exactly one answer."
 *
 * That sentence was false. `CompassItemHydrator.fetchHiddenGems` filtered on
 * `status = 'active'` and NOTHING ELSE, ran on `getServiceClient()` (RLS
 * bypassed — see routes/compass.ts and routes/compassHome.ts), and stamped every
 * row it returned `visibilityScope: "public"`. A protected gem was surfaced by
 * id and name, in the feed, to every user in its city. `CompassHiddenGemService`
 * — the wrapper written to prevent exactly this, whose header says "Call
 * getCompassGemContext() instead of querying hidden_gems directly" — was
 * imported by nothing.
 *
 * ─── WHY THE TESTS ARE SHAPED THE WAY THEY ARE ───────────────────────────────
 *
 * A query filter alone is not the fix, because a query filter is not reachable
 * by the reader: if the predicate ever changes, or a later edit drops the
 * `.eq`, nothing refuses the row. So the tests below check BOTH halves —
 * the query narrows, AND the reader re-checks in memory — and the in-memory half
 * is tested by feeding a row PAST the query filter (`ignoreEqCols`), which is
 * the technique postPublishGatePlatformWide.test.ts uses for the same reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import { mayDiscloseGemIdentity } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import type { CompassProfile } from "../compass/types.js";
import { logger } from "../lib/logger.js";

const VIEWER = "f0000000-0000-4000-a000-000000000001";
const AUTHOR = "f0000000-0000-4000-a000-000000000002";
const CITY   = "Da Nang";

interface Captured {
  table: string;
  eqs:   Record<string, any>;
  ins:   Record<string, any[]>;
}

function gemRow(id: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    name:               `gem ${id}`,
    description:        "a place",
    city:               CITY,
    country:            "VN",
    submitted_by:       AUTHOR,
    category:           "cafe",
    created_at:         "2026-09-01T10:00:00Z",
    status:             "active",
    sensitivity_level:  "public",
    verification_level: "community",
    ...over,
  };
}

function makeClient(opts: {
  gems:          Record<string, any>[];
  captured?:     Captured[];
  ignoreEqCols?: string[];
  gemError?:     { message: string } | null;
}) {
  const ignore = new Set(opts.ignoreEqCols ?? []);
  const tables: Record<string, Record<string, any>[]> = {
    hidden_gems:                    opts.gems,
    posts:                          [],
    profiles:                       [{ id: AUTHOR, username: "aya", display_name: "Aya", avatar_url: null }],
    blocks:                         [],
    user_interactions:              [],
    rent_buddy_profiles:            [],
    discovery_places:               [],
    events:                         [],
    message_threads:                [],
    place_best_of:                  [],
    place_top_contributors:         [],
    place_living_cache:             [],
    place_cache_invalidation_queue: [],
  };

  function builder(table: string) {
    const rec: Captured = { table, eqs: {}, ins: {} };
    let rows = [...(tables[table] ?? [])];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        rec.eqs[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => r[c] === v);
        return b;
      },
      in: (c: string, v: any[]) => {
        rec.ins[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => v.includes(r[c]));
        return b;
      },
      ilike: (c: string, pat: string) => {
        const re = new RegExp(
          "^" + String(pat).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i",
        );
        rows = rows.filter((r) => re.test(String(r[c] ?? "")));
        return b;
      },
      not: () => b, is: () => b, or: () => b, like: () => b, neq: () => b,
      contains: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b,
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => b,
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => b,
      maybeSingle: () => { opts.captured?.push(rec); return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single: () => b.maybeSingle(),
      then: (onF: any, onR: any) => {
        opts.captured?.push(rec);
        const error = table === "hidden_gems" ? (opts.gemError ?? null) : null;
        return Promise.resolve({
          data: error ? null : rows, error, count: rows.length,
        }).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder } as any;
}

function baseProfile(over: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: VIEWER, preferredCities: [], preferredLanguages: ["en"], budgetStyle: null,
    travelStyles: [], socialStyle: null, safetyPreference: "standard",
    visibilityPreference: "semi_private", blockedUserIds: [], blockerUserIds: [],
    mutedUserIds: [], blockCount: 0, blockerCount: 0, trustScore: null, trustLevel: null,
    activeUserScore: null, hasActiveTrip: false, hasActiveBooking: false,
    upcomingTripWithin48h: false, hasFutureTripScheduled: false,
    currentCity: CITY, currentCountry: "VN", safeReturnActive: false,
    categoryWeights: null, ignoredItemIds: [], mutedHashtags: [],
    computedAt: new Date().toISOString(), ...over,
  } as CompassProfile;
}

async function gemIds(client: any, profile = baseProfile()): Promise<string[]> {
  const items = await hydrateCompassItems(client, profile);
  return items.filter((i: any) => i.type === "hidden_gem").map((i: any) => String(i.data?.id ?? i.id));
}

const NON_PUBLIC = ["approximate", "reveal_after_save", "reveal_after_acceptance", "protected"] as const;

describe("Compass feed — hidden gem identity disclosure (migration 0043)", () => {
  it("POSITIVE CONTROL — an active, public gem IS offered to the feed", async () => {
    // Without this, a fix that returns [] unconditionally would pass every
    // refusal test below while deleting the feature.
    const ids = await gemIds(makeClient({ gems: [gemRow("public-1")] }));
    assert.deepEqual(ids, ["public-1"], "a public active gem must still reach the Compass feed");
  });

  for (const level of NON_PUBLIC) {
    it(`refuses a gem whose sensitivity_level is ${level}`, async () => {
      const ids = await gemIds(makeClient({ gems: [gemRow(`g-${level}`, { sensitivity_level: level })] }));
      assert.deepEqual(ids, [], `a ${level} gem must never be named in the Compass feed`);
    });
  }

  it("refuses a non-active gem even when it is public", async () => {
    for (const status of ["pending", "hidden", "merged"]) {
      const ids = await gemIds(makeClient({ gems: [gemRow(`g-${status}`, { status })] }));
      assert.deepEqual(ids, [], `a ${status} gem must not reach the feed`);
    }
  });

  it("the QUERY narrows on both columns, so the database does the work too", async () => {
    const captured: Captured[] = [];
    await gemIds(makeClient({ gems: [gemRow("public-1")], captured }));
    const read = captured.find((c) => c.table === "hidden_gems");
    assert.ok(read, "the hydrator did not read hidden_gems at all");
    assert.equal(read!.eqs["sensitivity_level"], "public",
      "the query does not constrain sensitivity_level — the service client bypasses RLS, so nothing else will");
    assert.deepEqual(read!.ins["status"], ["active"],
      "the query does not constrain status to the searchable set");
  });

  it("the READER re-checks in memory: a row fed past the query filter is still refused", async () => {
    // This is the half that survives a later edit to the query. ignoreEqCols
    // makes the fake DB ignore the sensitivity predicate, which is exactly what
    // a dropped `.eq` or a changed policy would do in production.
    const ids = await gemIds(makeClient({
      gems: [gemRow("leaked", { sensitivity_level: "protected" })],
      ignoreEqCols: ["sensitivity_level"],
    }));
    assert.deepEqual(ids, [],
      "the hydrator trusted the query alone; a protected gem that reaches it must still be refused");
  });

  it("an unreadable hidden_gems read is REPORTED, not mistaken for an empty city", async () => {
    // MEASURED: the obvious form of this test — assert the id list is empty —
    // is VACUOUS. supabase-js returns `data: null` alongside the error, so the
    // list is empty whether or not the reader looks at `.error`, and a mutation
    // that deletes the whole error branch keeps it green. What distinguishes
    // "no gems in this city" from "the read failed" is that the second one says
    // so, so the assertion has to be on the LOG.
    const warned: any[] = [];
    const orig = (logger as any).warn;
    (logger as any).warn = (...args: any[]) => { warned.push(args); };
    try {
      const ids = await gemIds(makeClient({
        gems: [gemRow("public-1")],
        gemError: { message: 'invalid input value for enum hidden_gem_status: "approved"' },
      }));
      assert.deepEqual(ids, [], "a failed read must not surface rows");
    } finally {
      (logger as any).warn = orig;
    }
    const named = warned.some((a) =>
      a.some((x: any) => x && typeof x === "object" && x.compassSource === "hidden_gems"));
    assert.ok(named,
      "the hidden_gems read failed and nothing said so — `{ data }` was destructured without binding `.error`");
  });

  it("the hydrator's answer agrees with mayDiscloseGemIdentity, row for row", async () => {
    // The point of the predicate is that there is ONE answer. If these two ever
    // disagree, one of the two surfaces is wrong and this says which rows.
    const rows = [
      gemRow("a"),
      gemRow("b", { sensitivity_level: "protected" }),
      gemRow("c", { sensitivity_level: "approximate" }),
      gemRow("d", { status: "pending" }),
      gemRow("e", { sensitivity_level: "reveal_after_save" }),
    ];
    const ids = await gemIds(makeClient({ gems: rows, ignoreEqCols: ["sensitivity_level"] }));
    const expected = rows.filter((r) => mayDiscloseGemIdentity(r as any, VIEWER)).map((r) => r.id);
    assert.deepEqual(ids.sort(), expected.sort(),
      "Compass and HiddenGemPrivacyGuard disagree about which gems may be named");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SAME defect, a second surface: Telegraph share.
//
// `services/telegraph/shareables.ts`'s loadHiddenGem SELECTED sensitivity_level
// and never looked at it — it checked `merged_into` and `status !== "active"`
// and stopped. Selecting a column and ignoring it is the tell.
//
// It is not protected by RLS either, and this one is easy to get wrong: the
// route reads `const { client } = await requireUser(...)`, which LOOKS
// user-scoped. It is not. lib/http.ts:272's requireUser verifies the bearer
// token and then hands back `getServiceClient()` — the identity is the caller's,
// the privileges are the service role's. So migration 0043's
// hidden_gems_public_read does not apply here, and a `protected` gem could be
// shared into a thread by name, neighbourhood and city, with a /gems/:id link.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveShareProjections } from "../services/telegraph/shareables.js";

const THREAD = "f0000000-0000-4000-a000-0000000000cc";

function shareClient(gems: Record<string, any>[]) {
  const db: Record<string, Record<string, any>[]> = {
    hidden_gems: gems,
    message_thread_members: [{ thread_id: THREAD, user_id: VIEWER, left_at: null }],
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const target: any = {
      select() { return proxy; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return proxy; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return proxy; },
      in(c: string, v: any[]) { filters.push((r) => v.map(String).includes(String(r[c]))); return proxy; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      limit() { return proxy; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      then(res: any, rej?: any) { return Promise.resolve({ data: rowsNow(), error: null }).then(res, rej); },
    };
    const proxy: any = new Proxy(target, {
      get(t, p) {
        if (p in t) return t[p as string];
        if (p === "catch" || p === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return { from } as any;
}

async function shareState(gem: Record<string, any>) {
  const [r] = await resolveShareProjections(
    shareClient([gem]), VIEWER, THREAD, [{ objectType: "HIDDEN_GEM" as any, objectId: gem.id }],
  );
  return r as any;
}

describe("Telegraph share — hidden gem identity disclosure (migration 0043)", () => {
  it("POSITIVE CONTROL — an active, public gem IS shareable", async () => {
    const r = await shareState(gemRow("share-public"));
    assert.equal(r?.available, true,
      `a public active gem must stay shareable; got ${JSON.stringify(r)}`);
    assert.ok(r?.projection, "a shareable gem must carry a projection");
  });

  for (const level of NON_PUBLIC) {
    it(`refuses to share a gem whose sensitivity_level is ${level}`, async () => {
      const r = await shareState(gemRow(`share-${level}`, { sensitivity_level: level }));
      assert.equal(r?.available, false,
        `a ${level} gem must not be reported available`);
      assert.equal(r?.projection, null,
        `a ${level} gem must not be projected into a thread`);
    });
  }

  it("the SUBMITTER cannot share their own protected gem either", async () => {
    // A deliberate narrowing of mayDiscloseGemIdentity's owner bypass, and the
    // reason is that the bypass answers the wrong question here. It asks "may
    // THIS VIEWER be told the gem exists", and for the submitter the answer is
    // yes — they wrote it. But a share does not disclose to the sharer; it
    // discloses to everyone else in the thread, none of whom has earned a
    // reveal_after_save gem or may ever see a protected one. So this surface
    // passes `null` and keeps the bypass out of it.
    const r = await shareState(gemRow("share-mine", { sensitivity_level: "protected", submitted_by: VIEWER }));
    assert.equal(r?.projection, null,
      "sharing discloses to the thread, not to the sharer — the owner bypass must not apply here");
  });
});
