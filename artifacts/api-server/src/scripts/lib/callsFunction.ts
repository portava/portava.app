/**
 * "Is this function actually CALLED here?" — comment-aware.
 *
 * ── WHY THIS IS NOT A ONE-LINE REGEX ─────────────────────────────────────────
 * Several guards in this tree assert that an async producer is actually started
 * from its entry point, because an unstarted producer fills nothing and its
 * consumers then read an empty table for ever. The obvious implementation —
 *
 *     new RegExp(`${name}\\s*\\(`).test(readFileSync(entry, "utf8"))
 *
 * — matches inside a COMMENT. So commenting out `startTrustMaintenanceScheduler();`
 * in index.ts left `check:state-machine-writers` GREEN at exit 0 on exactly the
 * regression it exists to catch. That was measured, not theorised, and the
 * identical bug was then found in `checkProjectionConsumers.ts` rule 5.
 *
 * Commenting a start call out is not a hypothetical edit either: it is the most
 * likely way a scheduler ever stops running (someone disables it while debugging
 * and does not put it back). A guard that cannot see that is decorative.
 *
 * ── THE DELIBERATE CONSERVATIVE DIRECTION ────────────────────────────────────
 * This strips block comments and line comments without parsing string literals,
 * so a `//` INSIDE a string (a URL, say) truncates the rest of that line. That
 * can only ever cause a call to be MISSED, never invented — i.e. ambiguity fails
 * loudly rather than passing quietly, which is the right direction for a guard
 * whose whole job is to notice a missing call.
 */
import { stripComments } from "./stripComments.js";

export function callsFunction(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(stripComments(text));
}
