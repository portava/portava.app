/**
 * checkCensusRowMoveLabels — a labelled requirement id must not name another
 * requirement's object.
 *
 * ── THE DEFECT THIS EXISTS FOR, MEASURED ─────────────────────────────────────
 * A census revises a verdict by RESTATING the row in a later "Row moves"
 * section, and the restatement carries a human label after the id:
 *
 *     | TR87 `trip_presence`  | N | **W** | 2767 vocabulary, 2768 writer … |
 *     | TR88 `trip_proposals` | N | **W** | 2768 + 2775 …                  |
 *     | TR89 `trip_snapshots` | N | **W** | 2773 fold/replay/verify …      |
 *     | TR90 `trip_outcomes`  | N | **W** | 2768 RECORD_OUTCOME …          |
 *
 * census-trips' body assigns TR89 `trip_events`, TR90 `trip_snapshots` and
 * TR91 `trip_outcomes`. From TR89 onward the label and the id name DIFFERENT
 * objects: the author's list ran out one row early. checkCensusIntegrity takes
 * the id (correctly — the id is the requirement), so:
 *
 *   TR89  was already W. Recorded as moving N→W, which cost nothing numerically
 *         and attached `trip_snapshots`' evidence to `trip_events`.
 *   TR90  got `trip_outcomes`' evidence. W happened to be right for
 *         `trip_snapshots` too. Accidentally correct.
 *   TR91  WAS NEVER MOVED. It stayed NOT-BUILT reading "Does not exist." while
 *         `CREATE TABLE public.trip_outcomes` sat in a merged migration.
 *
 * One requirement silently kept a falsified verdict, and the error propagated
 * INTO THE CODE: 2768_trip_kernel_presence_proposal_outcome_families.sql
 * comments `RECORD_OUTCOME -> trip_outcomes (TR90)`, citing the census's own
 * off-by-one back at it. Two documents then agreed on a wrong id, which is how
 * a wrong id survives review.
 *
 * ── WHY THE TEST IS THIS NARROW, AND NOT "LABEL MUST MATCH BODY" ─────────────
 * MEASURED over all thirteen censuses: five labelled ids carry an identifier
 * the body row does not. THREE OF THE FIVE ARE LEGITIMATE and failing them
 * would be an accusation aimed at documents doing nothing wrong:
 *
 *   census-media   MD36 `media_assets`       body says `MediaAsset`
 *                  — the table and its type. Same object, two spellings.
 *   census-trips   TR12 `version`            body says `Trip`
 *                  — the cell is "TR12, TR77 (no `version` column on `trips`)",
 *                    a multi-id row naming the COLUMN at issue.
 *   census-trust   C13 `gps_coordinate_jump` body says `applyEventCaps`
 *                  — the cap-map key, inside the function the row is about.
 *
 * A label that REFINES is normal. A label that names ANOTHER ROW'S object is
 * not: it means either the id is wrong or the label is, and a reader tracing
 * the row lands on the wrong object either way. So the rule is exactly that,
 * and on the corpus today it fires on TR89 and TR90 and on nothing else —
 * consecutive, which is what an off-by-one looks like.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ──────────────────────────────────────
 * 1. Whether a verdict is RIGHT. Nothing here reads a judgement.
 * 2. An off-by-one whose labels are prose ("TR136 stage-locality"). Only
 *    backticked identifiers are comparable, so a mislabelled prose row is
 *    invisible here. The check is a floor on this defect, not a proof of
 *    absence.
 * 3. A row moved under an id that exists but is simply the WRONG requirement
 *    with no label at all. There is nothing in the document to compare.
 *
 * Run: node --import tsx/esm src/scripts/checkCensusRowMoveLabels.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findMislabelledRows, countLabelledCells, type Mislabelled } from "./lib/censusRowLabels.js";

const CENSUS_DIR = new URL("../../../../docs/architecture/", import.meta.url).pathname;

/** A tree with no censuses is a tree this check could not find. */
const MIN_CENSUS_FILES = 10;

const files = readdirSync(CENSUS_DIR).filter((f) => /^census-.*\.md$/.test(f)).sort();
if (files.length < MIN_CENSUS_FILES) {
  console.log(`::error::checkCensusRowMoveLabels found only ${files.length} census file(s) in ${CENSUS_DIR}; expected at least ${MIN_CENSUS_FILES}. A check that silently reads nothing passes for the wrong reason.`);
  process.exit(1);
}

let labelled = 0;
const findings: Array<Mislabelled & { file: string }> = [];
for (const f of files) {
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  labelled += countLabelledCells(text);
  for (const m of findMislabelledRows(text)) findings.push({ ...m, file: f });
}

for (const x of findings) {
  console.log(
    `::error::${x.file}:${x.line}: row ${x.id} is labelled \`${x.label}\`, but this census's body assigns \`${x.label}\` to ${x.belongsTo} (${x.file}:${x.belongsToLine})` +
    (x.ownBody ? `, and assigns ${x.id} the object \`${x.ownBody}\` (${x.file}:${x.ownBodyLine})` : "") +
    `. Either the id is wrong or the label is. The id is what every count uses, so a wrong id moves the wrong requirement and leaves the right one holding a verdict nobody rechecked — census-trips TR91 stayed NOT-BUILT that way while its table existed on merged main.`,
  );
}

console.log(`\ncheck:census-row-move-labels — ${files.length} census file(s), ${labelled} labelled id cell(s) scanned, ${findings.length} label(s) naming another row's object.`);
console.log("NOTE: DOES NOT COVER — (1) whether a verdict is right; nothing here reads a judgement. (2) A mislabelled row whose label is prose rather than a backticked identifier: there is nothing comparable to compare. (3) A row restated under the wrong id with no label at all. This is a floor on one defect, not a proof that ids and objects agree.");

if (findings.length > 0) {
  console.log(`\ncheck:census-row-move-labels FAILED — ${findings.length} problem(s).`);
  process.exit(1);
}
console.log("\ncheck:census-row-move-labels PASSED");
