/**
 * placeProvenance (Phase 0 item 12) — the flag-guarded, fail-closed source_id
 * stamp wired onto place-supply writes. Tested without a database.
 *
 * The two properties that keep it safe to ship dormant on a database that does
 * not yet have 2101's source_id column:
 *   - OFF by default: an absent/false flag => {} (a no-op spread).
 *   - never guesses: an unknown provider string => {} even when the flag is on.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SEED_SOURCES, invalidateSourceRegistryCache } from "../lib/sourceRegistry.js";
import {
  PLACE_PROVENANCE_STAMPING_FLAG,
  provenanceStamp,
} from "../lib/placeProvenance.js";

/**
 * A fake client. `flag` is what feature_flags returns for the capability flag
 * (true/false/null=absent); `sourcesError` forces the sources load to fail.
 */
function client(opts: { flag: boolean | null; sourcesError?: boolean }) {
  const sourceRows = SEED_SOURCES.map((s, i) => ({ id: `id-${i}-${s.key}`, key: s.key }));
  return {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.flag === null ? null : { enabled: opts.flag },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "sources") {
        return {
          select: async () =>
            opts.sourcesError
              ? { data: null, error: { message: "boom" } }
              : { data: sourceRows, error: null },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const idFor = (key: string) => {
  const i = SEED_SOURCES.findIndex((s) => s.key === key);
  return `id-${i}-${key}`;
};

describe("placeProvenance — flag classification", () => {
  it("the flag is a CAPABILITY flag (auto-classified by the _enabled suffix)", () => {
    assert.ok(PLACE_PROVENANCE_STAMPING_FLAG.endsWith("_enabled"));
    assert.equal(PLACE_PROVENANCE_STAMPING_FLAG, "place_provenance_stamping_enabled");
  });
});

describe("placeProvenance — provenanceStamp (fail-closed)", () => {
  beforeEach(() => invalidateSourceRegistryCache());

  it("flag OFF + known string => {} (dormant default)", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: false }), "osm"), {});
  });

  it("flag ABSENT + known string => {} (fail-closed on a missing row)", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: null }), "osm"), {});
  });

  it("flag ON + known string => { source_id }", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: true }), "osm"), {
      source_id: idFor("osm"),
    });
  });

  it("flag ON + a different known string resolves to its own id", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: true }), "traveler"), {
      source_id: idFor("traveler"),
    });
  });

  it("flag ON + unknown string => {} (never guesses)", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: true }), "no_such_provider"), {});
  });

  it("flag ON + null/empty string => {}", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: true }), null), {});
    assert.deepEqual(await provenanceStamp(client({ flag: true }), ""), {});
  });

  it("flag ON but sources unreadable => {} (fail-closed on load error)", async () => {
    assert.deepEqual(await provenanceStamp(client({ flag: true, sourcesError: true }), "osm"), {});
  });
});
