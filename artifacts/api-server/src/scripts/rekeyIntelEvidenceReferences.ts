/**
 * rekeyIntelEvidenceReferences — the remediation for census-map §45.
 *
 * Before the seal, the map evidence path stored `intel_evidence.reference` as a
 * plaintext storage key whose first path segment is the uploader's ACCOUNT id,
 * beside a contributor id that 3002 tokenises. This script finds every
 * photo/video evidence row that still holds such a key and re-seals it, through
 * migration 3360's one-row function. 3361 refuses to apply until none is left.
 *
 *   DRY RUN (default)   counts the rows. Reads only.
 *   --apply             re-seals them. Needs INTEL_EVIDENCE_REFERENCE_KEY (the
 *                       same value the API server runs with) and 3360 applied.
 *
 * It prints COUNTS ONLY. It never prints a reference, a path or a row id: every
 * value it reads names an account.
 *
 * NOT RUN against any database by the lane that wrote it. Recorded production
 * facts say there is nothing to re-seal there (intel_evidence held 0 rows on
 * 2026-09-26 and the map evidence route's flag row was absent on 2026-09-21);
 * a dry run is how an operator confirms that on the day, on each database.
 *
 * Exit codes: 0 done (or nothing to do), 1 some rows were refused or failed,
 * 2 cannot run.
 *
 * Run: node --import tsx/esm src/scripts/rekeyIntelEvidenceReferences.ts [--apply]
 */
import { getServiceClient } from "../lib/supabase.js";
import { rekeyLegacyEvidenceReferences } from "../lib/intelEvidenceCapture.js";

const apply = process.argv.includes("--apply");
const sc = getServiceClient();
if (!sc) {
  console.error("✖ rekeyIntelEvidenceReferences: the service client is not configured, so nothing was read.");
  process.exit(2);
}

try {
  const outcome = await rekeyLegacyEvidenceReferences(sc, { apply });
  console.log(JSON.stringify(outcome));
  if (!apply && outcome.legacy > 0) {
    console.log(`${outcome.legacy} photo/video evidence row(s) hold a plaintext key. Re-run with --apply to re-seal them.`);
  }
  process.exit(outcome.refused + outcome.failed > 0 ? 1 : 0);
} catch (err) {
  console.error(`✖ rekeyIntelEvidenceReferences: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
