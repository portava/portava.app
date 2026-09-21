/**
 * Telegraph §26/§27 certification contracts.
 *
 * Telegraph spec (v1 and v1_1 — v1_1's shared body is a byte-exact superset of
 * v1, so these section numbers mean the same thing in both):
 *
 *   §26  RLS & Authorization Test Matrix — ten cases, each with an expected
 *        outcome (DENY / ALLOW / immediate downgrade).
 *   §27.1 Property invariants — seven properties that must hold over ALL
 *        inputs, not over a fixture.
 *   §27.2 Adversarial fixtures — twelve named races and abuses.
 *   §27.3 Live-DB contract checks — six standing checks against a real schema.
 *
 * WHY THESE ARE DECLARATIONS AND NOT PROSE
 * ----------------------------------------
 * A certification plan written only in a document cannot go red. These
 * declarations are read by `src/scripts/checkTelegraphCertification.ts`, which
 * fails CI when:
 *
 *   - a declared case has no test naming its id,
 *   - a declared `enforcedBy` path does not exist on disk,
 *   - or the number of entries whose status is NOT `enforced` grows.
 *
 * That last rule is the point. Six of the twenty-eight entries below are
 * `divergent` or `flag_gated` today — the expected outcome is not what the tree
 * does on a default deployment. Recording them as data with a shrink-only
 * ratchet is the difference between a known divergence and a forgotten one, and
 * it makes the fix observable: when §14.3's history bound is enabled by
 * default, RLS-03 moves to `enforced`, the ratchet baseline must shrink, and
 * the test that asserts today's unbounded read goes red and forces the change.
 *
 * STATUS VOCABULARY — chosen so that no entry can be quietly rounded up:
 *
 *   enforced    The tree produces the expected outcome on EVERY deployment of
 *               this code, with no flag and no migration in between.
 *   flag_gated  The mechanism is built and tested, but a default deployment
 *               does not run it (flag seeded off, or the migration that backs
 *               it is not applied anywhere). BUILT ON BRANCH IS NOT DEPLOYED.
 *   divergent   The tree produces a DIFFERENT outcome from the expected one.
 *   vacuous     The case cannot arise because the feature it tests does not
 *               exist. Recorded, never credited.
 */

/** Outcome the spec's matrix demands for a case. */
export type MatrixExpectation =
  | "DENY"
  | "ALLOW"
  | "DOWNGRADE_IMMEDIATELY"
  | "DISABLE_IMMEDIATELY";

/** How close the tree is to the declared expectation. See the header. */
export type EnforcementStatus = "enforced" | "flag_gated" | "divergent" | "vacuous";

export interface CertificationEntry {
  /** Stable id. Tests must name it verbatim; the guard greps for it. */
  readonly id: string;
  /** The row this entry answers in docs/architecture/census-telegraph.md. */
  readonly censusRow: string;
  /** The spec clause, quoted or closely paraphrased. */
  readonly requirement: string;
  readonly status: EnforcementStatus;
  /**
   * Repo-relative paths (from the api-server package root) of the artifacts
   * that produce the outcome. Every path is checked to exist; a citation that
   * has been deleted or renamed fails the guard rather than rotting.
   */
  readonly enforcedBy: readonly string[];
  /**
   * What the entry actually establishes, and — for anything not `enforced` —
   * what exactly would have to change for it to become `enforced`.
   */
  readonly note: string;
}

export interface RlsMatrixCase extends CertificationEntry {
  readonly expected: MatrixExpectation;
}

export interface PropertyInvariant extends CertificationEntry {
  /**
   * The quantifier the property runs over, stated so a reader can tell a
   * property test from a case test: "for all X, f(X) <= g(X)".
   */
  readonly quantifier: string;
}

export interface AdversarialFixture extends CertificationEntry {
  /** The interleaving or abuse the fixture drives. */
  readonly scenario: string;
}

export interface LiveDbContract extends CertificationEntry {
  /**
   * The standing check that enforces this contract, as its package.json
   * script name (e.g. "check:missing-live-columns"). The guard verifies the
   * script exists in package.json — a contract naming a script nobody can run
   * is not a contract.
   */
  readonly checkScript: string | null;
}
