/**
 * The profile's interest vocabulary: the keys `profiles.interests` stores and
 * the labels the Interests screen shows for them.
 *
 * Moved here, unchanged, from `app/profile/edit/interests.tsx` so the interest
 * FIELD's shipped list (`platform/input-assistance/data/interests.ts`, lead
 * ruling PR-D2-10) can be held to it by a test. It is a superset of
 * `about.tsx`'s SOCIAL_INTEREST_OPTIONS and PassportAboutSection's
 * INTEREST_LABEL map. Pure data; no React.
 */
export interface ProfileInterestOption {
  readonly key: string;
  readonly label: string;
}

export const PROFILE_INTEREST_OPTIONS: readonly ProfileInterestOption[] = [
  { key: 'food',          label: 'Food' },
  { key: 'photography',   label: 'Photography' },
  { key: 'nightlife',     label: 'Nightlife' },
  { key: 'wellness',      label: 'Wellness' },
  { key: 'shopping',      label: 'Shopping' },
  { key: 'nature',        label: 'Nature' },
  { key: 'history',       label: 'History' },
  { key: 'architecture',  label: 'Architecture' },
  { key: 'music',         label: 'Music' },
  { key: 'art',           label: 'Art' },
  { key: 'sport',         label: 'Sport' },
  { key: 'reading',       label: 'Reading' },
  { key: 'beach',         label: 'Beach' },
  { key: 'luxury',        label: 'Luxury' },
  { key: 'culture',       label: 'Culture' },
  { key: 'adventure',     label: 'Adventure' },
  { key: 'backpacking',   label: 'Backpacking' },
  { key: 'business',      label: 'Business' },
  { key: 'dating',        label: 'Social' },
  { key: 'events',        label: 'Events' },
];
