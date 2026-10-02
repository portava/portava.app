/**
 * conditionalClaims.ts — claims a migration makes only when a precondition
 * holds in the TARGET database.
 *
 * Lifted out of auditMigrationsVsLive.ts so it can be exercised directly. That
 * script's FIRST import is `ciProdReadOnlyAuditGuard.mjs`, which exits 2 without
 * credentials, so nothing inside it can be imported and asserted on — the same
 * reason #516 moved the migration-block predicates into migrationSqlBlocks.ts.
 * The deciding predicate living in its own module also mirrors how 2481's skip
 * is decided, by `sensingPostureOnDisk.ts` rather than inline.
 *
 * ONE implementation, here. A second copy of an exemption rule drifts, and the
 * copy that drifts quietly is the one that gets believed.
 */
import type { Claim, LiveSchema } from "./schemaClaimResolution.js";
import { isMissing } from "./schemaClaimResolution.js";

// ── CONDITIONAL CLAIMS: A CLAIM THAT DEPENDS ON THE TARGET DATABASE ─────────
//
// Every other exemption in this file is a statement about a FILE ("superseded",
// "drifted", "must never run") or about an OBJECT ("live deliberately differs").
// This one is neither, and using either would have been a false label.
//
// 2976_journey_shadow_global_stop_delete_scope.sql REPAIRS an object rather than
// introducing one. `public.global_journey_shadow_stop_v1` was authored in
// 2127_journey_shadow_controlled_rollout.sql SECTION 9 on branch
// fix/rls-hardening-signin-flake, which was NEVER merged, and applied to
// production out of band. No file in the canonical chain creates it or the nine
// `journey_*` tables it belongs to.
//
// So 2976 is CONDITIONAL by construction: where the out-of-band programme is
// installed it replaces the function's body; where it is not, it RAISE NOTICEs
// and returns, creating nothing. That is not a workaround — it is what makes the
// file replayable onto a database built from its own chain, which is what the
// `kernel SQL executed on a throwaway database` job verifies.
//
// This auditor is name-keyed to text: it reads the `CREATE OR REPLACE FUNCTION`
// inside 2976's guarded `$mig$` block and records an unconditional claim. On
// portava-ci that claim is unmeetable, and the migration is right while the
// claim is wrong.
//
// WHY NOT SKIP_FILES. That list means "superseded or known-drifted", and prints
// exactly that. 2976 is neither: it is current, correct, and APPLIED. It would
// also skip the whole file, which is the opposite of what is wanted — see below.
//
// WHY NOT THE ALLOWLIST. An ALLOWLIST entry means "the object does not exist and
// live deliberately differs", permanently and everywhere. Here the object DOES
// exist — in production, which is the database whose ACLs are worth guarding.
//
// WHY THE CONDITION IS A LIVE FACT, AND NOT "IS THE FUNCTION THERE". The obvious
// shortcut — exempt the claim whenever the function is absent — is circular: it
// is precisely "never report this object missing", and it would stop the auditor
// noticing if someone DROPPED the stop on production. The condition therefore
// keys on something 2976 never creates and cannot fake: the programme's own
// tables, authored by 2127 alongside the function. Measured 2026-09-21 rather
// than assumed --- production carries all nine; portava-ci carries ZERO.
//
//   production  → tables present → the programme is installed here → the claim
//                 MUST hold, and a dropped stop is reported as drift.
//   portava-ci  → tables absent  → the programme was never installed → 2976
//                 correctly created nothing and there is nothing to audit.
//
// `some` rather than `every` on purpose: the exemption applies only when the
// programme is WHOLLY absent, so losing one table does not buy an escape from
// the audit.
//
// IT EXPIRES BY ITSELF, like the 2481 posture skip above. If 2127 is ever
// merged into the chain and the tables land on portava-ci, the condition turns
// true there on the next run and the claim is enforced again, with nobody
// having to remember this entry. If the programme is torn down everywhere, the
// entry stops matching and the staleness assertion below FAILS the run.
export interface ConditionalClaim {
  /** Migration file that makes the claim. */
  file: string;
  /** Claim key, exactly as the extractor forms it. */
  key: string;
  /** The precondition, in words, for the report. */
  precondition: string;
  /** True when the migration DID create the object in THIS database. */
  installedHere(live: LiveSchema): boolean;
}

/** Tables 2127 authored alongside the stop. 2976 creates none of them. */
export const JOURNEY_PROGRAMME_TABLES = [
  "journey_observations",
  "journey_segment_revisions",
  "journey_shadow_ground_truth",
];

export const CONDITIONAL_CLAIMS: ConditionalClaim[] = [
  {
    file: "2976_journey_shadow_global_stop_delete_scope.sql",
    key: "function:global_journey_shadow_stop_v1",
    precondition:
      "the out-of-band 2127 journey-shadow programme is installed in this database " +
      `(any of ${JOURNEY_PROGRAMME_TABLES.join(", ")} exists)`,
    installedHere: (live) =>
      JOURNEY_PROGRAMME_TABLES.some((tbl) => live.relations.has(tbl)),
  },
];

export interface ClaimPartition {
  /** Claims that are genuinely missing and must fail the audit. */
  missing: Claim[];
  /** Conditional claims whose precondition does not hold in this database. */
  notApplicable: string[];
  /** `file|key` of every CONDITIONAL_CLAIMS entry that matched a real claim. */
  matched: string[];
}

/**
 * Split one file's claims into "missing" and "did not apply here".
 *
 * A conditional claim is exempted ONLY when it is absent AND its precondition is
 * false in this database. Where the precondition holds the claim is enforced
 * exactly as any other — which is what keeps production's copy audited and makes
 * a dropped object there a failure.
 */
export function partitionClaims(
  file: string,
  claims: Claim[],
  live: LiveSchema,
  allowlist: ReadonlySet<string>,
  conditional: readonly ConditionalClaim[] = CONDITIONAL_CLAIMS,
): ClaimPartition {
  const forFile = conditional.filter((x) => x.file === file);
  const matched: string[] = [];
  for (const c of claims) {
    const cond = forFile.find((x) => x.key === c.key);
    if (cond) matched.push(`${cond.file}|${cond.key}`);
  }
  const notApplicable: string[] = [];
  const missing = claims.filter((c) => {
    if (allowlist.has(c.key)) return false;
    if (!isMissing(c, live)) return false;
    const cond = forFile.find((x) => x.key === c.key);
    if (cond && !cond.installedHere(live)) {
      notApplicable.push(`${file}: ${c.label} — ${cond.precondition} is false here`);
      return false;
    }
    return true;
  });
  return { missing, notApplicable, matched };
}

/** CONDITIONAL_CLAIMS entries that matched no claim — dead exemptions. */
export function staleEntries(
  matched: ReadonlySet<string>,
  conditional: readonly ConditionalClaim[] = CONDITIONAL_CLAIMS,
): ConditionalClaim[] {
  return conditional.filter((x) => !matched.has(`${x.file}|${x.key}`));
}
