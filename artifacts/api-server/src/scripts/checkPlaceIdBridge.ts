/**
 * checkPlaceIdBridge — the place id-space crossing stays SINGLE.
 *
 * ── THE REQUIREMENT, AND WHY THIS FILE EXISTS ────────────────────────────────
 * census-trips TR32 ("Never substitute one domain ID for another because names
 * or coordinates look similar") and TR94 ("place identity resolves through the
 * canonical place bridge") both said, in the document, that the rule was
 * "Enforced by a standing ratchet rather than convention: `lib/placeIdBridge.ts`
 * is the only sanctioned crossing, and `scripts/checkSchemaReferences.ts` is the
 * ratchet that keeps it single."
 *
 * MEASURED 2026-09-11: there was no such ratchet. `checkSchemaReferences.ts`
 * checks that a select-list column exists on the table being read — the
 * `places.country` / `country_code` defect — and says nothing about id spaces.
 * No file under src/scripts/ or scripts/ mentioned `placeIdBridge` at all. The
 * verdict was true (the crossing WAS single, verified by reading every caller)
 * and its stated reason was false. This file makes the reason true.
 *
 * ── WHAT THE DEFECT WOULD LOOK LIKE ──────────────────────────────────────────
 * The Discovery serve path emits three id spaces — `db/<discovery_places.id>`,
 * `db/<places.id>` and `node/<osm_id>` — while place memory is keyed on
 * `discovery_places.id`. Calling the novelty primitive with a RAW served id
 * matches nothing and reports EVERY place as new to the user: a silent,
 * confident wrong answer rather than an error. `lib/placeIdBridge.ts` exists to
 * map between those spaces, and the rule is that nothing else performs the
 * crossing.
 *
 * ── WHAT IS ENFORCED, AND WHAT IS NOT ────────────────────────────────────────
 * ENFORCED: the place-memory subject crossing — an RPC call carrying
 * `p_subject_type: "place"` — appears only in the sanctioned module.
 *
 * NOT ENFORCED, stated rather than implied: this cannot tell whether an id
 * handed to the bridge was the right one, and it does not police every possible
 * id substitution in the tree. It pins the ONE crossing the census names. A
 * guard that claimed more than it checks is the thing this file was written to
 * correct.
 *
 * Run: node --import tsx/esm src/scripts/checkPlaceIdBridge.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** The one module permitted to perform the place id-space crossing. */
const SANCTIONED = "lib/placeIdBridge.ts";

/**
 * This file, which necessarily contains the pattern it searches for — as a
 * regex literal, not as a call. It flagged itself on its first run. Skipped by
 * exact path rather than by "any file under scripts/", because a real violation
 * could perfectly well live in a script and must still be caught.
 */
const SELF = "scripts/checkPlaceIdBridge.ts";

/**
 * The crossing, as it appears in source: an RPC argument naming the place
 * subject space. Matching the ARGUMENT rather than the RPC name is deliberate —
 * the primitive has already been renamed once (`memory_is_new_to_user` ->
 * `memory_are_new_to_user`) and a guard keyed on the old name would have gone
 * quietly blind at the rename while still reporting a pass.
 */
const CROSSING_RE = /p_subject_type\s*:\s*["']place["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "test") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(SRC);
const offenders: string[] = [];
let sanctionedHits = 0;

for (const f of files) {
  const rel = relative(SRC, f);
  const text = readFileSync(f, "utf8");
  if (rel === SELF) continue;
  if (!CROSSING_RE.test(text)) continue;
  if (rel === SANCTIONED) { sanctionedHits += 1; continue; }
  offenders.push(rel);
}

// POSITIVE CONTROL. A pattern that matches nothing looks exactly like a tree with
// no violations, and this repository has produced four confidently wrong
// conclusions that way. If the sanctioned module itself stops matching, the
// crossing was renamed or moved and this check has gone blind — that is a
// failure, not a pass.
if (sanctionedHits === 0) {
  console.error(
    `::error::checkPlaceIdBridge found the place-memory crossing NOWHERE, including in ${SANCTIONED}. ` +
      `The pattern it matches on (${CROSSING_RE}) no longer appears, so this check is verifying nothing. ` +
      `Either the crossing moved — update SANCTIONED — or it was renamed, in which case update CROSSING_RE. ` +
      `An empty result is not a clean result.`,
  );
  process.exit(1);
}

if (offenders.length > 0) {
  for (const o of offenders) {
    console.error(
      `::error::${o} performs the place id-space crossing directly (p_subject_type: "place"). ` +
        `Only ${SANCTIONED} may do this. The Discovery serve path emits three id spaces and place memory ` +
        `is keyed on discovery_places.id; crossing without the bridge reports EVERY place as new to the ` +
        `user — a silent wrong answer, not an error. Route this through resolvePlaceIdBridge.`,
    );
  }
  console.error(`\n${offenders.length} unsanctioned crossing(s) found.`);
  process.exit(1);
}

console.log(
  `check:place-id-bridge — ${files.length} source file(s) scanned; the place-memory crossing appears ` +
    `only in ${SANCTIONED} (${sanctionedHits} site(s)).`,
);
console.log(
  "NOTE: DOES NOT COVER — whether an id handed to the bridge was the correct one, or id substitutions " +
    "outside the place-memory subject space. It pins the one crossing census-trips TR32/TR94 name.",
);
console.log("\ncheck:place-id-bridge PASSED");
