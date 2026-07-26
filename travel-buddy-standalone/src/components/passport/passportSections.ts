/**
 * Passport section ordering — shared constants + helpers.
 *
 * The owner's passport screen is composed of five reorderable sections.
 * Order is persisted on the profile (`passportSectionOrder`). Visitor /
 * public views always use CANONICAL_SECTION_ORDER.
 */

export type PassportSectionKey = 'identity' | 'stamps' | 'highlights' | 'tabs' | 'dossier';

export const CANONICAL_SECTION_ORDER: PassportSectionKey[] = [
  'identity',
  'stamps',
  'highlights',
  'tabs',
  'dossier',
];

export const SECTION_LABELS: Record<PassportSectionKey, string> = {
  identity: 'Identity Card',
  stamps: 'Stamps',
  highlights: 'Highlights',
  tabs: 'Posts & Tabs',
  dossier: 'Dossier',
};

/**
 * Sanitize a stored order: returns a valid permutation of all five keys.
 * Unknown keys are dropped, missing keys are appended in canonical order.
 * Falls back to canonical order for null/invalid input.
 */
export function resolveSectionOrder(stored: string[] | null | undefined): PassportSectionKey[] {
  if (!stored || stored.length === 0) return CANONICAL_SECTION_ORDER;
  const seen = new Set<PassportSectionKey>();
  const out: PassportSectionKey[] = [];
  for (const k of stored) {
    if ((CANONICAL_SECTION_ORDER as string[]).includes(k) && !seen.has(k as PassportSectionKey)) {
      seen.add(k as PassportSectionKey);
      out.push(k as PassportSectionKey);
    }
  }
  for (const k of CANONICAL_SECTION_ORDER) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}

export function isCanonicalOrder(order: PassportSectionKey[]): boolean {
  return order.every((k, i) => k === CANONICAL_SECTION_ORDER[i]);
}

/**
 * The 'identity' card cannot be hidden — the owner always sees their own identity section.
 */
export const NON_HIDEABLE_SECTIONS: PassportSectionKey[] = ['identity'];

/**
 * Sanitize stored hidden-section data: returns a Set of valid, hideable section keys.
 * Unknown keys and non-hideable keys (identity) are silently dropped.
 * Returns an empty Set for null/absent input.
 */
export function resolveHiddenSections(stored: string[] | null | undefined): Set<PassportSectionKey> {
  if (!stored || stored.length === 0) return new Set();
  const hideable = CANONICAL_SECTION_ORDER.filter((k) => !NON_HIDEABLE_SECTIONS.includes(k));
  const out = new Set<PassportSectionKey>();
  for (const k of stored) {
    if ((hideable as string[]).includes(k)) {
      out.add(k as PassportSectionKey);
    }
  }
  return out;
}
