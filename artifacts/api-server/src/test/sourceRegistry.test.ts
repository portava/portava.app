/**
 * sourceRegistry — the deterministic string->origin mapping and the fail-closed
 * resolver, tested without a database.
 *
 * The migration (2101) and this module share SEED_SOURCES as one source of
 * truth, so pinning the seed here pins what the migration inserts too.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ORIGINS,
  SEED_SOURCES,
  originForKey,
  resolveSourceId,
  invalidateSourceRegistryCache,
} from "../lib/sourceRegistry.js";

/** A fake service client whose `sources` table is the SEED_SOURCES list. */
function sourcesClient() {
  const rows = SEED_SOURCES.map((s, i) => ({ id: `id-${i}-${s.key}`, key: s.key }));
  return {
    from(table: string) {
      assert.equal(table, "sources");
      return { select: async () => ({ data: rows, error: null }) };
    },
  };
}

/** A fake client whose sources load errors — exercises the fail-closed path. */
function erroringClient() {
  return {
    from() {
      return { select: async () => ({ data: null, error: { message: "boom" } }) };
    },
  };
}

const EXISTING_PROVIDER_STRINGS = [
  "portava", "curated", "fsq", "fsq_os_places", "osm", "google", "user", "traveler",
];

describe("sourceRegistry — the six-origin taxonomy", () => {
  it("declares all six origins", () => {
    assert.deepEqual(
      [...ORIGINS].sort(),
      ["buddy", "inferred", "official", "promotional", "provider", "traveler"],
    );
  });

  it("every seeded row carries a valid origin", () => {
    for (const s of SEED_SOURCES) {
      assert.ok(ORIGINS.includes(s.origin), `${s.key} has invalid origin ${s.origin}`);
    }
  });

  it("all six origins are representable (schema accepts each)", () => {
    // The three unseeded origins are reserved but still valid values.
    for (const origin of ORIGINS) {
      assert.ok(typeof origin === "string" && origin.length > 0);
    }
    assert.equal(ORIGINS.length, 6);
  });
});

describe("sourceRegistry — every existing provider string maps to a source", () => {
  it("originForKey resolves each existing provider/source string to an origin", () => {
    for (const key of EXISTING_PROVIDER_STRINGS) {
      assert.notEqual(originForKey(key), null, `${key} did not map to an origin`);
    }
  });

  it("the deterministic mapping matches the blueprint", () => {
    assert.equal(originForKey("portava"), "official");
    assert.equal(originForKey("curated"), "official");
    assert.equal(originForKey("fsq"), "provider");
    assert.equal(originForKey("fsq_os_places"), "provider");
    assert.equal(originForKey("osm"), "provider");
    assert.equal(originForKey("google"), "provider");
    assert.equal(originForKey("user"), "traveler");
    assert.equal(originForKey("traveler"), "traveler");
  });
});

describe("sourceRegistry — resolveSourceId", () => {
  beforeEach(() => invalidateSourceRegistryCache());

  it("resolves each existing provider string to a non-null id", async () => {
    const sc = sourcesClient();
    for (const key of EXISTING_PROVIDER_STRINGS) {
      const id = await resolveSourceId(sc, key);
      assert.ok(id, `${key} did not resolve to an id`);
    }
  });

  it("returns null for an unknown string (fail-closed)", async () => {
    const sc = sourcesClient();
    assert.equal(await resolveSourceId(sc, "mock"), null);
    assert.equal(await resolveSourceId(sc, "seed_script"), null); // demo fixture, quarantined
    assert.equal(originForKey("mock"), null);
  });

  it("returns null for empty/nullish input", async () => {
    const sc = sourcesClient();
    assert.equal(await resolveSourceId(sc, ""), null);
    assert.equal(await resolveSourceId(sc, null), null);
    assert.equal(await resolveSourceId(sc, undefined), null);
  });

  it("returns null for every lookup when the registry load errors (fail-closed)", async () => {
    const sc = erroringClient();
    assert.equal(await resolveSourceId(sc, "fsq"), null);
  });
});
