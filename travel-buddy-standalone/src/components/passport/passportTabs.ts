/**
 * Passport tab ordering — shared constants + helpers.
 *
 * The five core content tabs are always present; owners can reorder them.
 * Order is persisted on the profile (`passportTabOrder`).
 * Public / visitor views display the owner's saved order.
 */

export type PassportTabKey = 'postcards' | 'memories' | 'plans' | 'stamps' | 'map' | 'destinations';

export const CANONICAL_TAB_ORDER: PassportTabKey[] = [
  'postcards',
  'memories',
  'plans',
  'stamps',
  'map',
  'destinations',
];

export const TAB_LABELS: Record<PassportTabKey, string> = {
  postcards:    'Postcards',
  memories:     'Memories',
  plans:        'Plans',
  stamps:       'Stamps',
  map:          'Map',
  destinations: 'Destinations',
};

/**
 * Sanitize a stored order: returns a valid permutation of all five tab keys.
 * Unknown keys are dropped, missing keys are appended in canonical order.
 * Falls back to canonical order for null/invalid input.
 */
export function resolveTabOrder(stored: string[] | null | undefined): PassportTabKey[] {
  if (!stored || stored.length === 0) return CANONICAL_TAB_ORDER;
  const seen = new Set<PassportTabKey>();
  const out: PassportTabKey[] = [];
  for (const k of stored) {
    if ((CANONICAL_TAB_ORDER as string[]).includes(k) && !seen.has(k as PassportTabKey)) {
      seen.add(k as PassportTabKey);
      out.push(k as PassportTabKey);
    }
  }
  for (const k of CANONICAL_TAB_ORDER) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}

export function isCanonicalTabOrder(order: PassportTabKey[]): boolean {
  return order.every((k, i) => k === CANONICAL_TAB_ORDER[i]);
}
