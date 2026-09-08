/**
 * wallPromotionDisclosure.test.ts — Wall spec §37 / §35 non-negotiable:
 * "Paid/promoted content, if introduced later, is explicitly labeled and
 * separated from factual live confidence."
 *
 * WHAT WAS ACTUALLY WRONG, BECAUSE IT WAS NOT WHAT THE CENSUS SAID
 * ===============================================================
 * census-wall.md scored this NOT-BUILT with the reasoning "no promoted-content
 * concept exists in the Wall at all — the rule holds VACUOUSLY today". That is
 * half right and the wrong half.
 *
 * `sponsored` and `imported_owned` are not hypothetical future concepts. They
 * are two of the eight members of `intelContracts.SOURCE_CLASSES`, they are
 * accepted by the live read path, and they already reach the Wall's producers
 * through `LiveClaimEnvelope.sourceClass`. The rule was therefore NOT holding
 * vacuously — it was holding halfway:
 *
 *   SEPARATED   yes. `deriveWallTruthClass` maps both classes to `inferred`,
 *               which is in NON_OBSERVATION_TRUTH_CLASSES, so no amount of
 *               coverage can promote a paid claim into an observation. This has
 *               been true and enforced in the contract for some time.
 *   LABELLED    NO. A sponsored claim was rendered with a quieter truth class
 *               and NOTHING ANYWHERE SAYING IT WAS SPONSORED. The viewer saw a
 *               slightly hedged live card and could not tell why.
 *
 * "Separated but silent" is the worse of the two failures to ship, because the
 * separation is invisible: the system knows the claim is paid and declines to
 * say so. This suite pins both halves, and pins that they are derived from the
 * SAME input so they can never disagree.
 *
 * WHAT TURNS THIS RED
 *   • drop the `...(promotionLabelFor(...))` spread from either producer
 *     -> the "producer emits the disclosure" tests fail;
 *   • let `promotionLabelFor` return a label for a non-promotional class, or
 *     stop returning one for a promotional class -> the agreement test fails;
 *   • change either string away from `SOURCE_CLASS_LABELS`
 *     -> the canonical-vocabulary test fails;
 *   • add a source class to PROMOTIONAL_SOURCE_CLASSES without a label, or add
 *     one to SOURCE_CLASSES that is promotional in meaning -> covered below;
 *   • weaken deriveWallTruthClass so a promotional class can reach `observed`
 *     -> the separation test fails at every coverage level.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import nodeFs from "node:fs";

import {
  NON_OBSERVATION_TRUTH_CLASSES,
  PROMOTIONAL_SOURCE_CLASSES,
  deriveWallTruthClass,
  isPromotionalSourceClass,
  promotionLabelFor,
  truthClassMayRenderAsObservation,
} from "../lib/wallProjection.js";
import { SOURCE_CLASSES, SOURCE_CLASS_LABELS } from "../lib/intelContracts.js";

describe("§37 — the two halves are derived from one input and cannot disagree", () => {
  it("a class is promotional iff it has a disclosure label", () => {
    for (const cls of SOURCE_CLASSES) {
      assert.equal(
        isPromotionalSourceClass(cls),
        promotionLabelFor(cls) !== null,
        `${cls}: promotional=${isPromotionalSourceClass(cls)} but label=${String(promotionLabelFor(cls))}`,
      );
    }
  });

  it("every promotional class is refused an observation truth class, at EVERY coverage", () => {
    // Coverage is the one input that promotes a class upward in
    // deriveWallTruthClass (several/many -> corroborated), so it is the input a
    // regression would most plausibly leak through. All four are checked.
    for (const cls of PROMOTIONAL_SOURCE_CLASSES) {
      for (const coverage of ["few", "several", "many", "unknown"] as const) {
        const tc = deriveWallTruthClass({ sourceClass: cls, coverage });
        assert.equal(
          truthClassMayRenderAsObservation(tc),
          false,
          `${cls} at coverage=${coverage} produced ${tc}, which may render as an observation`,
        );
        assert.ok(NON_OBSERVATION_TRUTH_CLASSES.includes(tc));
      }
    }
  });

  it("a NON-promotional firsthand class still reaches an observation", () => {
    // The guard above would pass vacuously if deriveWallTruthClass refused
    // everything. This is the control.
    assert.equal(
      truthClassMayRenderAsObservation(
        deriveWallTruthClass({ sourceClass: "verified_firsthand", coverage: "many" }),
      ),
      true,
    );
  });

  it("returns null — not a word — for absent, empty and unrecognised classes", () => {
    // `null` rather than "Organic"/"" matters: the field is SPREAD onto the
    // projection, so null means the key is absent, and an absent key is the
    // absence of a claim rather than a claim of absence.
    for (const v of [null, undefined, "", "verified_firsthand", "hearsay", "nonsense"]) {
      assert.equal(promotionLabelFor(v), null, `promotionLabelFor(${String(v)})`);
    }
  });
});

describe("§37 — the disclosure is the CANONICAL vocabulary, not new wording", () => {
  it("each label equals intelContracts.SOURCE_CLASS_LABELS for the same class", () => {
    // lib/wallProjection.ts is deliberately dependency-free and repeats these
    // two strings rather than importing them. A repeated constant can drift;
    // this test is the only place the two modules can be compared.
    for (const cls of PROMOTIONAL_SOURCE_CLASSES) {
      assert.equal(
        promotionLabelFor(cls),
        SOURCE_CLASS_LABELS[cls as keyof typeof SOURCE_CLASS_LABELS],
        `${cls}: the Wall's disclosure has drifted from the canonical label`,
      );
    }
  });

  it("every promotional class is a real member of the canonical vocabulary", () => {
    for (const cls of PROMOTIONAL_SOURCE_CLASSES) {
      assert.ok(
        (SOURCE_CLASSES as readonly string[]).includes(cls),
        `${cls} is not in SOURCE_CLASSES — the Wall would be labelling a class nothing can produce`,
      );
    }
  });

  it("the set is exactly the self-asserting classes minus official_signed", () => {
    // NON_INDEPENDENT_SOURCE_CLASSES is official_signed + sponsored +
    // imported_owned: "one party talking about themselves". An official update
    // is self-asserted but is not PAID OR PROMOTED, and labelling a transit
    // authority's service alert "Sponsored" would be false. The Wall's set is
    // therefore deliberately narrower, and this pins that it is narrower ON
    // PURPOSE rather than by omission.
    assert.deepEqual([...PROMOTIONAL_SOURCE_CLASSES].sort(), ["imported_owned", "sponsored"]);
    assert.equal(promotionLabelFor("official_signed"), null);
  });
});

// ---------------------------------------------------------------------------

describe("§37 — every producer that derives a truth class also derives the label", () => {
  /**
   * THE INVARIANT, ENFORCED STRUCTURALLY RATHER THAN PER-PRODUCER.
   *
   * The two halves are only guaranteed to agree because they are computed from
   * the SAME `sourceClass` expression in the SAME object literal. A new Wall
   * producer that calls `deriveWallTruthClass` and forgets `promotionLabelFor`
   * reintroduces exactly the defect this suite exists for — silently, because
   * the field is optional and nothing else would notice.
   *
   * So the rule is asserted over the source: in the Wall's producer modules,
   * every `deriveWallTruthClass(` call site must be accompanied by a
   * `promotionLabelFor(` call reading the same `sourceClass` expression.
   *
   * COMMENTS ARE STRIPPED FIRST, and that is not defensive tidiness. Both call
   * sites here carry a comment naming §37 and the other function; without
   * stripping, deleting the CODE would leave the comment behind and this test
   * would still pass. A test that a comment can satisfy is not a test.
   */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  const PRODUCERS = [
    "src/services/wall/LiveForYouService.ts",
    "src/services/wall/ContextThreadService.ts",
  ];

  const read = (rel: string): string => {
    // Resolved against this file so the test is runnable from any cwd.
    const url = new URL(`../../${rel}`, import.meta.url);
    return stripComments(nodeFs.readFileSync(url, "utf8"));
  };

  it("the scan reads real source (guard against a vacuous pass)", () => {
    for (const rel of PRODUCERS) {
      const src = read(rel);
      assert.ok(src.length > 2000, `${rel} read as ${src.length} chars — the scan is not reading it`);
      assert.match(src, /deriveWallTruthClass\(/, `${rel} has no truth-class call site to check`);
    }
  });

  it("each producer derives the disclosure from the SAME sourceClass expression", () => {
    for (const rel of PRODUCERS) {
      const src = read(rel);
      // The expression each module reads its source class from. Captured from
      // the truth-class call rather than hard-coded, so a producer that renames
      // its envelope variable is compared against its own new name.
      const truthArgs = [...src.matchAll(/deriveWallTruthClass\(\{\s*sourceClass:\s*([^,\n]+),/g)]
        .map((m) => (m[1] ?? "").trim());
      assert.ok(truthArgs.length > 0, `${rel}: no deriveWallTruthClass({ sourceClass: … }) call site`);
      for (const expr of truthArgs) {
        assert.ok(
          src.includes(`promotionLabelFor(${expr})`),
          `${rel}: derives a truth class from \`${expr}\` but never calls ` +
            `promotionLabelFor(${expr}) — the claim would be downgraded without being labelled`,
        );
      }
    }
  });

  it("the disclosure is SPREAD, so a non-promotional item carries no key", () => {
    // `promotionLabel: promotionLabelFor(x)` would put `promotionLabel:
    // undefined` on every ordinary item and serialise a field the §37 contract
    // says is absent unless it means something. Both producers spread.
    for (const rel of PRODUCERS) {
      const src = read(rel);
      assert.match(
        src,
        /\.\.\.\(promotionLabelFor\([^)]*\) !== null/,
        `${rel}: the disclosure must be conditionally spread, not assigned unconditionally`,
      );
    }
  });
});
