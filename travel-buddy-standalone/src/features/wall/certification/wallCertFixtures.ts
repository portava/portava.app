/**
 * wallCertFixtures — the deterministic render fixtures behind the Wall
 * certification packet (docs/architecture/wall-certification-packet.md).
 *
 * WHY THIS EXISTS
 * ===============
 * census-wall rows W159 and W167 both end in the same sentence: they need a
 * named designer to sign off (or refuse) against "a screenshot set of the five
 * object renderers at the supported width range". No test can answer either
 * question. What a test CAN do is remove every excuse between the reviewer and
 * the answer: produce the render set itself, deterministically, from the real
 * renderers, so the human step is "look at this and answer two questions"
 * rather than "build a harness, then look".
 *
 * These fixtures are NOT test data for a behavioural assertion. They are the
 * SUBJECT of a design review, so they are chosen for what they let a reviewer
 * judge, and each choice is stated:
 *
 *   TYPICAL  — what the feed mostly looks like: a byline, some text, one media
 *              well, a place line, no chips, no context thread. This is the
 *              case W159's "generous whitespace" is really about.
 *
 *   CEILING  — the densest card the CODE can currently emit: one action row,
 *              the full three contextual chips, the Ask Compass affordance, a
 *              place line AND one context thread, over media and text. This is
 *              exactly the composition W167 asks a human to rule on ("is one
 *              action row + at most three chips + at most one context thread
 *              per card already too dense?"). A reviewer cannot answer that
 *              question against a card that never reaches the ceiling.
 *
 * DETERMINISM IS LOAD-BEARING, NOT TIDINESS. A sign-off names an artifact. If
 * the artifact is not byte-reproducible the signature means nothing six weeks
 * later, because nobody can tell whether what shipped is what was signed. Three
 * sources of drift are closed here rather than in the harness:
 *
 *   1. `formatRelative` reads `Date.now()`. Every `publishedAt` below is
 *      expressed as an offset from CERT_CLOCK, and the harness pins the system
 *      clock to CERT_CLOCK, so "3h" is "3h" on every run forever.
 *   2. `formatDate` calls `toLocaleDateString(undefined, ...)` — locale- and
 *      TZ-dependent. Every timestamp here lands inside the < 7 day relative
 *      window so that path is not reached, EXCEPT the Postcard, whose whole
 *      point is a prominent experience date (§10/§16); the harness pins TZ and
 *      locale for it.
 *   3. Media URLs. Every fixture deliberately carries NO `url`/`thumbnailUrl`,
 *      so `WallImage` takes its own "No preview" placeholder branch at the real
 *      `aspect` ratio. No bytes are fetched, nothing is signed, and the media
 *      well is the real size the real component gives it. The reviewer is
 *      judging the WELL, not the photograph — and that limitation is stated in
 *      the packet rather than papered over.
 */

import type {
  DiscoveryProjection,
  PostcardProjection,
  SharedMomentProjection,
  SocialPostProjection,
  VideoProjection,
  WallProjection,
} from '../types/wallProjection.ts';
import type { ContextThread } from '../types/contextThread.ts';

/**
 * The instant the render set is pinned to. Arbitrary but FIXED — the only
 * property that matters is that it never changes, because every relative
 * timestamp in the set is derived from it.
 */
export const CERT_CLOCK = Date.parse('2026-06-15T12:00:00.000Z');

/** IANA zone and BCP-47 locale the set is pinned to (see note 2 above). */
export const CERT_TZ = 'UTC';
export const CERT_LOCALE = 'en-US';

function atOffset(hoursAgo: number): string {
  return new Date(CERT_CLOCK - hoursAgo * 3600_000).toISOString();
}

/**
 * The widths the set is captured at.
 *
 * MEASURED, NOT ASSUMED, about this tree: the Wall reads no viewport width
 * anywhere. `grep -rn 'useWindowDimensions\|Dimensions.get' src/features/wall/`
 * returns nothing, and the theme declares no breakpoints. So width does not
 * switch any layout in the Wall — it only changes where text wraps, how tall a
 * fixed-aspect media well is, and whether the three-chip row wraps to a second
 * line. That is why five widths are enough and why they are clustered at the
 * ENDS of the range: the interesting failures are at 320 (wrapping, truncation,
 * chip overflow) and at 430 (lines too long to scan, whitespace reading as
 * emptiness rather than generosity).
 *
 * THE RANGE ITSELF IS A PROPOSAL, NOT A REPO FACT. Nothing in this repository
 * declares a supported width range; app.json sets no minimum width and the Wall
 * is width-agnostic. 320–430 dp is proposed in the packet as the phone range to
 * certify, and the owner is asked to confirm or replace it BEFORE the review
 * runs. If it is replaced, change this array and re-emit — the reviewer never
 * has to touch the harness.
 */
export const CERT_WIDTHS = [320, 360, 390, 411, 430] as const;

/** Why each width is in the set — rendered into the review page as a caption. */
export const CERT_WIDTH_NOTES: Record<number, string> = {
  320: 'Narrowest phone width still in service. Worst case for wrapping, truncation and chip-row overflow.',
  360: 'The single most common Android logical width worldwide.',
  390: 'Common current iPhone width (13/14/15 class).',
  411: 'Pixel 6a — the device named as the Android floor for the W149 frame-time capture.',
  430: 'Widest current phone width. Worst case for over-long measure and for whitespace reading as emptiness.',
};

const ACTOR = {
  userId: 'cert-actor-1',
  displayName: 'Maya Okonkwo',
  handle: 'mayao',
  avatarUrl: null,
};

const PLACE = {
  placeId: 'cert-place-1',
  name: 'Bánh Mì Phượng',
  city: 'Hội An',
  country: 'Vietnam',
};

const THREAD: ContextThread = {
  kind: 'live_place',
  label: 'Busy right now',
  freshness: 'recent',
  confidence: 0.72,
  reason: 'Several people checked in here in the last hour',
  truthClass: 'corroborated',
  coverage: 'several',
  action: { type: 'see_live', label: 'See what is happening' },
};

/**
 * Seven actions, chosen so the chip CAP actually bites rather than merely being
 * satisfied. `open_object`, `save` and `ask_compass` are excluded by
 * ContextualActionChips by design (each already has its own home elsewhere on
 * the card), leaving FOUR candidates for a row that renders at most three. The
 * fourth — CEILING_DROPPED_LABEL — must not appear anywhere in the render, and
 * the harness asserts that. A fixture with exactly three survivors would pass
 * whether or not the cap existed.
 */
const CEILING_ACTIONS = [
  { type: 'open_object' as const, label: 'Open' },
  { type: 'save' as const, label: 'Save' },
  { type: 'ask_compass' as const, label: 'Ask Compass' },
  { type: 'see_place' as const, label: 'See place' },
  { type: 'add_to_trip' as const, label: 'Add to trip' },
  { type: 'message' as const, label: 'Message Maya' },
  { type: 'see_who' as const, label: 'See who is going' },
];

/** The three chips a ceiling card is expected to show, in order. */
export const CEILING_CHIP_LABELS = ['See place', 'Add to trip', 'Message Maya'] as const;

/** The fourth candidate, which the three-chip cap must drop. */
export const CEILING_DROPPED_LABEL = 'See who is going';

/** The context-thread kind used by every ceiling card (drives its testID). */
export const CEILING_THREAD_KIND = 'live_place';

const TYPICAL_TEXT =
  'Third morning in a row at the same bánh mì cart. The queue moves fast and nobody minds the rain.';

const CEILING_TEXT =
  'Third morning in a row at the same bánh mì cart. The queue moves fast, nobody minds the rain, ' +
  'and the woman on the corner has started putting mine together before I finish asking.';

const IMAGE = { mediaId: 'cert-m-1', kind: 'image' as const, width: 1600, height: 1200 };
const VIDEO = { mediaId: 'cert-m-2', kind: 'video' as const, width: 1080, height: 1920, durationMs: 21_000 };

export type CertDensity = 'typical' | 'ceiling';

export interface CertCase {
  /** Stable slug — used as the anchor id in the emitted review page. */
  id: string;
  objectType: WallProjection['objectType'];
  density: CertDensity;
  /** One line under the card in the review page saying what it is. */
  caption: string;
  projection: WallProjection;
}

function socialPost(density: CertDensity): SocialPostProjection {
  const ceiling = density === 'ceiling';
  return {
    projectionId: `cert-post-${density}`,
    objectType: 'social_post',
    canonicalObjectId: 'cert-canonical-post',
    actor: ACTOR,
    publishedAt: atOffset(3),
    visibility: 'public',
    media: [IMAGE],
    text: ceiling ? CEILING_TEXT : TYPICAL_TEXT,
    place: PLACE,
    actions: ceiling ? CEILING_ACTIONS : [{ type: 'open_object', label: 'Open' }],
    contextThread: ceiling ? THREAD : undefined,
    viewerSaved: false,
  };
}

function video(density: CertDensity): VideoProjection {
  const ceiling = density === 'ceiling';
  return {
    projectionId: `cert-video-${density}`,
    objectType: 'video',
    inlinePlayback: true,
    canonicalObjectId: 'cert-canonical-video',
    actor: ACTOR,
    publishedAt: atOffset(9),
    visibility: 'public',
    media: [VIDEO],
    text: ceiling ? CEILING_TEXT : TYPICAL_TEXT,
    place: PLACE,
    actions: ceiling ? CEILING_ACTIONS : [{ type: 'open_object', label: 'Open' }],
    contextThread: ceiling ? THREAD : undefined,
    viewerSaved: false,
  };
}

function postcard(density: CertDensity): PostcardProjection {
  const ceiling = density === 'ceiling';
  return {
    projectionId: `cert-postcard-${density}`,
    objectType: 'postcard',
    storyPresentation: true,
    canonicalObjectId: 'cert-canonical-postcard',
    actor: ACTOR,
    publishedAt: atOffset(30),
    // The two-clock case (§16): the Postcard's prominent date is the EXPERIENCE
    // date, deliberately different from publication so the reviewer can see both.
    experienceAt: '2026-05-02T09:15:00.000Z',
    visibility: 'public',
    media: [IMAGE],
    text: ceiling ? CEILING_TEXT : TYPICAL_TEXT,
    place: PLACE,
    actions: ceiling ? CEILING_ACTIONS : [{ type: 'open_object', label: 'Open Postcard' }],
    contextThread: ceiling ? THREAD : undefined,
    viewerSaved: false,
  };
}

function sharedMoment(density: CertDensity): SharedMomentProjection {
  const ceiling = density === 'ceiling';
  return {
    projectionId: `cert-moment-${density}`,
    objectType: 'shared_moment',
    canonicalObjectId: 'cert-canonical-moment',
    actor: ACTOR,
    participants: [
      ACTOR,
      { userId: 'cert-actor-2', displayName: 'Tomás Rivera', handle: 'tomasr', avatarUrl: null },
      { userId: 'cert-actor-3', displayName: 'Alina Kovač', handle: 'alinak', avatarUrl: null },
    ],
    publishedAt: atOffset(50),
    visibility: 'friends',
    media: [IMAGE],
    text: ceiling ? CEILING_TEXT : TYPICAL_TEXT,
    place: PLACE,
    actions: ceiling ? CEILING_ACTIONS : [{ type: 'open_object', label: 'Open' }],
    contextThread: ceiling ? THREAD : undefined,
    viewerSaved: false,
  };
}

function discovery(density: CertDensity): DiscoveryProjection {
  const ceiling = density === 'ceiling';
  return {
    projectionId: `cert-discovery-${density}`,
    objectType: 'discovery',
    discoveryReason: 'Followed by three people you know, and near your Hội An trip',
    canonicalObjectId: 'cert-canonical-discovery',
    actor: ACTOR,
    publishedAt: atOffset(20),
    visibility: 'public',
    media: [IMAGE],
    text: ceiling ? CEILING_TEXT : TYPICAL_TEXT,
    place: PLACE,
    actions: ceiling ? CEILING_ACTIONS : [{ type: 'open_object', label: 'Open' }],
    contextThread: ceiling ? THREAD : undefined,
    viewerSaved: false,
  };
}

/**
 * The five object renderers, each at both densities, in feed order.
 *
 * "Five renderers" is the census's phrase and it is exact: the tree holds five
 * files under components/objects/ — SocialPost, Video, Postcard, SharedMoment
 * and Discovery. The two remaining object types in the union (`social_update`,
 * `contextual_opportunity`) are rendered by small local components inside
 * WallObjectRenderer rather than by their own file, and `contextual_opportunity`
 * additionally has no server producer. They are out of the certified set for
 * the same reason the census named five and not seven.
 */
export const CERT_CASES: CertCase[] = [
  { id: 'social_post-typical', objectType: 'social_post', density: 'typical', caption: 'Social post — typical card', projection: socialPost('typical') },
  { id: 'social_post-ceiling', objectType: 'social_post', density: 'ceiling', caption: 'Social post — densest card the code can emit', projection: socialPost('ceiling') },
  { id: 'video-typical', objectType: 'video', density: 'typical', caption: 'Video — typical card (poster state, player not mounted off-viewport)', projection: video('typical') },
  { id: 'video-ceiling', objectType: 'video', density: 'ceiling', caption: 'Video — densest card the code can emit', projection: video('ceiling') },
  { id: 'postcard-typical', objectType: 'postcard', density: 'typical', caption: 'Postcard — typical card (experience date, not publication date)', projection: postcard('typical') },
  { id: 'postcard-ceiling', objectType: 'postcard', density: 'ceiling', caption: 'Postcard — densest card the code can emit', projection: postcard('ceiling') },
  { id: 'shared_moment-typical', objectType: 'shared_moment', density: 'typical', caption: 'Shared Moment — typical card', projection: sharedMoment('typical') },
  { id: 'shared_moment-ceiling', objectType: 'shared_moment', density: 'ceiling', caption: 'Shared Moment — densest card the code can emit', projection: sharedMoment('ceiling') },
  { id: 'discovery-typical', objectType: 'discovery', density: 'typical', caption: 'Discovery insertion — typical card', projection: discovery('typical') },
  { id: 'discovery-ceiling', objectType: 'discovery', density: 'ceiling', caption: 'Discovery insertion — densest card the code can emit', projection: discovery('ceiling') },
];

/** The five renderer files the set is required to cover, for the coverage assertion. */
export const CERT_REQUIRED_RENDERERS = [
  'social_post',
  'video',
  'postcard',
  'shared_moment',
  'discovery',
] as const;
