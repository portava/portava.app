/**
 * Print the 2411 cutover measurement query — `measure:layover-cutover-sql`.
 *
 * Needs no credentials and touches no database ON PURPOSE: the predicate that
 * produces committed evidence has to be reviewable by someone who has no project
 * to point it at, and the review has to be possible BEFORE anyone runs it.
 *
 * It deliberately does NOT run the query. This project exposes no generic SQL RPC
 * through PostgREST, so a `--write` mode here would be a code path that can never
 * succeed — decorative architecture, which is the defect class this repository
 * has spent the pass removing. The query is run through the Management API by a
 * human or an authorised session, and its result is committed to
 * src/lib/capability/layover-cutover-measurement.json with the checksum this
 * command prints, so the artifact can be tied back to the algorithm it measured.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDerivation, derivationChecksum, buildSql } from "./lib/layoverCutoverMeasure.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "..", "..");
const MIGRATION = join(API_ROOT, "src", "migrations", "2411_layover_recommendation_rec_key_backfill.sql");

function main(): void {
  if (!existsSync(MIGRATION)) {
    console.error(`measure:layover-cutover-sql — ${MIGRATION} not found.`);
    process.exit(2);
  }
  const derivation = extractDerivation(readFileSync(MIGRATION, "utf8"));
  if (!derivation) {
    console.error(
      "measure:layover-cutover-sql — could not lift the rec_key derivation out of 2411. Refusing to retype it: a " +
        "measurement taken under a derivation nobody checked against the migration is not evidence about that migration.",
    );
    process.exit(2);
  }
  console.log(buildSql(derivation));
  console.log(`\n-- derivationChecksum: ${derivationChecksum(derivation)}`);
  console.log("-- Record this checksum in the artifact. If the derivation changes, every count taken under the old one stops being evidence.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
