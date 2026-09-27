/**
 * features/media — the §4 Media Contribution model (spec §4 / §9 / §12 / §33 /
 * §34 / §40; census-media §19: MD28 · MD316).
 *
 * A contribution is a PERSPECTIVE of one canonical place: a photo or clip the
 * contributor captured there, offered to the world context under the audience
 * and location precision they choose. It goes through the app's EXISTING
 * pipeline — `uploadMedia` (EXIF/GPS stripped server-side) then `createPost`
 * (the gated post write, delayed publishing, server-owned location
 * verification) — so this module adds no second ingest path. What it adds is
 * the binding: the post is tagged with the canonical place's OWN public venue
 * name and coordinates, which is what the server's place resolver keys the
 * post's `canonical_place_id` on, and the category the §12 perspective
 * grouping buckets by.
 *
 * What it deliberately does NOT offer: the §12 physical VANTAGES (Entrance ·
 * Queue · Stage …). No column stores one (census F7, MD82–MD85), so a vantage
 * chosen here would be dropped on the floor — the sheet offers only the
 * category the server really groups by.
 *
 * Pure — safe for node:test. The screen owns the I/O.
 */
/**
 * The audiences a place perspective may be shared with — the subset of the post
 * write's `PostVisibility` that needs no trip ('trip_only' requires a trip id).
 */
export type MediaVisibilityChoice = 'public' | 'private';

export type ContributionPrecision = 'venue' | 'city_only' | 'after_i_leave' | 'hidden' | 'neighborhood'; // neighborhood: §34 "Show neighborhood only" (census-media §36) — offered only while the server accepts it (contributionPrecisions)

export interface ContributionDraft {
  /** The picked asset (from the app's picker). */
  media: { uri: string; mimeType?: string | null; type?: string | null; fileName?: string | null; fileSize?: number | null; duration?: number | null } | null;
  /** The §12 perspective bucket the server groups by. Null ⇒ "general". */
  category: string | null;
  audience: MediaVisibilityChoice;
  precision: ContributionPrecision;
  note: string;
}

export const INITIAL_CONTRIBUTION_DRAFT: ContributionDraft = {
  media: null,
  category: null,
  audience: 'public',
  precision: 'venue',
  note: '',
};

/** The categories MediaPerspectiveService groups perspectives by (its CATEGORY_LABELS keys). */
export const CONTRIBUTION_CATEGORIES: readonly { key: string; label: string }[] = [
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'food', label: 'Food' },
  { key: 'cafe', label: 'Cafe' },
  { key: 'beach', label: 'Beach' },
  { key: 'nature', label: 'Nature' },
  { key: 'culture', label: 'Culture' },
  { key: 'festival', label: 'Festival' },
  { key: 'shopping', label: 'Shopping' },
];

/** §33/§34 location precision → the post write's `locationPrivacyMode`. */
export const PRECISION_TO_PRIVACY_MODE: Record<ContributionPrecision, 'none' | 'city_only' | 'delayed_until_exit' | 'hidden' | 'neighborhood_only'> = {
  venue: 'none',
  city_only: 'city_only',
  after_i_leave: 'delayed_until_exit',
  hidden: 'hidden', neighborhood: 'neighborhood_only',
};

export const PRECISION_LABELS: Record<ContributionPrecision, string> = {
  venue: 'Show the place',
  city_only: 'City only',
  after_i_leave: 'After I leave',
  hidden: 'No location', neighborhood: 'Neighbourhood only',
};

/** The place a contribution is bound to — the canonical record's own public fields. */
export interface ContributionPlace {
  id: string;
  name: string;
  city: string | null;
  countryCode: string | null;
  /** The VENUE's public coordinates (the canonical place record), never the viewer's. */
  coordinates: { lat: number; lng: number };
}

export type ContributionAction =
  | { type: 'pick_media'; media: NonNullable<ContributionDraft['media']> }
  | { type: 'clear_media' }
  | { type: 'set_category'; category: string | null }
  | { type: 'set_audience'; audience: MediaVisibilityChoice }
  | { type: 'set_precision'; precision: ContributionPrecision }
  | { type: 'set_note'; note: string };

const MAX_NOTE = 280;

export function contributionReducer(d: ContributionDraft, a: ContributionAction): ContributionDraft {
  switch (a.type) {
    case 'pick_media':
      return { ...d, media: a.media };
    case 'clear_media':
      return { ...d, media: null };
    case 'set_category':
      return { ...d, category: d.category === a.category ? null : a.category };
    case 'set_audience':
      return { ...d, audience: a.audience };
    case 'set_precision':
      return { ...d, precision: a.precision };
    case 'set_note':
      return { ...d, note: a.note.slice(0, MAX_NOTE) };
    default:
      return d;
  }
}

/** Why a draft cannot be sent yet, or null when it can. */
export function contributionBlocker(d: ContributionDraft, place: ContributionPlace | null): string | null {
  if (!place) return 'This place could not be loaded.';
  if (!d.media) return 'Add a photo or clip from here.';
  return null;
}

/**
 * The `createPost` input for a draft whose media is already uploaded. The
 * contributor's device fix is sent ONLY as the private verification pair
 * (`userGps*`) the server never projects; the tagged location is the venue's.
 */
export function toCreatePostInput(
  d: ContributionDraft,
  place: ContributionPlace,
  uploaded: { url: string; mediaType: 'image' | 'video' | null },
  deviceGps: { lat: number; lng: number } | null,
) {
  return {
    content: d.note.trim(),
    mediaUrls: [uploaded.url],
    mediaType: uploaded.mediaType,
    visibility: d.audience,
    // A perspective is world context, not a Passport postcard (§29).
    addToPassport: false,
    locationName: place.name,
    locationCity: place.city,
    locationCountry: place.countryCode,
    locationLat: place.coordinates.lat,
    locationLng: place.coordinates.lng,
    userGpsLat: deviceGps?.lat ?? null,
    userGpsLng: deviceGps?.lng ?? null,
    locationSource: deviceGps ? ('gps' as const) : ('manual' as const),
    locationPrivacyMode: PRECISION_TO_PRIVACY_MODE[d.precision],
    category: d.category,
  };
}

export type ContributionPhase =
  | { kind: 'editing' }
  | { kind: 'uploading' }
  | { kind: 'saving'; uploadedUrl: string; mediaType: 'image' | 'video' | null }
  | { kind: 'done'; pending: boolean }
  | { kind: 'failed'; step: 'upload' | 'save'; message: string; uploadedUrl: string | null; mediaType: 'image' | 'video' | null };

/**
 * After a failure, what a retry does: a failed SAVE retries the save with the
 * already-uploaded URL — it never uploads the same file twice.
 */
export function retryStartsAt(p: ContributionPhase): 'upload' | 'save' {
  return p.kind === 'failed' && p.step === 'save' && p.uploadedUrl ? 'save' : 'upload';
}

/** The words for a finished contribution. A delayed one says WHEN it appears. */
export function doneCopy(pending: boolean, precision: ContributionPrecision): string {
  if (pending && precision === 'after_i_leave') return 'Saved — your perspective appears once you have left.';
  if (pending) return 'Saved — your perspective appears shortly.';
  return 'Thanks — your perspective is part of this place now.';
}

// ── §34 "Show neighborhood only" on the contribution sheet (census-media §36) ──
// Appended so no cited line above moves.

/**
 * The precisions the sheet offers, in the order it offers them. Without the
 * server flag (media_neighborhood_only_mode_enabled, seeded OFF) this is the
 * four it always offered; with it, "Neighbourhood only" sits between the place
 * and the city — §34's own order. The server refuses the mode while the flag
 * is off, so it is never offered without it.
 */
export function contributionPrecisions(opts: { neighborhoodOffered: boolean }): ContributionPrecision[] {
  return opts.neighborhoodOffered
    ? ['venue', 'neighborhood', 'city_only', 'after_i_leave', 'hidden']
    : ['venue', 'city_only', 'after_i_leave', 'hidden'];
}
