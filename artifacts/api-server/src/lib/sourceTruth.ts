/**
 * sourceTruth — the §5.1 TRUTH CLASS a tool result's SOURCE CLASS implies,
 * through the ONE rule the tree already has (lib/wallProjection
 * `deriveWallTruthClass`), so the Compass tool layer, the UI blocks and the
 * grounding envelope grade a datum the way the Wall and the live envelopes do.
 *
 * census-compass CX-04 / CPV2-02: "predicted, inferred, conflicting, stale and
 * unknown fixtures retain their qualification in tool output, UI and generated
 * explanation". A tool result carried a SOURCE class (who said it) and no
 * TRUTH class (what kind of knowledge it is), so nothing downstream could
 * retain a qualification that was never stated. This derives it once, from
 * the source class alone — no freshness, no coverage, no conflict state is
 * known for a catalog row — so the result is the class the source ALONE
 * licenses: a historical pattern or a Portava prediction is `predicted`, a
 * hearsay is `inferred`, a firsthand or official source is `observed` (never
 * `corroborated`: one row is one source), and anything unrecognised is the
 * floor, `unknown`.
 *
 * PURE.
 */
import { LEGACY_SOURCE_CLASS_MAP, type LegacySourceClass } from "./intelContracts.js";
import { deriveWallTruthClass } from "./wallProjection.js";
import type { TruthClass } from "./truthClass.js";

const LEGACY = new Set<string>(Object.keys(LEGACY_SOURCE_CLASS_MAP));

/** Legacy 4 or canonical 8 source class → §5.1 truth class, by the Wall's rule. Unknown input ⇒ `unknown`. */
export function truthClassOfSourceClass(sourceClass: string | null | undefined): TruthClass {
  if (!sourceClass) return "unknown";
  const canonical = LEGACY.has(sourceClass) ? LEGACY_SOURCE_CLASS_MAP[sourceClass as LegacySourceClass] : sourceClass;
  return deriveWallTruthClass({ sourceClass: canonical });
}
