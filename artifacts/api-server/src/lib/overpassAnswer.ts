/**
 * overpassAnswer — the one reading of an HTTP-200 Overpass body.
 *
 * census-discovery §99 (DV-83 round 3, D-W11X2-18) and §123 (round 24, lane DISC-DV83).
 *
 * Overpass answers a query it could not FINISH with HTTP 200. A query sets `[timeout:N]`; past it, or past the server's
 * memory limit, the body still parses, carries the elements written so far (none, or a set cut in quadtile order, not
 * distance order), and says so only in `remark`:
 *   "runtime error: Query timed out in \"query\" at line 3 after 21 seconds."
 *   "runtime error: Query run out of memory using about 2048 MB of RAM."
 * Every message Overpass puts in `remark` comes from its error-output channel and is prefixed with its kind:
 * `runtime|static|parse|encoding error:` (the query failed, or did not run to the end) or `… remark:` (informational;
 * the answer is whole). So:
 *   - a remark naming an error is an unfinished answer, whatever the elements hold: a cut set is not "the city, smaller";
 *   - a `… remark:` without the word "error" is informational and changes nothing;
 *   - a remark in neither form, a non-string remark, or a JSON body with no `elements` array is not a recognisable
 *     Overpass answer: unfinished (fail-closed).
 *
 * Round 3 wrote this rule inside routes/discovery.ts for GET /discovery's client. Three other modules call Overpass
 * with their own `fetch` (lib/venuesService.ts, lib/localContext.ts, lib/neighborhoodMatch.ts) and read no remark, so a
 * timed-out answer was served, scored or cached there as the place's answer. The rule lives here so every client reads
 * the same body the same way; routes/discovery.ts's `overpassAnswerFailed` delegates to it.
 *
 * WHAT THIS DOES NOT COVER: a query's own `out … N` limit. An answer holding exactly N elements may be the first N of
 * more, and Overpass says nothing either way. Each client's limit is a stated page size of its own, not a failed read.
 *
 * Pure: no network, no imports.
 */

/** True when an HTTP-200 Overpass JSON body does not carry a finished answer. */
export function overpassBodyUnfinished(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return true;
  const body = data as { elements?: unknown; remark?: unknown };
  if (!Array.isArray(body.elements)) return true;
  const remark = body.remark;
  if (remark === undefined || remark === null || remark === "") return false;
  if (typeof remark !== "string") return true;
  return /\berror\b/i.test(remark) || !/^\s*[a-z]+ remark\b/i.test(remark);
}
