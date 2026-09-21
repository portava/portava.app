/**
 * wallFrameCaptureFixture — the 60-item For You feed that census-wall W149's
 * frame-time capture is run against, and a stub server that serves it.
 *
 * WHY THIS EXISTS
 * ===============
 * W149 asks for "a frame-time capture on a named device ... scrolling a 60-item
 * For You feed with video". Every part of that is a person-with-a-device job
 * except one: WHERE THE 60 ITEMS COME FROM. Left unspecified, whoever finally
 * runs the capture has to stand up Postgres, seed a corpus, flip six feature
 * flags in the `feature_flags` table and hope their feed happened to come out
 * 60 items long and video-bearing — and the next person's run is not comparable
 * to theirs. That is how a performance number becomes unreproducible.
 *
 * So the feed is pinned here instead, and the server half is 80 lines.
 *
 * SEPARATING W149 FROM W146 IS THE POINT, NOT A SHORTCUT. W146 is the server's
 * number (first page under 500 ms against real Postgres) and it is a different
 * open row with a different owner. W149 is the CLIENT's number: how long the
 * device takes to lay out, rasterise and composite frames while scrolling. A
 * stub server removes database latency, flag state, auth-to-corpus mapping and
 * ranking non-determinism from the client measurement — all of which are noise
 * for a frame-time trace and all of which would otherwise make two people's
 * captures incomparable. It does NOT remove anything the device actually does
 * per frame: identical JSON in, identical component tree out.
 *
 * WHAT THIS DELIBERATELY DOES NOT STUB — AUTH. The client obtains its bearer
 * token from Supabase (services/apiToken.ts `freshToken`), not from the API
 * base URL, so the capture still runs as a real signed-in session against the
 * real auth provider. The stub ignores the Authorization header entirely. This
 * is the honest split: the feed is fixed, the app is not otherwise faked.
 *
 * MEDIA IS THE ONE THING THIS CANNOT SUPPLY, AND IT MATTERS MOST
 * =============================================================
 * Decoding and compositing images and video is the largest single per-frame
 * cost in a media feed, and this repository contains no image or video bytes to
 * ship. `WALL_FIXTURE_MEDIA_BASE` is therefore REQUIRED and has no default:
 * `buildFrameCaptureFeed` throws without it rather than quietly emitting a feed
 * of empty media wells that would scroll beautifully and mean nothing.
 *
 * A capture run against a media base that 404s is NOT a passing capture and
 * must not be recorded as one. The certification packet says this too; it is
 * repeated here because this is the file someone will read at the keyboard.
 */

import type {
  DisplayMedia,
  WallProjection,
  WallResponse,
} from '../types/wallProjection.ts';

/** Pinned so two people's captures are of the same feed. */
export const FRAME_CAPTURE_CLOCK = Date.parse('2026-06-15T12:00:00.000Z');

/** The item count W149 names. */
export const FRAME_CAPTURE_ITEM_COUNT = 60;

/**
 * Object-type mix, repeated to fill the 60.
 *
 * NOT arbitrary and NOT uniform. A frame-time capture over a feed of 60
 * identical plain posts would measure the cheapest card the Wall can draw and
 * report it as the Wall's frame time. The mix below is weighted toward the
 * EXPENSIVE renderers on purpose: video (inline player + poster + visibility
 * subscription), postcard (paper frame, shadow, its own type scale) and
 * shared_moment (participant list) are over-represented relative to a plausible
 * production feed, so the number this produces is a conservative one. A capture
 * that passes on this mix passes on a real feed; the converse is not claimed.
 *
 * One in every five items also carries a context thread, matching the ceiling
 * composition the W159/W167 review set puts in front of the designer.
 */
const TYPE_CYCLE = [
  'social_post',
  'video',
  'postcard',
  'social_post',
  'shared_moment',
  'video',
  'discovery',
  'postcard',
  'social_post',
  'video',
] as const;

const CAPTIONS = [
  'Third morning in a row at the same bánh mì cart.',
  'The night market only really starts after nine.',
  'Walked the old town twice and found a different city each time.',
  'Rain all afternoon, so: coffee, and then more coffee.',
  'Someone told me the bus would take two hours. It took five.',
  'Best thing I ate this week cost less than a bottle of water.',
  'Sunrise over the river, and nobody else awake for it.',
  'Got lost on purpose. Recommend it.',
];

const PEOPLE = [
  'Maya Okonkwo', 'Tomás Rivera', 'Alina Kovač', 'Idris Bello',
  'Wen Li', 'Sofia Marchetti', 'Jonas Berg', 'Priya Raman',
];

const PLACES = [
  { placeId: 'fx-place-1', name: 'Bánh Mì Phượng', city: 'Hội An', country: 'Vietnam' },
  { placeId: 'fx-place-2', name: 'Chợ Đêm', city: 'Hội An', country: 'Vietnam' },
  { placeId: 'fx-place-3', name: 'Marble Mountains', city: 'Đà Nẵng', country: 'Vietnam' },
  { placeId: 'fx-place-4', name: 'Cầu Rồng', city: 'Đà Nẵng', country: 'Vietnam' },
];

export interface FrameCaptureOptions {
  /**
   * Base URL for fixture media. REQUIRED — see the media note in the header.
   * Must serve `image-0.jpg` … `image-9.jpg` and `video-0.mp4` … `video-2.mp4`.
   */
  mediaBase: string;
  count?: number;
}

function imageAt(base: string, i: number): DisplayMedia {
  return {
    mediaId: `fx-img-${i}`,
    kind: 'image',
    url: `${base}/image-${i % 10}.jpg`,
    thumbnailUrl: `${base}/image-${i % 10}.jpg`,
    width: 1600,
    height: 1200,
  };
}

function videoAt(base: string, i: number): DisplayMedia {
  return {
    mediaId: `fx-vid-${i}`,
    kind: 'video',
    url: `${base}/video-${i % 3}.mp4`,
    thumbnailUrl: `${base}/image-${i % 10}.jpg`,
    width: 1080,
    height: 1920,
    durationMs: 18_000,
    autoplayEligible: true,
  };
}

/**
 * Build the pinned feed. Deterministic: same options in, byte-identical out.
 *
 * @throws when `mediaBase` is empty — a media-free feed is not a valid subject
 *         for a frame-time capture and failing loudly is the only safe default.
 */
export function buildFrameCaptureFeed(opts: FrameCaptureOptions): WallResponse {
  const base = opts.mediaBase?.replace(/\/+$/, '') ?? '';
  if (!base) {
    throw new Error(
      'wallFrameCaptureFixture: mediaBase is required. A frame-time capture over a feed ' +
        'with no image or video bytes measures an empty list, not the Wall. Set ' +
        'WALL_FIXTURE_MEDIA_BASE to a host serving image-0..9.jpg and video-0..2.mp4.',
    );
  }
  const count = opts.count ?? FRAME_CAPTURE_ITEM_COUNT;
  const items: WallProjection[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = TYPE_CYCLE[i % TYPE_CYCLE.length];
    const actorName = PEOPLE[i % PEOPLE.length]!;
    const place = PLACES[i % PLACES.length]!;
    const publishedAt = new Date(FRAME_CAPTURE_CLOCK - i * 37 * 60_000).toISOString();
    const withThread = i % 5 === 0;
    const common = {
      projectionId: `fx-${i}`,
      canonicalObjectId: `fx-canonical-${i}`,
      actor: {
        userId: `fx-user-${i % PEOPLE.length}`,
        displayName: actorName,
        handle: actorName.split(' ')[0]!.toLowerCase(),
        avatarUrl: `${base}/image-${i % 10}.jpg`,
      },
      publishedAt,
      visibility: 'public' as const,
      text: CAPTIONS[i % CAPTIONS.length]!,
      place,
      viewerSaved: i % 7 === 0,
      actions: [
        { type: 'open_object' as const, label: 'Open' },
        { type: 'save' as const, label: 'Save' },
        { type: 'see_place' as const, label: 'See place' },
        { type: 'add_to_trip' as const, label: 'Add to trip' },
      ],
      ranking: { session: 'fx-session', version: 'fx-v1', rank: i },
      contextThread: withThread
        ? {
            kind: 'live_place' as const,
            label: 'Busy right now',
            freshness: 'recent' as const,
            confidence: 0.7,
            reason: 'Several people checked in here in the last hour',
            truthClass: 'corroborated' as const,
            coverage: 'several' as const,
            action: { type: 'see_live' as const, label: 'See what is happening' },
          }
        : undefined,
    };

    switch (type) {
      case 'video':
        items.push({ ...common, objectType: 'video', inlinePlayback: true, media: [videoAt(base, i)] });
        break;
      case 'postcard':
        items.push({
          ...common,
          objectType: 'postcard',
          storyPresentation: true,
          experienceAt: new Date(FRAME_CAPTURE_CLOCK - (i + 40) * 86_400_000).toISOString(),
          media: [imageAt(base, i)],
        });
        break;
      case 'shared_moment':
        items.push({
          ...common,
          objectType: 'shared_moment',
          participants: [0, 1, 2].map((k) => ({
            userId: `fx-user-${(i + k) % PEOPLE.length}`,
            displayName: PEOPLE[(i + k) % PEOPLE.length]!,
            avatarUrl: `${base}/image-${(i + k) % 10}.jpg`,
          })),
          media: [imageAt(base, i)],
        });
        break;
      case 'discovery':
        items.push({
          ...common,
          objectType: 'discovery',
          discoveryReason: 'Followed by three people you know',
          media: [imageAt(base, i)],
        });
        break;
      default:
        items.push({ ...common, objectType: 'social_post', media: [imageAt(base, i)] });
    }
  }

  return {
    mode: 'for_you',
    liveForYou: [],
    items,
    generatedAt: new Date(FRAME_CAPTURE_CLOCK).toISOString(),
  };
}

/**
 * Slice the pinned feed into cursor pages.
 *
 * Paging is part of the measurement, not an implementation detail to skip: the
 * Wall's server page size is 20 (`routes/wall.ts` DEFAULT_LIMIT) with a hard
 * cap of 40, so reaching item 60 means the device does TWO mid-scroll
 * `onEndReached` fetches and two list-data replacements while the user's thumb
 * is still moving. Those are exactly the moments a feed drops frames, so the
 * stub serves real pages rather than one 60-item slab.
 */
export function pageOf(feed: WallResponse, cursor: string | null, limit = 20): WallResponse {
  const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const end = Math.min(start + limit, feed.items.length);
  return {
    ...feed,
    items: feed.items.slice(start, end),
    nextCursor: end < feed.items.length ? String(end) : undefined,
  };
}
