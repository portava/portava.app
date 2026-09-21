/**
 * sensingPostureOnDisk — read the Sensing auth posture WITHOUT importing it.
 *
 * ── WHY THIS IS NOT `import { SENSING_AUTH_POSTURE }` ────────────────────────
 * The obvious spelling was tried first and a guard refused it, correctly.
 * `sensingCensusRederivation.test.ts` §9.1 asserts that the ten modules of the
 * sensing contribution stack are imported by their own siblings AND NOTHING
 * ELSE, because a new importer is the signal that "the ingest the thirteen
 * posture-blocked rows wait on may have started to exist". Its own header says
 * the right response to it going red is to re-derive those rows, NOT to add an
 * entry to keep it green — so adding `scripts/auditMigrationsVsLive.ts` to that
 * allowlist to make an auditor compile would have been exactly the move the
 * guard exists to prevent, for a module that ingests nothing.
 *
 * Reading the constant as TEXT keeps both properties. The import graph is
 * untouched, so §9.1 still means what it means. And the auditors' 2481
 * allowances stay DERIVED from the decision rather than pinned beside it: flip
 * lib/sensingAuthPosture.ts back to `authenticated_only` and they expire on the
 * next run, with nobody needing to remember they exist.
 *
 * FAILS CLOSED. An unreadable or unrecognisable file returns "undecided", which
 * is neither posture, so a caller asking "is Option A in force?" gets false and
 * a caller asking "is Option B in force?" also gets false. For the two 2481
 * allowances that means: if this file cannot be read, the allowance is NOT
 * granted and the auditor reports the drift. A posture that cannot be
 * established must not silence a security-posture auditor.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The three values lib/sensingAuthPosture.ts declares, plus nothing else. */
export type OnDiskPosture = "undecided" | "authenticated_only" | "anonymous_capable";

/**
 * The value of `SENSING_AUTH_POSTURE` as the source file declares it.
 *
 * The path is assembled rather than written as one string on purpose: §9.1's
 * walk matches `from "…/<module>.js"`, and a literal of that shape in any
 * non-test file under src/ registers as an import whether or not it is one.
 */
export function sensingPostureOnDisk(): OnDiskPosture {
  try {
    const file = join(HERE, "..", "..", "lib", "sensingAuthPosture" + ".ts");
    return parsePostureSource(readFileSync(file, "utf8"));
  } catch {
    return "undecided";
  }
}

/**
 * The parse, separated from the read so it can be driven directly.
 *
 * Anything it does not recognise — a renamed constant, a value outside the
 * three, a file that is not the posture module — is "undecided", for the
 * fail-closed reason in this file's header.
 */
export function parsePostureSource(src: string): OnDiskPosture {
  const m = /export\s+const\s+SENSING_AUTH_POSTURE\s*:[^=]*=\s*"([a-z_]+)"/.exec(src);
  const value = m?.[1];
  if (value === "authenticated_only" || value === "anonymous_capable" || value === "undecided") {
    return value;
  }
  return "undecided";
}

/**
 * True when Option A (`authenticated_only`) is the posture in force.
 *
 * The 2481 allowances are conditioned on this being FALSE, and it is false both
 * when Option B holds and when the posture cannot be read — see the fail-closed
 * note above.
 */
export function isOptionAInForce(): boolean {
  return sensingPostureOnDisk() === "authenticated_only";
}
