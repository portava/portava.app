/**
 * Global Input Intelligence — selection memory / recents (spec §32, §35).
 *
 * The engine may learn from repeated EXPLICIT selections, never inferred private
 * facts (§35). Recents should be device-local where allowed (§32) so cold-start
 * / offline still shows useful zero-state.
 *
 * ── WHAT THIS FILE WAS, AND WHY THAT WAS A DEFECT (census G261, 2026-10-07) ──
 *
 * Until 2026-10-07 this module kept its OWN in-memory `Map` of
 * `{ value, label, at }`, written by `localZeroState.recordLocalSelection` on
 * every explicit accept and read by nothing in the app. The device-local recents
 * (`localZeroState.ts`, G199/G216) were built beside it as a second store, and
 * the account-change wipe (`policySync.ts#applyAccountChange` →
 * `clearLocalRecents`) erases THAT store, process and device. It never reached
 * this one. So after a sign-out or an account switch the previous person's
 * picks — canonical ids and display labels — stayed in process memory behind an
 * exported reader, `getRecentSelections`, waiting for the first consumer to
 * serve them to the next person. A second copy of personal data that the
 * privacy control does not know about is the defect, whether or not anything
 * reads it yet.
 *
 * ── WHAT IT IS NOW ───────────────────────────────────────────────────────────
 *
 * A READ VIEW over the one store. There is no second buffer and no second
 * writer: `recordLocalSelection` is the only write, the device-local blob is the
 * only persistence, and `clearLocalRecents` is the only erase an account change
 * needs. Every read is gated against the LIVE policy by the same predicate the
 * zero-state uses (`mayRetainLocally`), so a field whose privacy class forbids
 * retention — or a field with no resolvable policy — reads nothing, and a field
 * the authority has since reclassified reads nothing however warm the disk is.
 *
 * `recordSelection(context, …)` is gone rather than redirected. It took a
 * `{ value, label }` pair and no policy, so it could neither apply the write
 * gate nor produce a row the zero-state could replay without inventing an
 * action (§13) — see `localZeroState.ts`'s "WHY A SECOND BUFFER" note.
 *
 * Kept dependency-free (no AsyncStorage/supabase import) so it is safe to import
 * anywhere, including node:test. The storage port is bound by
 * `installLocalRecents.ts`.
 */
import type { InputContext } from '../types/inputContext.ts';
import {
  localZeroState,
  clearLocalRecents,
  forgetLocalRecents,
  type LocalZeroStatePolicy,
} from './localZeroState.ts';

export interface RecentSelection {
  /** Canonical entity id (or the server's replacement text / row id). */
  value: string;
  label: string;
}

/**
 * Read the explicit selections retained for a field, most-recent first (§14
 * zero-state). Fail-closed: no policy, or a policy whose privacy class forbids
 * retention, reads `[]`.
 */
export function getRecentSelections(
  policy: LocalZeroStatePolicy | null | undefined,
  limit?: number,
): RecentSelection[] {
  if (!policy) return [];
  const max = typeof limit === 'number' ? Math.max(0, Math.min(limit, policy.maxSuggestions)) : policy.maxSuggestions;
  return localZeroState({ ...policy, maxSuggestions: max }).map((s) => ({
    value: s.entityId ?? s.replacementText ?? s.id,
    label: s.label,
  }));
}

/**
 * Erase retained selections. With a context: that field's, in process memory
 * AND on the device. Without one: everything — the same erase an account change
 * performs.
 */
export function clearRecentSelections(context?: InputContext): void {
  if (context) forgetLocalRecents(context);
  else clearLocalRecents();
}
