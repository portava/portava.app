/**
 * dataRights (IG-08 prerequisite) — possession is not a right.
 *
 * The property under test: an unregistered field can never be redistributed, and
 * a new intel column cannot be added without someone classifying it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { intelCreateColumns, allIntelColumns, computeProblems } from "../scripts/checkDataRights.js";
import {
  FIELD_RIGHTS, OWNERSHIP_CLASSES, REDISTRIBUTABLE, mayRedistribute,
  redistributableFields, COVERED_TABLES,
} from "../lib/dataRights.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
// CREATE bodies from every intel-creating migration (2130 + I4a's 2277/2278).
const CREATE_ONLY = intelCreateColumns(MIGRATIONS);
// The completeness scan reads the CREATE bodies PLUS every later ALTER ADD COLUMN,
// so columns added after 2130 (group_key, party_size_bucket via 2171) are covered.
const TABLES = allIntelColumns(MIGRATIONS);

describe("dataRights — the registry matches the schema", () => {
  it("parses every covered table out of an intel-creating migration", () => {
    for (const t of COVERED_TABLES) {
      assert.ok((CREATE_ONLY.get(t) ?? []).length > 0, `${t} produced no columns`);
    }
  });

  it("sees columns added by a later ALTER, not just CREATE (2171 group_key/party_size_bucket)", () => {
    const obs = TABLES.get("intel_observations") ?? [];
    assert.ok(obs.includes("group_key"), "group_key (added by 2171 ALTER) must be in the scanned set");
    assert.ok(obs.includes("party_size_bucket"), "party_size_bucket must be in the scanned set");
  });

  it("is currently clean", () => {
    const problems = computeProblems(TABLES);
    assert.deepEqual(problems, [], problems.map((p) => `${p.kind}: ${p.detail}`).join("\n"));
  });

  it("every classification uses a known class and a defensible reason", () => {
    for (const f of FIELD_RIGHTS) {
      assert.ok(OWNERSHIP_CLASSES.includes(f.ownership), `${f.table}.${f.column}: bad class`);
      assert.ok(f.reason.trim().length >= 10, `${f.table}.${f.column}: reason too thin`);
    }
  });
});

describe("dataRights — fail-closed", () => {
  it("an unregistered field may never be redistributed", () => {
    assert.equal(mayRedistribute("intel_observations", "not_a_column"), false);
    assert.equal(mayRedistribute("some_other_table", "value"), false);
  });

  it("identity and moderation fields can never leave", () => {
    assert.equal(mayRedistribute("intel_observations", "actor_id"), false);
    assert.equal(mayRedistribute("intel_observations", "moderation_state"), false);
    assert.equal(mayRedistribute("intel_observations", "visibility"), false);
    assert.equal(mayRedistribute("intel_confirmations", "actor_id"), false);
  });

  it("the exact cohort size is withheld — it is the privacy parameter itself", () => {
    assert.equal(mayRedistribute("intel_state_snapshots", "distinct_actors"), false);
  });

  it("the independent-group signal (group_key, party_size_bucket) never leaves", () => {
    assert.equal(mayRedistribute("intel_observations", "group_key"), false);
    assert.equal(mayRedistribute("intel_observations", "party_size_bucket"), false);
  });

  it("an evidence storage key never leaves", () => {
    assert.equal(mayRedistribute("intel_evidence", "reference"), false);
  });

  it("display-only and restricted classes are not redistributable", () => {
    assert.equal(REDISTRIBUTABLE.third_party_display_only, false);
    assert.equal(REDISTRIBUTABLE.restricted_no_redistribution, false);
  });

  it("the projected live state IS the product and may leave", () => {
    assert.equal(mayRedistribute("intel_state_snapshots", "value"), true);
    assert.equal(mayRedistribute("intel_state_snapshots", "confidence_band"), true);
  });
});

describe("dataRights — the guard bites on a new column", () => {
  it("FAILS when an intel table gains an unclassified column", () => {
    const withNew = new Map(TABLES);
    withNew.set("intel_observations", [...(TABLES.get("intel_observations") ?? []), "device_fingerprint"]);
    const problems = computeProblems(withNew);
    const hit = problems.find((p) => p.detail.includes("device_fingerprint"));
    assert.ok(hit, "a new column passed unclassified — the guard does not bite");
    assert.equal(hit!.kind, "UNCLASSIFIED FIELD");
    assert.match(hit!.detail, /Possession is not a right/);
  });

  it("FLAGS a classified field that no longer exists", () => {
    const shrunk = new Map(TABLES);
    shrunk.set("intel_claims", (TABLES.get("intel_claims") ?? []).filter((c) => c !== "confidence"));
    assert.ok(computeProblems(shrunk).some((p) => p.kind === "STALE FIELD" && p.detail.includes("confidence")));
  });

  it("redistributableFields never includes a restricted field", () => {
    for (const t of COVERED_TABLES) {
      for (const f of redistributableFields(t)) {
        assert.notEqual(f.ownership, "restricted_no_redistribution");
        assert.notEqual(f.ownership, "third_party_display_only");
      }
    }
  });
});
