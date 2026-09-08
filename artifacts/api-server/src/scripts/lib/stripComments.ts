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
    for (;;) {
      const begin = line.indexOf("/*");
      if (begin === -1) break;
      const end = line.indexOf("*/", begin + 2);
      if (end === -1) { line = line.slice(0, begin); inBlock = true; break; }
      line = line.slice(0, begin) + line.slice(end + 2);
    }
    const slashes = line.indexOf("//");
    if (slashes !== -1) line = line.slice(0, slashes);
    out.push(line);
  }
  return out.join("\n");
}
