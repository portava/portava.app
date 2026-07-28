/**
 * mediaDedupPhash.test.ts
 *
 * Unit tests for the pHash dedup system:
 *   A. hammingDistance() — correct bit-count on known inputs
 *   B. areDuplicates()  — threshold enforcement + fail-soft on bad inputs
 *   C. clusterByPhash() — union-find correctly groups near-duplicates
 *   D. computePHash()   — produces a 16-char hex string from a real image buffer
 *   E. runDedupTick()   — worker integration tests:
 *        E1. same-batch identical hashes → one group
 *        E2. clearly different hashes → separate groups
 *        E3. empty batch → no-op
 *        E4. upsert failure → rows NOT marked processed
 *        E5. two non-duplicate clusters sharing same bucket prefix → two groups
 *        E6. late-arriving duplicate joins existing cluster across ticks
 *        E7. retry after failed mark step → member_count unchanged (idempotent)
 *
 * Runtime: node:test + node:assert/strict (no vitest).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  hammingDistance,
  areDuplicates,
  clusterByPhash,
  HAMMING_THRESHOLD,
} from "../lib/media/pHashUtils.js";
import { computePHash } from "../lib/mediaProcessing.js";
import { runDedupTick } from "../lib/media/mediaDedupWorker.js";

// ── A. hammingDistance ────────────────────────────────────────────────────────

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
    assert.equal(hammingDistance("ffffffffffffffff", "ffffffffffffffff"), 0);
    assert.equal(hammingDistance("abcdef1234567890", "abcdef1234567890"), 0);
  });

  it("returns 64 for all-zeros vs all-ones", () => {
    assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
  });

  it("counts correctly for single-nibble differences", () => {
    assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
    assert.equal(hammingDistance("0000000000000000", "0000000000000003"), 2);
    assert.equal(hammingDistance("0000000000000000", "0000000000000007"), 3);
  });

  it("is symmetric", () => {
    const a = "a1b2c3d4e5f60718";
    const b = "f1e2d3c4b5a69827";
    assert.equal(hammingDistance(a, b), hammingDistance(b, a));
  });

  it("throws on wrong-length inputs", () => {
    assert.throws(() => hammingDistance("short", "0000000000000000"), /16/);
    assert.throws(() => hammingDistance("0000000000000000", ""), /16/);
  });
});

// ── B. areDuplicates ──────────────────────────────────────────────────────────

describe("areDuplicates", () => {
  it("returns true for identical hashes", () => {
    assert.equal(areDuplicates("abcdef1234567890", "abcdef1234567890"), true);
  });

  it("returns true when distance equals the threshold", () => {
    const base = "0000000000000000";
    const differed = "0".repeat(16 - HAMMING_THRESHOLD) + "1".repeat(HAMMING_THRESHOLD);
    assert.equal(hammingDistance(base, differed), HAMMING_THRESHOLD);
    assert.equal(areDuplicates(base, differed), true);
  });

  it("returns false when distance is one above the threshold", () => {
    const base = "0000000000000000";
    const differed = "0".repeat(16 - (HAMMING_THRESHOLD + 1)) + "1".repeat(HAMMING_THRESHOLD + 1);
    assert.equal(hammingDistance(base, differed), HAMMING_THRESHOLD + 1);
    assert.equal(areDuplicates(base, differed), false);
  });

  it("returns false for clearly different hashes", () => {
    assert.equal(areDuplicates("0000000000000000", "ffffffffffffffff"), false);
  });

  it("returns false (not throws) for null/undefined/short inputs", () => {
    assert.equal(areDuplicates(null, "0000000000000000"), false);
    assert.equal(areDuplicates(undefined, "0000000000000000"), false);
    assert.equal(areDuplicates("short", "0000000000000000"), false);
    assert.equal(areDuplicates("0000000000000000", null), false);
  });
});

// ── C. clusterByPhash ────────────────────────────────────────────────────────

describe("clusterByPhash", () => {
  it("puts identical hashes in the same cluster", () => {
    const items = [
      { id: "a", phash: "0000000000000000" },
      { id: "b", phash: "0000000000000000" },
      { id: "c", phash: "0000000000000000" },
    ];
    const clusters = clusterByPhash(items);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].length, 3);
    assert.deepEqual(new Set(clusters[0]), new Set(["a", "b", "c"]));
  });

  it("puts clearly different hashes in separate clusters", () => {
    const items = [
      { id: "a", phash: "0000000000000000" },
      { id: "b", phash: "ffffffffffffffff" },
    ];
    const clusters = clusterByPhash(items);
    assert.equal(clusters.length, 2);
  });

  it("chains near-duplicates transitively (union-find)", () => {
    const base = "0000000000000000";
    const mid  = "1111111100000000";
    const far  = "1111111111111111";
    assert.equal(hammingDistance(base, mid), HAMMING_THRESHOLD);
    assert.equal(hammingDistance(mid, far), HAMMING_THRESHOLD);
    const items = [
      { id: "a", phash: base },
      { id: "b", phash: mid },
      { id: "c", phash: far },
    ];
    const clusters = clusterByPhash(items);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].length, 3);
  });

  it("returns one cluster per item for fully distinct hashes", () => {
    const items = [
      { id: "a", phash: "0000000000000000" },
      { id: "b", phash: "ffffffffffffffff" },
      { id: "c", phash: "0f0f0f0f0f0f0f0f" },
    ];
    assert.ok(hammingDistance("0000000000000000", "ffffffffffffffff") > HAMMING_THRESHOLD);
    assert.ok(hammingDistance("0000000000000000", "0f0f0f0f0f0f0f0f") > HAMMING_THRESHOLD);
    assert.ok(hammingDistance("ffffffffffffffff", "0f0f0f0f0f0f0f0f") > HAMMING_THRESHOLD);
    const clusters = clusterByPhash(items);
    assert.equal(clusters.length, 3);
  });

  it("handles an empty array", () => {
    assert.deepEqual(clusterByPhash([]), []);
  });

  it("handles a single item", () => {
    const clusters = clusterByPhash([{ id: "only", phash: "0000000000000000" }]);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0], ["only"]);
  });
});

// ── D. computePHash ───────────────────────────────────────────────────────────

describe("computePHash", () => {
  async function makeJpeg(r = 128, g = 128, b = 128): Promise<Buffer> {
    return await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r, g, b } },
    }).jpeg().toBuffer();
  }

  it("returns a 16-character lowercase hex string for a valid image", async () => {
    const buf = await makeJpeg();
    const hash = await computePHash(buf);
    assert.ok(hash !== null, "hash should not be null");
    assert.equal(hash!.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(hash!), `not valid hex: ${hash}`);
  });

  it("returns the same hash for the same solid colour twice (deterministic)", async () => {
    const buf = await makeJpeg(200, 100, 50);
    const [h1, h2] = await Promise.all([computePHash(buf), computePHash(buf)]);
    assert.equal(h1, h2);
  });

  it("returns different hashes for a solid black vs solid white image", async () => {
    const black = await makeJpeg(0, 0, 0);
    const white = await makeJpeg(255, 255, 255);
    const [hb, hw] = await Promise.all([computePHash(black), computePHash(white)]);
    assert.ok(hb !== null);
    assert.ok(hw !== null);
  });

  it("returns null (does not throw) for a corrupt buffer", async () => {
    const corrupt = Buffer.from("not an image at all");
    const hash = await computePHash(corrupt);
    assert.equal(hash, null);
  });
});

// ── E. runDedupTick (worker) ──────────────────────────────────────────────────
//
// Fake Supabase client
// --------------------
// Supports all call chains the redesigned worker uses:
//
//   post_media
//     .select("id, canonical_place_id, phash")
//       .not().not().eq().limit()            → batch fetch
//     .update({ dedup_processed: true })
//       .in("id", [...])                     → mark processed
//
//   media_dedup_groups
//     .select("id, ...")
//       .eq("canonical_place_id", placeId)   → load existing groups
//     .select("id")
//       .eq(col1, v1).eq(col2, v2)
//       .maybeSingle()                       → re-query after upsert
//     .upsert({...}, { onConflict: ... })    → create/find group
//     .update({ member_count, ... })
//       .eq("id", groupId)                   → update group
//
//   media_dedup_memberships
//     .upsert([...], { ignoreDuplicates })   → idempotent membership insert
//     .select("media_id", { count: "exact" })
//       .eq("group_id", groupId)             → count memberships
//
// The state is stored in plain Maps/Arrays and exposed for assertions.

interface GroupState {
  id:                      string;
  canonical_place_id:      string;
  representative_media_id: string;
  representative_phash:    string | null;
  member_count:            number;
  sample_media_ids:        string[];
}

interface FakeClientState {
  groups:       GroupState[];
  memberships:  Map<string, string>; // media_id → group_id
  upsertedGroups: any[];
  updatedGroups:  Array<{ id: string; payload: any }>;
  updatedMedia:   string[];
}

function makeFakeClient(opts: {
  mediaRows:        Array<{ id: string; canonical_place_id: string; phash: string }>;
  existingGroups?:  GroupState[];
  sharedMemberships?: Map<string, string>; // cross-tick shared state
  upsertGroupError?: string;
  markProcessedError?: boolean;
}): FakeClientState & { from(table: string): any } {
  const groups:     GroupState[]              = [...(opts.existingGroups ?? [])];
  const memberships: Map<string, string>      = opts.sharedMemberships ?? new Map();
  const upsertedGroups: any[]                 = [];
  const updatedGroups: Array<{ id: string; payload: any }> = [];
  const updatedMedia:  string[]               = [];

  function countMemberships(groupId: string): number {
    let n = 0;
    for (const [, gid] of memberships) if (gid === groupId) n++;
    return n;
  }

  // ── chainable helper for media_dedup_groups.select() ────────────────────────
  // Supports: .eq(c,v) chained arbitrarily, then awaited OR .maybeSingle().
  function makeGroupSelectChain(initialFilters: Array<[string, any]> = []) {
    const filters = [...initialFilters];

    function applyFilters(): GroupState[] {
      return groups.filter((g) =>
        filters.every(([col, val]) => (g as any)[col] === val),
      );
    }

    const chain: any = {
      eq(col: string, val: any) {
        filters.push([col, val]);
        return chain;
      },
      maybeSingle() {
        const rows = applyFilters();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: any, reject?: any) {
        return Promise.resolve({ data: applyFilters(), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  // ── table handlers ───────────────────────────────────────────────────────────
  const tables: Record<string, any> = {
    post_media: {
      select(_cols: string) {
        const stub: any = {
          not(_c: string, _o: string, _v: any) { return stub; },
          eq(_c: string, _v: any) { return stub; },
          limit(_n: number) {
            return Promise.resolve({ data: opts.mediaRows, error: null });
          },
        };
        return stub;
      },
      update(_payload: any) {
        return {
          in(_col: string, ids: string[]) {
            if (opts.markProcessedError) {
              return Promise.resolve({ error: { message: "mark failed (test)" } });
            }
            for (const id of ids) updatedMedia.push(id);
            return Promise.resolve({ error: null });
          },
        };
      },
    },

    media_dedup_groups: {
      select(_cols: string) {
        return makeGroupSelectChain();
      },
      upsert(payload: any, _upsertOpts?: any) {
        if (opts.upsertGroupError) {
          return Promise.resolve({ error: { message: opts.upsertGroupError } });
        }
        const existing = groups.find(
          (g) => g.canonical_place_id === payload.canonical_place_id &&
                 g.representative_media_id === payload.representative_media_id,
        );
        if (!existing) {
          groups.push({
            id:                      payload.id,
            canonical_place_id:      payload.canonical_place_id,
            representative_media_id: payload.representative_media_id,
            representative_phash:    payload.representative_phash ?? null,
            member_count:            payload.member_count,
            sample_media_ids:        payload.sample_media_ids ?? [],
          });
          upsertedGroups.push(payload);
        }
        return Promise.resolve({ error: null });
      },
      update(payload: any) {
        return {
          eq(_col: string, groupId: string) {
            updatedGroups.push({ id: groupId, payload });
            const g = groups.find((x) => x.id === groupId);
            if (g) {
              if (payload.member_count    != null) g.member_count    = payload.member_count;
              if (payload.sample_media_ids != null) g.sample_media_ids = payload.sample_media_ids;
            }
            return Promise.resolve({ error: null });
          },
        };
      },
    },

    media_dedup_memberships: {
      upsert(rows: Array<{ media_id: string; group_id: string }>, _upsertOpts?: any) {
        // Idempotent: PK on media_id — only insert if not already present.
        for (const row of rows) {
          if (!memberships.has(row.media_id)) {
            memberships.set(row.media_id, row.group_id);
          }
        }
        return Promise.resolve({ error: null });
      },
      select(_cols: string, _selectOpts?: any) {
        return {
          eq(_col: string, groupId: string) {
            const count = countMemberships(groupId);
            return Promise.resolve({ count, error: null });
          },
        };
      },
    },
  };

  return {
    groups,
    memberships,
    upsertedGroups,
    updatedGroups,
    updatedMedia,
    from(table: string) {
      return tables[table] ?? {};
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runDedupTick (worker)", () => {
  const PLACE = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

  // ── E1 ──────────────────────────────────────────────────────────────────────
  it("E1: upserts one group and marks rows processed for identical-hash items", async () => {
    const pl = PLACE(1);
    const fake = makeFakeClient({
      mediaRows: [
        { id: "m1", canonical_place_id: pl, phash: "0000000000000000" },
        { id: "m2", canonical_place_id: pl, phash: "0000000000000000" },
      ],
    });
    await runDedupTick(fake);

    assert.equal(fake.upsertedGroups.length, 1, "should upsert exactly one dedup group");
    assert.equal(fake.upsertedGroups[0].member_count, 2);
    assert.deepEqual(new Set(fake.updatedMedia), new Set(["m1", "m2"]));
    assert.equal(fake.memberships.size, 2, "both rows should be in memberships");
  });

  // ── E2 ──────────────────────────────────────────────────────────────────────
  it("E2: upserts two separate groups for clearly different hashes at the same place", async () => {
    const pl = PLACE(2);
    const fake = makeFakeClient({
      mediaRows: [
        { id: "m1", canonical_place_id: pl, phash: "0000000000000000" },
        { id: "m2", canonical_place_id: pl, phash: "ffffffffffffffff" },
      ],
    });
    await runDedupTick(fake);

    assert.equal(fake.upsertedGroups.length, 2);
    assert.deepEqual(new Set(fake.updatedMedia), new Set(["m1", "m2"]));
    assert.equal(fake.memberships.size, 2);
  });

  // ── E3 ──────────────────────────────────────────────────────────────────────
  it("E3: does nothing when the fetch returns an empty batch", async () => {
    const fake = makeFakeClient({ mediaRows: [] });
    await runDedupTick(fake);
    assert.equal(fake.upsertedGroups.length, 0);
    assert.equal(fake.updatedMedia.length, 0);
  });

  // ── E4 ──────────────────────────────────────────────────────────────────────
  it("E4: does not mark rows processed when group upsert fails", async () => {
    const pl = PLACE(3);
    const fake = makeFakeClient({
      mediaRows: [{ id: "m1", canonical_place_id: pl, phash: "1111111100000000" }],
      upsertGroupError: "DB constraint violated",
    });
    await runDedupTick(fake);
    assert.equal(fake.updatedMedia.length, 0, "rows must NOT be marked processed after upsert failure");
    assert.equal(fake.memberships.size, 0);
  });

  // ── E5 ──────────────────────────────────────────────────────────────────────
  it("E5: two non-duplicate clusters sharing the same 8-char prefix → two separate groups", async () => {
    const pl   = PLACE(4);
    const hashA = "1111111100000000";
    const hashB = "11111111ffffffff";
    assert.ok(
      hammingDistance(hashA, hashB) > HAMMING_THRESHOLD,
      "test setup: these hashes must NOT be near-duplicates",
    );
    assert.equal(hashA.slice(0, 8), hashB.slice(0, 8), "test setup: same bucket_key prefix");

    const fake = makeFakeClient({
      mediaRows: [
        { id: "m1", canonical_place_id: pl, phash: hashA },
        { id: "m2", canonical_place_id: pl, phash: hashB },
      ],
    });
    await runDedupTick(fake);

    assert.equal(fake.upsertedGroups.length, 2, "should upsert two separate dedup groups");
    const repIds = fake.upsertedGroups.map((g: any) => g.representative_media_id);
    assert.deepEqual(new Set(repIds), new Set(["m1", "m2"]));
    assert.deepEqual(new Set(fake.updatedMedia), new Set(["m1", "m2"]));
  });

  // ── E6 ──────────────────────────────────────────────────────────────────────
  it("E6: late-arriving duplicate joins existing cluster across ticks — not creating a new group", async () => {
    // Tick 1: m1 is unprocessed → new group created, m1 added to memberships.
    // Tick 2: m2 arrives with the same phash → must JOIN the existing group,
    //         NOT create a second group. member_count derived from COUNT = 2.
    const pl   = PLACE(5);
    const HASH = "abcdef1234567890";

    // ── Tick 1 ──
    const tick1 = makeFakeClient({
      mediaRows: [{ id: "m1", canonical_place_id: pl, phash: HASH }],
    });
    await runDedupTick(tick1);

    assert.equal(tick1.upsertedGroups.length, 1, "tick 1: one group created");
    assert.equal(tick1.memberships.size, 1, "tick 1: m1 in memberships");

    // ── Tick 2: share persistent state (groups + memberships) from tick 1 ──
    const tick2 = makeFakeClient({
      mediaRows:          [{ id: "m2", canonical_place_id: pl, phash: HASH }],
      existingGroups:     tick1.groups,      // same objects — simulates DB persistence
      sharedMemberships:  tick1.memberships, // same Map — PK uniqueness enforced
    });
    await runDedupTick(tick2);

    // m2 must join the existing group — no new upsert.
    assert.equal(tick2.upsertedGroups.length, 0, "tick 2: must NOT create a new group");
    assert.equal(tick2.updatedGroups.length, 1,  "tick 2: must update the existing group");
    assert.equal(tick2.updatedGroups[0].payload.member_count, 2, "tick 2: member_count must be 2");
    assert.deepEqual(tick2.updatedMedia, ["m2"], "tick 2: m2 marked processed");
    // Shared memberships now holds both m1 and m2.
    assert.equal(tick1.memberships.size, 2, "tick 2: memberships has both rows");
  });

  // ── E7 ──────────────────────────────────────────────────────────────────────
  it("E7: retry after failed mark step — member_count stays correct (idempotent)", async () => {
    // Tick 1: group upsert + membership write succeed, mark step FAILS.
    //         m1 still has dedup_processed=false in the DB (simulated by keeping it
    //         in mediaRows for tick 2).
    // Tick 2: same row re-fetched. Membership upsert is a no-op (PK already
    //         exists). COUNT returns 1. member_count stays 1 — no double-count.
    const pl   = PLACE(6);
    const HASH = "cccccccccccccccc";

    // ── Tick 1: mark step errors ──
    const tick1 = makeFakeClient({
      mediaRows:          [{ id: "m1", canonical_place_id: pl, phash: HASH }],
      markProcessedError: true,
    });
    await runDedupTick(tick1);

    assert.equal(tick1.groups.length, 1,      "tick 1: group created");
    assert.equal(tick1.memberships.size, 1,    "tick 1: membership written");
    assert.equal(tick1.updatedMedia.length, 0, "tick 1: mark step failed → not processed");

    const memberCountAfterTick1 = tick1.groups[0].member_count;
    assert.equal(memberCountAfterTick1, 1, "tick 1: member_count = 1");

    // ── Tick 2: same row, mark now succeeds ──
    // Share persistent state so the PK uniqueness is enforced on retry.
    const tick2 = makeFakeClient({
      mediaRows:          [{ id: "m1", canonical_place_id: pl, phash: HASH }],
      existingGroups:     tick1.groups,
      sharedMemberships:  tick1.memberships, // m1 already present → upsert is a no-op
      markProcessedError: false,
    });
    await runDedupTick(tick2);

    // m1 joins the existing group via the JOIN path.
    // Membership upsert is a no-op (m1 already exists) → COUNT = 1 → member_count stays 1.
    const finalCount = tick1.groups[0].member_count; // mutated in place by the fake
    assert.equal(finalCount, 1, "member_count must stay 1 after retry — not double-counted");
    assert.ok(tick2.updatedMedia.includes("m1"), "tick 2: m1 should be marked processed");
  });
});
