/**
 * §32 G197 / §34 G212 — the SHIPPED interest dictionary, mapped onto the
 * profile's interest keys (lead ruling PR-D2-10, 2026-10-08).
 *
 * ── WHAT IT WAS, AND WHY IT CHANGED ──────────────────────────────────────────
 *
 * It was a verbatim copy of the API server's `COMMON_INTERESTS` (Discovery's
 * interest vocabulary): Travel, Hiking, Technology, Fashion, … The profile's
 * interest set is a different vocabulary — the twenty keys the Interests screen
 * offers (`src/lib/profile/interestOptions.ts`: food, photography, nightlife, …)
 * — so a pick from this list could write a value no profile surface reads.
 *
 * The ruling: map the shipped list onto the profile's existing keys, never
 * changing a key, and do not offer an entry that has no key. Each entry below is
 * a shipped entry whose meaning IS a profile key, labelled with the profile's
 * own label for that key ("Sports" → Sport); `code` is that key. Every other
 * shipped word (Travel, Hiking, Technology, Fashion, Fitness, Cooking, Gaming,
 * Dancing, Cinema, Surfing, Skiing, Yoga, Cycling, Running, Swimming, Diving,
 * Languages, Volunteering) has no key of its own and is not offered.
 *
 * The server answers the interest field from the SAME list, in the same order
 * (`artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts`,
 * `PROFILE_INTEREST_VOCABULARY`); `src/test/inputLocalSufficiencyParity.test.ts`
 * holds the two lists to each other and every `code` to a profile key and its
 * label. Discovery's search vocabulary is untouched.
 *
 * `code` is provenance (see `types.ts`): the Interests screen reads it to store
 * the key; it is never projected onto a suggestion as an identity.
 */
import type { LocalDictionaryEntry } from './types.ts';

export const INTEREST_DICTIONARY: readonly LocalDictionaryEntry[] = [
  { label: 'Photography', code: 'photography', aliases: ['Photo'] },
  { label: 'Food', code: 'food', aliases: ['Foodie', 'Eating'] },
  { label: 'Music', code: 'music' },
  { label: 'Art', code: 'art' },
  { label: 'Sport', code: 'sport', aliases: ['Sports'] },
  { label: 'Reading', code: 'reading', aliases: ['Books'] },
  { label: 'Nature', code: 'nature', aliases: ['Outdoors'] },
  { label: 'Architecture', code: 'architecture' },
  { label: 'Culture', code: 'culture' },
  { label: 'History', code: 'history' },
  { label: 'Nightlife', code: 'nightlife' },
  { label: 'Wellness', code: 'wellness' },
];

/** The profile interest key a picked interest row stands for, or null for a label this list does not offer. */
export function interestKeyForLabel(label: string | null | undefined): string | null {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return null;
  const hit = INTEREST_DICTIONARY.find((e) => e.label.toLowerCase() === l);
  return hit?.code ?? null;
}
