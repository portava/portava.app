/**
 * A source file with its comments removed.
 *
 * ── WHY THIS IS SHARED ───────────────────────────────────────────────────────
 * Four separate guards in this tree shipped the same bug: they answered a
 * question about CODE by matching the RAW FILE TEXT, and comments are raw file
 * text. Each one failed in the direction that made it useless:
 *
 *   checkStateMachineWriters   `// startTrustMaintenanceScheduler();` counted as
 *                              a start call, so commenting the scheduler out left
 *                              the guard green on the exact regression it exists
 *                              to catch.
 *   checkProjectionConsumers   the identical bug in rule 5.
 *   check-guard-coverage       a test's own run instruction
 *                              (`* Run: SUPABASE_URL=… node --test …`) classified
 *                              32 pure unit tests as able to reach the database,
 *                              taking the first check in check:all permanently
 *                              red on nothing.
 *   checkGuardReachability     a COMMENT naming a test seam made its own
 *                              real-tree control look like a fixture run.
 *
 * So the stripper lives in one place. `callsFunction` is the boolean built on it.
 *
 * ── AND THEN THE SHARED STRIPPER SHIPPED THE SAME CLASS OF BUG ───────────────
 * Consolidating the logic did not make it right. Until 2026-09-08 this function
 * looked for `/*` BEFORE `//` on each line, so a line comment containing `/*`
 * opened a block comment that swallowed everything up to the next block-close
 * marker (which cannot be written here: inside this very comment it would end
 * it — which is itself a small demonstration of why this is fiddly). One
 * `// … /api/buddy-bookings/*` in routes/rentABuddySpec.ts hid ~969 lines,
 * including a state-machine writer, from every guard built on this. Across
 * src/ it erased 2,510 non-blank code lines in 12 files. The lesson is the one
 * above, one level up: a helper that answers "what is the CODE here" is itself
 * load-bearing, and it needs its own adversarial test rather than the trust of
 * its callers. src/test/stripComments.test.ts is that test.
 *
 * ── THE DELIBERATE CONSERVATIVE DIRECTION ────────────────────────────────────
 * String literals are NOT parsed, so a `//` inside a string (a URL, say)
 * truncates the rest of that line. That can only ever remove text, never invent
 * it — so a caller asking "is this thing present in the code?" can get a false
 * NO and never a false YES. Every caller above wants exactly that direction:
 * ambiguity fails the guard loudly instead of passing it quietly.
 *
 * Line count is preserved so a caller can still report a line number.
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) { out.push(""); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    // WHICHEVER OPENS FIRST WINS. Scanning for `/*` before `//` was a bug, not
    // a simplification: a line comment containing `/*` — an ordinary URL or
    // glob such as `// see /api/buddy-bookings/*` — opened a block comment that
    // ran until the NEXT `*/` anywhere in the file. Measured over src/ at the
    // time of the fix: 12 files affected and 2,510 non-blank lines of real code
    // erased from what every caller was looking at, 969 of them in one route
    // file and 67 in routes/index.ts. That is the failure direction this module
    // exists to prevent — a guard cannot find a defect in text it was handed as
    // blank lines, and it reports the resulting silence as a pass.
    for (;;) {
      const block = line.indexOf("/*");
      const lineComment = line.indexOf("//");
      if (block === -1 && lineComment === -1) break;
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        // Everything from here is a line comment, `/*` included. It opens nothing.
        line = line.slice(0, lineComment);
        break;
      }
      const end = line.indexOf("*/", block + 2);
      if (end === -1) { line = line.slice(0, block); inBlock = true; break; }
      // Keep scanning the remainder: a `//` after a closed block comment on the
      // same line is still a line comment.
      line = line.slice(0, block) + line.slice(end + 2);
    }
    out.push(line);
  }
  return out.join("\n");
}
