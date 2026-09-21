/**
 * §32 G197 / §34 G212 — the SHIPPED interest dictionary.
 *
 * ── HOW THIS SET WAS BOUNDED ─────────────────────────────────────────────────
 *
 * It is the API server's own `COMMON_INTERESTS` list
 * (`artifacts/api-server/src/routes/discoverySearch.ts:370`), copied verbatim,
 * in the same order. The same copy-not-import reasoning as `languages.ts`
 * applies, for the same workspace-boundary reason, with the same consequence:
 * drift between the two shows up as an offline answer slightly older than the
 * online one, never as a wrong one, because these rows exist only while the
 * server cannot answer.
 *
 * WHAT IT OMITS: user-authored interests. Portava's interest field is not a
 * closed vocabulary — a person may type anything — and this list is the common
 * head of it, not its definition. Nothing here narrows what a person may
 * submit: an unmatched query falls through to the raw text (§2).
 */
import type { LocalDictionaryEntry } from './types.ts';

export const INTEREST_DICTIONARY: readonly LocalDictionaryEntry[] = [
  { label: 'Travel' },
  { label: 'Photography', aliases: ['Photo'] },
  { label: 'Hiking', aliases: ['Trekking'] },
  { label: 'Food', aliases: ['Foodie', 'Eating'] },
  { label: 'Music' },
  { label: 'Art' },
  { label: 'Technology', aliases: ['Tech'] },
  { label: 'Sports' },
  { label: 'Fashion' },
  { label: 'Fitness', aliases: ['Gym'] },
  { label: 'Cooking' },
  { label: 'Reading', aliases: ['Books'] },
  { label: 'Gaming', aliases: ['Games'] },
  { label: 'Dancing', aliases: ['Dance'] },
  { label: 'Cinema', aliases: ['Film', 'Movies'] },
  { label: 'Nature', aliases: ['Outdoors'] },
  { label: 'Architecture' },
  { label: 'Surfing' },
  { label: 'Skiing' },
  { label: 'Yoga' },
  { label: 'Cycling', aliases: ['Biking'] },
  { label: 'Running' },
  { label: 'Swimming' },
  { label: 'Diving', aliases: ['Scuba'] },
  { label: 'Culture' },
  { label: 'History' },
  { label: 'Languages' },
  { label: 'Volunteering' },
  { label: 'Nightlife' },
  { label: 'Wellness' },
];
