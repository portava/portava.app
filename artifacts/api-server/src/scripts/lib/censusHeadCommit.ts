/**
 * Reading a census's `head_commit` declaration, and telling a MALFORMED one
 * from a DELIBERATELY ABSENT one.
 *
 * WHY THIS IS ITS OWN FILE
 * ========================
 * `check:census-freshness` has three outcomes for a census, and they are not
 * equally severe:
 *
 *   FRESH / STALE     it declared a commit and was checked
 *   undeclared        it declares none. Legitimate — census-passport.md says
 *                     in prose that it does so deliberately — and reported as
 *                     "CANNOT BE CHECKED" without failing the run.
 *   malformed         it TRIED to declare one and the parser could not read it
 *
 * The third had no branch. It fell into the second, so a census whose author
 * had just written a commit hash into it was reported as one that never had,
 * and the run passed.
 *
 * That is not hypothetical. On 2026-09-09 census-trips' declaration was written
 * as `| **`c3f76a49`** — …`, with the bold marks between the pipe and the hash.
 * The regex missed it, the run said "no head_commit declared — CANNOT BE
 * CHECKED", and `check:census-freshness PASSED`. The document was aged by
 * nothing while looking, to its author, like it was being aged.
 *
 * The discriminator is the ROW SHAPE, not the word. A census that MENTIONS
 * head_commit in prose is not making a declaration; a line that opens a table
 * cell with it and yields no hash is a botched one.
 */

/** `| head_commit | <sha> …` — the hash must follow the pipe, prose after it. */
const DECLARATION = /head_commit`?\s*\|\s*`?([0-9a-f]{7,40})/i;

/** A line that opens a table cell with head_commit, however it is decorated. */
const DECLARATION_ROW = /^\s*\|?\s*\**\s*`?head_commit`?\s*\**\s*\|/im;

export type HeadCommitRead =
  | { kind: "declared"; commit: string }
  /** No declaration row at all. A legitimate state for a census that says so. */
  | { kind: "absent" }
  /** A declaration row that yields no hash. Always a failure. */
  | { kind: "malformed" };

export function readHeadCommit(text: string): HeadCommitRead {
  const m = DECLARATION.exec(text);
  if (m) return { kind: "declared", commit: m[1]! };
  return DECLARATION_ROW.test(text) ? { kind: "malformed" } : { kind: "absent" };
}

/** What a malformed row should have looked like. One place, so the error text
 *  and the parser cannot drift apart. */
export const HEAD_COMMIT_ROW_SHAPE =
  "The row must read `| `head_commit` | `<sha>` |` — the hash immediately after the pipe, " +
  "optionally backticked, with any prose AFTER it. Bold marks, links or words between the pipe " +
  "and the hash make the declaration invisible to this check, which would then report the census " +
  "as undeclared and pass.";
