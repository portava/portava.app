/**
 * Section 15 - memory retrieval and search.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 15 (:431), section 18 (:512), 28.6.
 * CENSUS: H110-H114 - all NOT-BUILT. "There is no Memory search of any kind."
 *
 * THE THREE CLAIMS UNDER TEST, and how each could be faked:
 *
 *   * Namespace isolation. A search that returned nothing for a cross-namespace
 *     request would look identical to one that refused. So the illegal request
 *     is asserted to REFUSE with a named reason, and is PAIRED with the legal
 *     request over the same fixture returning rows.
 *   * Deterministic before semantic. A pipeline that ran semantic search first
 *     and filtered afterwards would pass a "the right rows came back" test. So
 *     the assertions compare the semantic result set against the deterministic
 *     one and require them to be the same SET in a different ORDER.
 *   * Revocation. An empty result and a revoked index are different answers, and
 *     the test requires the second to be a refusal carrying that reason.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryRetrievalSearch.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DERIVATIVE_REGISTRY_TABLE,
  rebuildProjection,
  revokeDerivativesForMemory,
  type ClientLike,
} from "../services/memoryProjections/derivativeRegistry.js";
import type { MemorySourceRow, ProjectionId } from "../services/memoryProjections/projectionRegistry.js";
import { scoreSignificance } from "../services/memoryProjections/significance.js";
import {
  NAMESPACE_PROJECTIONS,
  RANKING_WEIGHTS,
  searchMemories,
  type RetrievalNamespace,
} from "../services/memoryRetrieval/searchMemories.js";

const OWNER = "77777777-7777-4777-8777-777777777777";
const FRIEND = "88888888-8888-4888-8888-888888888888";
const TRIP = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function memory(over: Partial<MemorySourceRow> & { id: string }): MemorySourceRow {
  return {
    owner_id: OWNER, title: null, caption: null, visibility: "public", state: "published",
    trip_id: null, event_id: null, place_id: null,
    starts_at: "2026-05-01T12:00:00.000Z", ends_at: null,
    created_at: "2026-05-01T12:00:00.000Z", updated_at: "2026-05-01T12:00:00.000Z",
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    canonical_location_id: null, allowed_user_ids: [], hidden_user_ids: [],
    ...over,
  };
}

type Tables = Record<string, any[]>;

function fixture(): Tables {
  return {
    memories: [
      memory({ id: "sushi", title: "That sushi place", caption: "tiny counter in Shibuya", place_id: "place-sushi", location_city: "Tokyo", location_country: "Japan", trip_id: TRIP, starts_at: "2026-01-10T12:00:00.000Z" }),
      memory({ id: "ramen", title: "Ramen at midnight", caption: "queue around the block", place_id: "place-ramen", location_city: "Tokyo", location_country: "Japan", trip_id: TRIP, starts_at: "2026-01-11T15:00:00.000Z" }),
      memory({ id: "bangkok", title: "Rooftop in Bangkok", place_id: "place-roof", location_city: "Bangkok", location_country: "Thailand", starts_at: "2026-03-02T12:00:00.000Z" }),
      memory({ id: "private", title: "Not for anyone", visibility: "only_me", location_city: "Tokyo", starts_at: "2026-01-12T12:00:00.000Z" }),
    ],
    memory_items: [],
    memory_tags: [
      { memory_id: "sushi", tagged_user_id: FRIEND, status: "approved" },
      { memory_id: "bangkok", tagged_user_id: FRIEND, status: "approved" },
    ],
    [DERIVATIVE_REGISTRY_TABLE]: [],
  };
}

function makeClient(tables: Tables, opts: { failTables?: Set<string> } = {}): ClientLike {
  const fail = opts.failTables ?? new Set<string>();
  function chain(table: string): any {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "upsert" | "update" = "select";
    let payload: any = null;
    let onConflict: string[] = [];
    let selected = false;
    const obj: any = {
      select() { selected = true; return obj; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: readonly unknown[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      upsert(v: any, o?: { onConflict?: string }) { mode = "upsert"; payload = v; onConflict = (o?.onConflict ?? "").split(",").filter(Boolean); return obj; },
      update(v: any) { mode = "update"; payload = v; return obj; },
      then(f: any, r: any) { return run().then(f, r); },
    };
    async function run(): Promise<{ data: any; error: any }> {
      // supabase-js resolves on a database error; it does not throw.
      if (fail.has(table)) return { data: null, error: { code: "57014", message: `${table} unavailable` } };
      const rows: any[] = (tables[table] ??= []);
      if (mode === "upsert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const written: any[] = [];
        for (const row of incoming) {
          const idx = onConflict.length > 0 ? rows.findIndex((r) => onConflict.every((k) => r[k] === row[k])) : -1;
          if (idx >= 0) { rows[idx] = { ...rows[idx], ...row }; written.push(rows[idx]); }
          else { const stored = { id: `reg-${rows.length + 1}`, ...row }; rows.push(stored); written.push(stored); }
        }
        return { data: selected ? written : null, error: null };
      }
      if (mode === "update") {
        const hit = rows.filter((r) => filters.every((fn) => fn(r)));
        for (const r of hit) Object.assign(r, payload);
        return { data: selected ? hit : null, error: null };
      }
      return { data: rows.filter((r) => filters.every((fn) => fn(r))), error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t) };
}

async function seeded(tables: Tables = fixture()): Promise<ClientLike> {
  const client = makeClient(tables);
  const sig = new Map([["sushi", scoreSignificance({ user_created: true, first_time_experience: true })]]);
  const built = await Promise.all([
    rebuildProjection(client, "PublicMemoryProjection", { owner_id: OWNER }, NOW),
    rebuildProjection(client, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER }, NOW, { significance: sig }),
    rebuildProjection(client, "TripMemoryProjection", { owner_id: OWNER, trip_id: TRIP }, NOW),
    rebuildProjection(client, "PeopleMemoryProjection", { owner_id: OWNER, person_id: FRIEND }, NOW),
  ]);
  for (const b of built) assert.ok(b.ok, `fixture rebuild failed: ${JSON.stringify(b)}`);
  return client;
}

const hitIds = (r: Awaited<ReturnType<typeof searchMemories>>) =>
  r.ok ? r.value.hits.map((h) => h.memory_id) : [];

describe("section 15: hard namespace isolation", () => {
  it("PAIRED CONTROL - the public namespace reading the public derivative returns rows", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(hitIds(r).sort(), ["bangkok", "ramen", "sushi"]);
    assert.ok(!hitIds(r).includes("private"), "the only_me memory is not in the public derivative at all");
  });

  it("the public namespace cannot read an owner-private projection, and is refused by name", async () => {
    const client = await seeded();
    for (const id of ["MemoryTimelineProjection", "MapTrailDerivative", "CompassMemoryProjection", "PeopleMemoryProjection"] as ProjectionId[]) {
      const r = await searchMemories(client, {
        ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC", authorizedProjection: id, now: NOW,
      });
      assert.equal(r.ok, false, `PUBLIC was served ${id}`);
      if (!r.ok) {
        assert.equal(r.reason, "projection_not_in_namespace");
        assert.ok(r.detail.includes("PublicMemoryProjection"), "the refusal names what IS allowed");
      }
    }
  });

  it("the private namespace is refused to anyone but the owner", async () => {
    const client = await seeded();
    const stranger = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", now: NOW,
    });
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.reason, "namespace_violation");

    const owner = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", now: NOW,
    });
    assert.ok(owner.ok, JSON.stringify(owner));
    assert.ok(hitIds(owner).includes("private"), "the owner does see their private memory");
  });

  it("the namespace table is a closed allow-list, not a suggestion", () => {
    const all = new Set<ProjectionId>();
    for (const ns of Object.keys(NAMESPACE_PROJECTIONS) as RetrievalNamespace[]) {
      for (const id of NAMESPACE_PROJECTIONS[ns]) all.add(id);
    }
    assert.deepEqual([...NAMESPACE_PROJECTIONS.PUBLIC], ["PublicMemoryProjection"]);
    assert.ok(!all.has("SearchEmbedding"), "an unbuilt index is in no namespace");
    assert.ok(!NAMESPACE_PROJECTIONS.SHARED_CREW.includes("MemoryTimelineProjection"));
  });

  it("the shared-crew namespace serves trip and people history and nothing else", async () => {
    const client = await seeded();
    const trip = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "SHARED_CREW",
      authorizedProjection: "TripMemoryProjection", scope: { trip_id: TRIP }, now: NOW,
    });
    assert.ok(trip.ok, JSON.stringify(trip));
    assert.deepEqual(hitIds(trip).sort(), ["ramen", "sushi"]);

    const people = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "SHARED_CREW",
      authorizedProjection: "PeopleMemoryProjection", scope: { person_id: FRIEND }, now: NOW,
    });
    assert.ok(people.ok, JSON.stringify(people));
    assert.deepEqual(hitIds(people).sort(), ["bangkok", "sushi"]);

    const leak = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "SHARED_CREW",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.equal(leak.ok, false);
  });
});

describe("section 15: a filter the derivative cannot answer is refused, not ignored", () => {
  it("the trip recap has no trip_id field to filter on, and says so instead of returning everything", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "SHARED_CREW",
      authorizedProjection: "TripMemoryProjection", scope: { trip_id: TRIP }, trip: TRIP, now: NOW,
    });
    assert.equal(r.ok, false, "an unanswerable filter must not be dropped on the floor");
    if (!r.ok) {
      assert.equal(r.reason, "filter_not_supported_by_projection");
      assert.ok(r.detail.includes("trip"));
    }
  });

  it("the public derivative cannot answer 'who was there'", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", people: [FRIEND], now: NOW,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "filter_not_supported_by_projection");
  });

  it("PAIRED - the owner's timeline CAN answer both, so the refusals above are about the derivative", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", trip: TRIP, people: [FRIEND], now: NOW,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(hitIds(r), ["sushi"]);
  });
});

describe("section 15: a missing or revoked derivative is a refusal, not an empty page", () => {
  it("a derivative nobody has built refuses rather than answering 'no memories'", async () => {
    const client = makeClient(fixture()); // nothing rebuilt
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "derivative_unavailable");
  });

  it("an unreadable registry refuses retryably", async () => {
    const tables = fixture();
    await seeded(tables);
    const broken = makeClient(tables, { failTables: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    const r = await searchMemories(broken, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "derivative_unavailable");
      assert.equal(r.retryable, true);
    }
  });

  it("H114 - revoking a memory takes the public index out of service and says so", async () => {
    const tables = fixture();
    const client = await seeded(tables);
    const before = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.ok(before.ok && before.value.hits.length > 0, "control: searchable before the privacy change");

    const rev = await revokeDerivativesForMemory(client, "sushi", "owner made it private", NOW);
    assert.ok(rev.ok && rev.value.revoked > 0, JSON.stringify(rev));

    const after = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.equal(after.ok, false, "a revoked index must not keep serving");
    if (!after.ok) assert.equal(after.reason, "derivative_revoked");
  });
});

describe("section 15: deterministic filters decide membership, semantics only reorders", () => {
  it("filters select by date range, trip, place and people", async () => {
    const client = await seeded();
    const base = { ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL" as const, authorizedProjection: "MemoryTimelineProjection" as ProjectionId, now: NOW };

    const january = await searchMemories(client, { ...base, dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-31T23:59:59Z" } });
    assert.ok(january.ok);
    assert.deepEqual(hitIds(january).sort(), ["private", "ramen", "sushi"]);

    const byTrip = await searchMemories(client, { ...base, trip: TRIP });
    assert.deepEqual(hitIds(byTrip).sort(), ["ramen", "sushi"]);

    const byPlace = await searchMemories(client, { ...base, place: "place-ramen" });
    assert.deepEqual(hitIds(byPlace), ["ramen"]);

    const byCity = await searchMemories(client, { ...base, place: "Bangkok" });
    assert.deepEqual(hitIds(byCity), ["bangkok"]);

    const withFriend = await searchMemories(client, { ...base, people: [FRIEND] });
    assert.deepEqual(hitIds(withFriend).sort(), ["bangkok", "sushi"]);

    const withNobody = await searchMemories(client, { ...base, people: ["someone-who-was-not-there"] });
    assert.ok(withNobody.ok);
    assert.deepEqual(hitIds(withNobody), [], "an honest empty: the filter ran and matched nothing");
    assert.equal(withNobody.value.deterministic_match_count, 0);
  });

  it("a semantic query reorders the deterministic set without adding to it", async () => {
    const client = await seeded();
    const base = { ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL" as const, authorizedProjection: "MemoryTimelineProjection" as ProjectionId, now: NOW };

    const plain = await searchMemories(client, { ...base, trip: TRIP });
    const semantic = await searchMemories(client, { ...base, trip: TRIP, semanticQuery: "sushi counter shibuya" });
    assert.ok(plain.ok && semantic.ok);
    assert.deepEqual(hitIds(semantic).slice().sort(), hitIds(plain).slice().sort(), "the same SET");
    assert.equal(semantic.value.deterministic_match_count, plain.value.deterministic_match_count);
    assert.equal(hitIds(semantic)[0], "sushi", "and a different ORDER");
    assert.equal(semantic.value.semantic_rerank_applied, true);
    assert.equal(plain.value.semantic_rerank_applied, false);
  });

  it("a scorer that loves everything cannot widen the result set", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", place: "place-ramen",
      semanticQuery: "anything at all", semanticScorer: () => 1, now: NOW,
    });
    assert.ok(r.ok);
    assert.deepEqual(hitIds(r), ["ramen"]);
    assert.equal(r.value.deterministic_match_count, 1);
  });

  it("the semantic path calls no model: the default scorer is deterministic token overlap", async () => {
    const client = await seeded();
    const once = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", semanticQuery: "tokyo ramen midnight", now: NOW,
    });
    const twice = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", semanticQuery: "tokyo ramen midnight", now: NOW,
    });
    assert.ok(once.ok && twice.ok);
    assert.deepEqual(once.value.hits.map((h) => [h.memory_id, h.score]), twice.value.hits.map((h) => [h.memory_id, h.score]));
  });

  it("a limit truncates the ranking without changing what matched", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", limit: 2, now: NOW,
    });
    assert.ok(r.ok);
    assert.equal(r.value.hits.length, 2);
    assert.equal(r.value.deterministic_match_count, 4, "the caller can still tell how many matched");
  });
});

describe("section 15: ranking dimensions are reported, not asserted", () => {
  it("every hit carries all seven dimensions and a score that is their weighted sum", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", semanticQuery: "tokyo", now: NOW,
    });
    assert.ok(r.ok);
    for (const hit of r.value.hits) {
      assert.deepEqual(Object.keys(hit.dimensions).sort(), [
        "confidence", "explicit_significance", "person_relevance", "privacy_eligibility",
        "semantic_relevance", "spatial_relevance", "temporal_relevance",
      ]);
      const expected =
        hit.dimensions.semantic_relevance * RANKING_WEIGHTS.semantic_relevance +
        hit.dimensions.temporal_relevance * RANKING_WEIGHTS.temporal_relevance +
        hit.dimensions.spatial_relevance * RANKING_WEIGHTS.spatial_relevance +
        hit.dimensions.person_relevance * RANKING_WEIGHTS.person_relevance +
        hit.dimensions.explicit_significance * RANKING_WEIGHTS.explicit_significance +
        hit.dimensions.confidence * RANKING_WEIGHTS.confidence;
      assert.ok(Math.abs(expected - hit.score) < 1e-5, `${hit.memory_id}: ${expected} vs ${hit.score}`);
    }
  });

  it("significance ranks the owner's own results and is absent from public ones", async () => {
    const client = await seeded();
    const owner = await searchMemories(client, {
      ownerId: OWNER, viewerId: OWNER, namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", now: NOW,
    });
    assert.ok(owner.ok);
    const sushi = owner.value.hits.find((h) => h.memory_id === "sushi");
    assert.ok(sushi && sushi.dimensions.explicit_significance > 0, "the owner's scored memory ranks on it");

    const pub = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.ok(pub.ok);
    for (const hit of pub.value.hits) {
      assert.equal(hit.dimensions.explicit_significance, 0, "a public row carries no significance to rank on");
      assert.equal("significance_score" in hit.row, false);
    }
  });

  it("recency ranks above age when nothing else separates two rows", async () => {
    const client = await seeded();
    const r = await searchMemories(client, {
      ownerId: OWNER, viewerId: FRIEND, namespace: "PUBLIC",
      authorizedProjection: "PublicMemoryProjection", now: NOW,
    });
    assert.ok(r.ok);
    const sushi = r.value.hits.find((h) => h.memory_id === "sushi")!;
    const bangkok = r.value.hits.find((h) => h.memory_id === "bangkok")!;
    assert.ok(bangkok.dimensions.temporal_relevance > sushi.dimensions.temporal_relevance);
  });
});
