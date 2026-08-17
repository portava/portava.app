/**
 * shouldRetranslateOnLanguageChange - the gate on the message re-translation sweep.
 *
 * WHY THIS IS ITS OWN MODULE
 * The decision lives in two route handlers (routes/messaging.ts and
 * routes/profile.ts) that have no test harness. Extracting the predicate is the
 * same move filterStripNearest.ts already makes in the mobile app: keep the pure
 * logic where node:test can reach it, rather than leaving it uncovered inside a
 * handler or writing a fake-client test that observes nothing.
 *
 * WHAT IT GUARDS
 * retranslateForUser sweeps up to 200 messages through the translation provider.
 * Both call sites invoked it whenever the user's display language changed, with
 * no reference to whether that user had ever enabled message translation. A user
 * who switched the app to Spanish and had auto-translate off still paid for a
 * 200-message provider sweep.
 */

export interface RetranslateGateInput {
  /** The language after the update. */
  newLanguage: string | null | undefined;
  /** The language before the update, when the caller knows it. */
  oldLanguage?: string | null;
  /** profiles.auto_translate_messages for this user. */
  autoTranslateMessages: boolean | null | undefined;
}

export function shouldRetranslateOnLanguageChange(i: RetranslateGateInput): boolean {
  // Fail closed on an unknown preference. lib/http.ts documents the profile read
  // as fail-open; a transient blip must not spend a user's quota on a feature
  // they never switched on.
  if (i.autoTranslateMessages !== true) return false;
  if (!i.newLanguage) return false;
  // oldLanguage undefined means the caller cannot tell; treat as a change.
  if (i.oldLanguage === undefined) return true;
  return i.newLanguage !== i.oldLanguage;
}
