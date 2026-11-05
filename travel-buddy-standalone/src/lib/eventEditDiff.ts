/**
 * eventEditDiff — what an event edit save sends.
 *
 * EventComposerSheet in edit mode used to send every field plus
 * `state: 'open'`. PATCH /events/:id pushes "Event updated" to everyone going
 * whenever a time or place field is in the body, so fixing a typo in the
 * description notified the whole guest list; it refuses a co-host any body
 * that carries state or visibility, so a co-host could never save; and it
 * moved a full or waitlisted event back to open. The save now sends only the
 * fields that changed.
 */

/** Optional details a host can empty in the edit form; PATCH takes null for each. */
const CLEARABLE_ON_EDIT = new Set([
  'description', 'locationName', 'city', 'country', 'category',
  'maxAttendees', 'ageMin', 'ageMax', 'trustScoreMin',
]);

/**
 * The fields of `next` that differ from `initial`, for an edit save.
 * The form gives an empty field as undefined: a clearable detail that had a
 * value is sent as null (cleared), "verified only" switched off is sent as
 * false, and any other empty field is left as it is.
 */
export function changedFields(
  next: Record<string, unknown>,
  initial: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = initial[k] ?? null;
    if (v === undefined) {
      if (before === null) continue;
      if (k === 'verifiedOnly') out[k] = false;
      else if (CLEARABLE_ON_EDIT.has(k)) out[k] = null;
      continue;
    }
    if (JSON.stringify(v) !== JSON.stringify(before)) out[k] = v;
  }
  return out;
}
