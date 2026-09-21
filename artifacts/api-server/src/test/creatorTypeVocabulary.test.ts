/**
 * The SIX creator value types of `07` §2 — the vocabulary, read against the spec.
 *
 * ── WHY THIS TEST EXISTS AT ALL ─────────────────────────────────────────────
 * `docs/specs/discovery-v1/07_Creator_Economy.md` §2 names six creator value
 * types under six headings (lines 17, 20, 23, 26, 29, 32). Before this unit, a
 * whole-tree grep for any of those six names matched NOTHING — not a constant,
 * not a column, not a comment. The creator-type dimension did not exist, so
 * every one of `07` §10's five acceptance properties was, at best, a property
 * of a SUBSYSTEM (intel; Rent-a-Buddy) rather than of a creator type.
 *
 * That absence is exactly the kind a test cannot normally see: nothing was
 * wrong, there was simply nothing. So this file asserts the vocabulary against
 * the SPEC FILE ITSELF — it re-reads `07` §2 from disk and fails if the code's
 * six names, their order, or their definitions ever drift from the six headings
 * the spec carries. A vocabulary invented to satisfy a checker would be worse
 * than none; this one cannot be invented, because the spec is the oracle.
 *
 * ── WHAT IT DELIBERATELY DOES NOT ASSERT ────────────────────────────────────
 * That every type has a value-event PRODUCER. Three of the six do not, and
 * `07` §2's names do not oblige one to exist. What IS asserted is that each
 * type DECLARES whether it has one, so "seam with no producer" is a recorded
 * fact with a reason rather than a silence that reads as coverage.
 *
 * Run: node --import tsx/esm --test src/test/creatorTypeVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREATOR_TYPES,
  CREATOR_TYPE_FACTS,
  CREATOR_SUBJECT_KINDS,
  TRAVELER_IMPACT_OUTCOMES,
  TRAVELER_IMPACT_SPEC_LABELS,
  creatorTypeFacts,
  isCreatorType,
  typesWithoutValueEventProducer,
  type CreatorType,
} from "../lib/creatorTypes.js";

const SPEC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/specs/discovery-v1/07_Creator_Economy.md",
);
const specLines = readFileSync(SPEC, "utf8").split("\n");
/** 1-indexed, the way a `file:NNN` citation is. */
const specLine = (n: number) => specLines[n - 1];

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §2 names SIX creator value types, and the code names the same six", () => {
  it("the spec section really does carry exactly six headings", () => {
    // Bound the scan to §2 so a later section's heading cannot be miscounted.
    const start = specLines.findIndex((l) => l.startsWith("## 2. Creator value types"));
    assert.notEqual(start, -1, "`07` §2 heading not found — the spec moved");
    const rest = specLines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    const headings = rest.slice(0, end === -1 ? rest.length : end)
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4).trim());
    assert.deepEqual(headings, [
      "Discovery Creator",
      "Trail Builder",
      "Local Expert",
      "Itinerary Creator",
      "Experience Host",
      "Travel Partner",
    ]);
  });

  it("CREATOR_TYPES has six members and no duplicates", () => {
    assert.equal(CREATOR_TYPES.length, 6);
    assert.equal(new Set(CREATOR_TYPES).size, 6);
  });

  it("every type's specName and specDefinition are VERBATIM from the cited spec lines", () => {
    for (const t of CREATOR_TYPES) {
      const f = creatorTypeFacts(t);
      assert.equal(
        specLine(f.specLine), `### ${f.specName}`,
        `${t}: 07 §2 line ${f.specLine} is not the heading "### ${f.specName}"`,
      );
      assert.equal(
        specLine(f.specLine + 1), f.specDefinition,
        `${t}: 07 §2 line ${f.specLine + 1} is not the definition this type claims`,
      );
    }
  });

  it("the six declared spec lines are the six distinct §2 headings, in spec order", () => {
    const lines = CREATOR_TYPES.map((t) => creatorTypeFacts(t).specLine);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b), "declared out of spec order");
    assert.equal(new Set(lines).size, 6);
  });

  it("isCreatorType is a CLOSED vocabulary — a plausible near-miss is refused", () => {
    for (const t of CREATOR_TYPES) assert.equal(isCreatorType(t), true);
    for (const bad of ["creator", "trail_builder ", "TrailBuilder", "local-expert", "", "host"]) {
      assert.equal(isCreatorType(bad), false, `${JSON.stringify(bad)} was admitted`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("every type declares its attribution subject and its value event", () => {
  it("each type's subjectKind is in the closed subject vocabulary", () => {
    for (const t of CREATOR_TYPES) {
      assert.ok(
        CREATOR_SUBJECT_KINDS.includes(creatorTypeFacts(t).subjectKind),
        `${t}: subjectKind not in CREATOR_SUBJECT_KINDS`,
      );
    }
  });

  it("each type's value event is one of `07` §3's Traveler Impact outcomes, verbatim", () => {
    // §3's list, lines 38-44, is the oracle. Read it rather than restate it.
    const start = specLines.findIndex((l) => l.startsWith("## 3. Traveler Impact"));
    const rest = specLines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    const bullets = rest.slice(0, end === -1 ? rest.length : end)
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).replace(/[,.]$/, "").trim());
    assert.deepEqual(
      TRAVELER_IMPACT_OUTCOMES.map((o) => TRAVELER_IMPACT_SPEC_LABELS[o]),
      bullets,
      "TRAVELER_IMPACT_OUTCOMES/_SPEC_LABELS have drifted from `07` §3",
    );
    // …and the labels must be a TOTAL, injective map of the outcomes, so a
    // drifting member cannot be hidden by a duplicate or a missing key.
    assert.deepEqual(Object.keys(TRAVELER_IMPACT_SPEC_LABELS).sort(), [...TRAVELER_IMPACT_OUTCOMES].sort());
    assert.equal(new Set(Object.values(TRAVELER_IMPACT_SPEC_LABELS)).size, TRAVELER_IMPACT_OUTCOMES.length);
    for (const t of CREATOR_TYPES) {
      assert.ok(
        TRAVELER_IMPACT_OUTCOMES.includes(creatorTypeFacts(t).valueEvent),
        `${t}: valueEvent is not a §3 Traveler Impact outcome`,
      );
    }
  });

  it("a type with NO producer says so with a reason; a type WITH one names a real file", () => {
    for (const t of CREATOR_TYPES) {
      const f = creatorTypeFacts(t);
      if (f.valueEventProducer === null) {
        assert.ok(
          f.noProducerReason.length > 20,
          `${t}: declares no producer but gives no reason — that reads as coverage`,
        );
      } else {
        assert.equal(f.noProducerReason, "", `${t}: has a producer AND a no-producer reason`);
        assert.match(f.valueEventProducer, /\.(ts|sql)$|^[a-z_]+$/);
      }
    }
  });

  it("typesWithoutValueEventProducer is derived, not restated", () => {
    assert.deepEqual(
      typesWithoutValueEventProducer(),
      CREATOR_TYPES.filter((t) => creatorTypeFacts(t).valueEventProducer === null),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 rules are versioned — PER TYPE, not once for the platform", () => {
  it("every type carries its own default rule version, and no two share one", () => {
    const versions = CREATOR_TYPES.map((t) => creatorTypeFacts(t).defaultRuleVersion);
    for (const [i, v] of versions.entries()) {
      assert.ok(v.length > 0, `${CREATOR_TYPES[i]}: empty rule version`);
      assert.match(v, /\/v\d+$/, `${CREATOR_TYPES[i]}: rule version carries no generation`);
    }
    assert.equal(
      new Set(versions).size, 6,
      "two types share a rule version — one type's re-pricing would silently re-price another",
    );
  });

  it("CREATOR_TYPE_FACTS is keyed by exactly the six types", () => {
    assert.deepEqual(Object.keys(CREATOR_TYPE_FACTS).sort(), [...CREATOR_TYPES].sort());
  });

  it("creatorTypeFacts REFUSES an unknown type rather than returning undefined", () => {
    assert.throws(() => creatorTypeFacts("influencer" as CreatorType), /unknown creator type/i);
  });
});
