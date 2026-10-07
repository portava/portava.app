/**
 * mediaPrivacy — the client's privacy state for a media composer (spec §33
 * Privacy Model, §34 Delayed Publishing; census-media MD321).
 *
 * Privacy is DECIDED on the server (lib/postSchemas.mapPublicPost, the post
 * create defaults, lib/mediaLocationVisibility.locationPrivacyModeToCeiling)
 * and this module decides nothing. What it owns is the other half, which the
 * composer used to hard-code: what each choice will actually DO, in words a
 * person can act on. A privacy control whose copy promises more than the
 * server delivers is worse than no control, because the person relies on it.
 *
 * So every statement below is derived from one table, DISCLOSURE, which is a
 * transcription of the server's behaviour — and a server-side parity test
 * (artifacts/api-server/src/test/mediaPrivacyClientParity.test.ts) runs this
 * table against the server's own functions, so the two cannot drift silently.
 *
 * WHAT THE TABLE SAYS, MEASURED AGAINST THE SERVER (2026-09-26):
 *   • Every mode other than `none` withholds the tagged place's NAME from
 *     everyone but the author. City and country stay attached to the post
 *     (`location_city` / `location_country` are in every public post read).
 *   • `hidden` and `trusted_circle_only` disclose exactly what `city_only`
 *     does. There is no Trusted-Circle-only reveal anywhere on the server —
 *     the circle sees what everyone sees.
 *   • The two delayed modes hold the WHOLE post (not only its place) until the
 *     release: public reads filter on `post_status = 'published'`.
 *   • `none` sent from a composer with a place attached is not "now": the
 *     client omits the field for `none`, and the server's default for a tagged
 *     post is `delayed_until_exit`. `effectiveMode` says so.
 *
 * Pure — no imports — so the parity test on the server can load it.
 */

/** §33 LocationVisibility — the six tiers, coarsest-but-hidden first (mirrors 2250's CHECK). */
export type LocationVisibility = 'hidden' | 'country' | 'city' | 'neighborhood' | 'place' | 'precise_private';

/** The post API's location privacy modes (identical to services/posts.ts `LocationPrivacyMode`). */
export type ComposerLocationMode =
  | 'none'
  | 'hidden'
  | 'city_only'
  | 'delayed_until_exit'
  | 'delayed_until_time'
  | 'trusted_circle_only' | 'neighborhood_only'; // neighborhood_only: spec §34 "Show neighborhood only" (migration 3350, census-media §36)

export const COMPOSER_LOCATION_MODES: readonly ComposerLocationMode[] = [
  'none',
  'hidden',
  'city_only',
  'delayed_until_exit',
  'delayed_until_time',
  'trusted_circle_only', 'neighborhood_only',
] as const;

/** When the post itself becomes visible to anyone but its author. */
export type Release = 'now' | 'after_exit' | 'at_time';

/**
 * How long a released "After I leave" post shows its place to others before it
 * falls to the city (census-media MD79, lead ruling D-26f). Mirrors the server's
 * RELEASED_DELAYED_PLACE_WINDOW_MS (lib/postLocationDisclosureLifetime); the
 * server parity test fails if the two differ.
 */
export const RELEASED_PLACE_WINDOW_HOURS = 24;

export interface LocationDisclosure {
  /** The finest §33 tier a non-author can learn about the place, once the post is visible to them. */
  tier: LocationVisibility;
  /** The tagged place's name reaches non-authors. */
  placeName: boolean;
  city: boolean;
  country: boolean;
  release: Release;
  /** Some audience (e.g. a Trusted Circle) sees MORE than everyone else. Never true today. */
  anyAudienceSeesMore: boolean;
}

const WITHHELD_NAME: Omit<LocationDisclosure, 'release'> = {
  tier: 'city',
  placeName: false,
  city: true,
  country: true,
  anyAudienceSeesMore: false,
};

/**
 * What a non-author can learn, per mode, from the moment the post is visible to
 * them. For a delayed mode this is the state BEFORE release; after release the
 * server discloses the place name (`mapPublicPost` passes a published delayed
 * post through), which is what "delayed" means.
 */
export const DISCLOSURE: Readonly<Record<ComposerLocationMode, LocationDisclosure>> = {
  none: { tier: 'place', placeName: true, city: true, country: true, release: 'now', anyAudienceSeesMore: false },
  hidden: { ...WITHHELD_NAME, release: 'now' },
  city_only: { ...WITHHELD_NAME, release: 'now' },
  trusted_circle_only: { ...WITHHELD_NAME, release: 'now' },
  delayed_until_exit: { ...WITHHELD_NAME, release: 'after_exit' },
  delayed_until_time: { ...WITHHELD_NAME, release: 'at_time' }, neighborhood_only: { ...WITHHELD_NAME, tier: 'neighborhood', release: 'now' }, // §34: the venue is withheld as for city_only; the tier is the neighbourhood, and only the Media World views know a neighbourhood label — elsewhere a non-author sees the city
};

/** Unknown input is read as the strictest delayed mode — never as `none`. */
function normalize(mode: unknown): ComposerLocationMode {
  return (COMPOSER_LOCATION_MODES as readonly unknown[]).includes(mode)
    ? (mode as ComposerLocationMode)
    : 'delayed_until_exit';
}

export function disclosureFor(mode: unknown): LocationDisclosure {
  return DISCLOSURE[normalize(mode)];
}

/**
 * The mode the SERVER will apply to what the composer sends. `none` is sent as
 * an absent field (see `locationRequestFields`), and for a post with a place
 * the server's default is `delayed_until_exit` — so "Now" with a place attached
 * is, today, "after you leave". Without a place there is nothing to delay.
 */
export function effectiveMode(mode: unknown, hasPlace: boolean): ComposerLocationMode {
  const m = normalize(mode);
  if (m === 'none' && hasPlace) return 'delayed_until_exit';
  return m;
}

/** The §34 choices the post API can carry, in the order the composer offers them. */
export const LOCATION_CHOICES: ReadonlyArray<{ mode: ComposerLocationMode; label: string }> = [
  { mode: 'delayed_until_exit', label: 'After I leave' },
  { mode: 'delayed_until_time', label: 'At a time' },
  { mode: 'city_only', label: 'City only' },
  { mode: 'none', label: 'Now' },
  { mode: 'hidden', label: 'Hidden' },
  { mode: 'trusted_circle_only', label: 'Trusted circle' },
];

function clock(at: Date): string {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One sentence saying what this choice will do, derived from the disclosure
 * table and the effective mode — never a promise the table does not back.
 */
export function locationPrivacyHint(
  mode: unknown,
  opts: { hasPlace: boolean; scheduledTime?: Date | null },
): string {
  const chosen = normalize(mode);
  const applied = effectiveMode(chosen, opts.hasPlace);
  const d = DISCLOSURE[applied];
  const kept = 'Your city and country stay on the post.';
  if (chosen === 'none' && applied !== 'none') {
    return `A post with a place is held until you've left it, then published with the place for up to ${RELEASED_PLACE_WINDOW_HOURS} hours — after that, only your city and country. Sharing a place instantly isn't available yet.`;
  }
  if (d.placeName) return 'Published now, with the place you tagged.';
  if (d.release === 'after_exit') {
    return `Your post waits until you've left this spot, then appears with the place for up to ${RELEASED_PLACE_WINDOW_HOURS} hours — after that, only your city and country.`;
  }
  if (d.release === 'at_time') {
    return opts.scheduledTime
      ? `Your post appears at ${clock(opts.scheduledTime)}, with the place.`
      : 'Pick a time for your post to appear.';
  }
  if (applied === 'neighborhood_only') {
    return 'Nobody sees the place you tagged. At most its neighbourhood is shown, and your city and country stay on the post.';
  }
  if (applied === 'trusted_circle_only') {
    return `Nobody sees the place you tagged — your Trusted Circle included. ${kept}`;
  }
  if (applied === 'hidden') {
    return `The place you tagged is hidden from everyone. ${kept}`;
  }
  return `Only your city and country are shared, never the place.`;
}

/**
 * The create-post fields for a choice. `none` is sent as an ABSENT field — the
 * composer's behaviour before this module, preserved on purpose: sending `none`
 * explicitly would publish a tagged place immediately, which is a privacy
 * change for the owner to decide (census-media §22), not a refactor to slip in.
 */
export function locationRequestFields(
  mode: unknown,
  scheduledTime: Date | null,
): { locationPrivacyMode: ComposerLocationMode | undefined; publishAfterTime: string | null } {
  const m = normalize(mode);
  return {
    locationPrivacyMode: m === 'none' ? undefined : m,
    publishAfterTime: m === 'delayed_until_time' ? (scheduledTime?.toISOString() ?? null) : null,
  };
}

// ── §34 "Show neighborhood only", offered only while the server permits it ──
// (census-media §36, MD262). Appended so no cited line above moves.

/** The server flag (migration 3350, seeded OFF) that lets a person choose it. */
export const NEIGHBORHOOD_ONLY_MODE_FLAG = 'media_neighborhood_only_mode_enabled';

/** The choice itself. Placed before "City only", in §34's own order. */
export const NEIGHBORHOOD_ONLY_CHOICE: { mode: ComposerLocationMode; label: string } = {
  mode: 'neighborhood_only',
  label: 'Neighbourhood',
};

/**
 * The composer's choices. With the flag off this is LOCATION_CHOICES, the same
 * array — the composer is unchanged. With it on, "Neighbourhood" is offered
 * before "City only". The server refuses the mode while its flag is off, so
 * offering it here without the flag would promise a choice the post cannot keep.
 */
export function locationChoices(opts: { neighborhoodOnly: boolean }): ReadonlyArray<{ mode: ComposerLocationMode; label: string }> {
  if (!opts.neighborhoodOnly) return LOCATION_CHOICES;
  const out: Array<{ mode: ComposerLocationMode; label: string }> = [];
  for (const c of LOCATION_CHOICES) {
    if (c.mode === 'city_only') out.push(NEIGHBORHOOD_ONLY_CHOICE);
    out.push(c);
  }
  return out;
}
