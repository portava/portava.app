/**
 * "Which function does this SQL statement AUTHOR, without a CREATE FUNCTION?"
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Static checks over the migration corpus decide what a function body contains
 * by finding statements that match `CREATE [OR REPLACE] FUNCTION`. That misses
 * an entire class of body. The Trips kernel migrations (2764-2777) do not
 * restate `trip_kernel_execute`; they read the live definition with
 * `pg_get_functiondef`, splice new branches into it inside a `DO` block, and
 * install the result with `EXECUTE`. The calls those branches make end up in
 * the installed prosrc and are as real as any other, but they live in a DO
 * block and no `CREATE FUNCTION` statement contains them.
 *
 * The symptom was concrete and would have caused damage:
 * `checkSecurityDefinerOracles` reported `public.trip_proposal_tally` — called
 * twice by the branches migration 2775 installs — as referenced by NOTHING,
 * and demanded it be dropped or ledgered. Dropping it breaks proposal
 * acceptance; ledgering it records a sentence that is false.
 *
 * ── WHY THE MARKER IS BOTH HALVES ───────────────────────────────────────────
 * A DO block must not be able to buy a function a reference edge merely by
 * NAMING it — 2774's own postcondition calls `trip_proposal_tally(...)` once,
 * to assert the function answers, and that is a migration-time assertion, not a
 * live caller. So a transform is recognised only when the block does both
 * halves of the job:
 *
 *   READS    an existing definition   (`pg_get_functiondef(`), and
 *   INSTALLS one                      (`EXECUTE <var>;`).
 *
 * A block that does one, or neither, is not a transform and counts for nothing.
 */

/** `pg_get_functiondef(` — the block reads a definition it intends to rewrite. */
const TRANSFORM_READS = /\bpg_get_functiondef\s*\(/i;
/** `EXECUTE d;` — the block installs the rewritten definition. */
const TRANSFORM_INSTALLS = /\bEXECUTE\s+[A-Za-z_][A-Za-z0-9_]*\s*;/i;
/** `proname = 'trip_kernel_execute'` — which function it transforms. */
const TRANSFORM_TARGET = /\bproname\s*=\s*'([A-Za-z0-9_]+)'/i;
const DO_BLOCK = /^DO\s/i;

/**
 * The bare, lower-cased name of the function `stmt` transforms, or null when
 * `stmt` is not a transform at all.
 */
export function transformedFunctionName(stmt: string): string | null {
  if (!DO_BLOCK.test(stmt.trim())) return null;
  if (!TRANSFORM_READS.test(stmt)) return null;
  if (!TRANSFORM_INSTALLS.test(stmt)) return null;
  const target = TRANSFORM_TARGET.exec(stmt);
  return target ? target[1]!.toLowerCase() : null;
}
