/**
 * wallItemShared — presentational scaffolding shared by the distinct Wall object
 * renderers (Wall spec §7/§29).
 *
 * This is NOT a universal card template — each object renderer composes its own
 * distinct body (a Postcard is never a Post with a badge, spec §10). What lives
 * here is the small, consistent chrome every social object shares: the actor
 * byline (person visually primary, §7), the two-clock timestamps (§16), a quiet
 * contextual-action chip row (actions are optional/additive, §7), and the
 * canonical-surface routing + analytics that any action fires. Following an
 * action always lands in the canonical surface — the projection is never the
 * object (spec §24).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CachedImage } from '../../../../components/CachedImage.tsx';
import { router } from 'expo-router';
import {
  MapPin,
  Sparkles,
  MessageCircle,
  Share2,
  Bookmark,
  EyeOff,
  Compass as CompassIcon,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon, aspect } from '../../../../theme/tokens.ts';
import {
  recordRealWorldOutcome,
  trackAction,
  trackEngagement,
  trackFollowFromFeed,
  trackHandoff,
  trackNotInterested,
  type WallHandoffSurface,
  type WallRealWorldOutcome,
} from '../../services/wallAnalytics.ts';
import { askCompassFromWall } from '../../services/wallCompass.ts';
import { sendAction, type WallActionEvent } from '../../services/wallApi.ts';
import { saveItem, unsaveItem } from '../../../../services/collections.ts';
import type {
  DisplayMedia,
  PublicActorRef,
  WallAction,
  WallActionType,
  WallProjection,
} from '../../types/wallProjection.ts';

// ── Two clocks (spec §16) ────────────────────────────────────────────────────

/** "just now" / "4m" / "3h" / "6d" / a short date for older posts. */
export function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return formatDate(iso);
}

/** "Mar 4" style short date. */
export function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Action routing + analytics (spec §24/§32) ────────────────────────────────

/** Map a Wall action to the server analytics verb (POST /wall/action). */
export function actionEventFor(type: WallActionType): WallActionEvent {
  switch (type) {
    case 'open_object':
      return 'open';
    case 'save':
      return 'save';
    case 'follow':
      return 'follow';
    default:
      return 'tap';
  }
}

/**
 * The canonical surface an action leads into. Returns null when the action has
 * no direct route (it still records analytics). Routes to app/ screens known to
 * exist; unknown targets no-op rather than pushing a broken route.
 */
export function resolveActionRoute(
  action: WallAction,
  projection: WallProjection,
): string | null {
  const placeId = action.targetId ?? projection.place?.placeId ?? null;
  const objId = projection.canonicalObjectId;
  switch (action.type) {
    case 'open_object':
      if (projection.objectType === 'shared_moment') return '/shared-moments';
      if (projection.objectType === 'video') return `/media-viewer/${objId}`;
      // A Postcard opens the canonical Postcard viewer, not the post detail —
      // its story presentation is preserved through the open (§10/§24).
      if (projection.objectType === 'postcard') return `/postcard/${objId}`;
      return `/post/${objId}`;
    case 'see_place':
      return placeId ? `/place/${placeId}` : null;
    case 'open_map':
      // §35 entry: origin is a Wall item; the vocabulary has no 'wall' member,
      // so it is stated as unknown rather than guessed.
      return '/map?entry=unknown';
    case 'add_to_trip':
      return '/trips';
    case 'message':
      // /messages/[id] takes a THREAD id, not a user id, and resolving the
      // direct thread is an async canonical call — so the Wall hands off to the
      // messages surface itself rather than inventing a thread route that would
      // 404. The action is a bridge, never a send.
      return '/messages';
    case 'explore':
      return '/gems';
    case 'see_who':
      return `/post/${objId}`;
    case 'see_live':
      return null; // handled by the Live For You strip, not per-object
    case 'ask_compass':
      return null; // handled by askCompassFromWall (canonical prefill handoff, §21)
    case 'book_buddy':
      return '/availability';
    case 'join':
      // spec §2 "join". A `join` action names the CANONICAL event it belongs to
      // (`targetType: 'event'`), and the handoff opens that event's own screen,
      // where the canonical eligibility / capacity / RSVP gate runs
      // (routes/events POST /events/:id/join). The Wall never joins on the
      // viewer's behalf and never re-implements the gate — the transition is
      // offered, not forced (§40 #6). Without an event target there is nothing
      // to join, so the object itself is opened instead.
      if (action.targetType === 'event' && action.targetId) return `/event/${action.targetId}`;
      return `/post/${objId}`;
    default:
      return null;
  }
}

/**
 * The surrounding Portava surface an action bridges into, for handoff analytics
 * (spec §32). Compass is handled by askCompassFromWall (which records its own
 * handoff), so it is not mapped here.
 */
export function handoffSurfaceFor(type: WallActionType): WallHandoffSurface | null {
  switch (type) {
    case 'see_place':
      return 'place';
    case 'open_map':
      return 'map';
    case 'add_to_trip':
      return 'trip';
    case 'book_buddy':
      return 'buddy';
    case 'message':
      // Messaging a Buddy is a Buddy-surface handoff (spec §19/§32).
      return 'buddy';
    default:
      return null;
  }
}

/**
 * The coarse real-world outcome a bridge action represents, or null when the
 * action is not a physical-world commitment (spec §32). Only the physical
 * commitments — seeing the place, planning it into a Trip, or booking a human —
 * count as a real-world outcome; in-app navigation (open_map) and interpretation
 * (ask_compass) do not, so they never emit an outcome signal.
 */
export function realWorldOutcomeFor(type: WallActionType): WallRealWorldOutcome | null {
  switch (type) {
    case 'see_place':
      return 'see_place';
    case 'add_to_trip':
      return 'add_to_trip';
    case 'book_buddy':
      return 'book_buddy';
    default:
      return null;
  }
}

/**
 * Object types whose `canonicalObjectId` IS a `posts` row id, and which therefore
 * have a canonical save in `post_saves` (routes/mediaFeed POST/DELETE
 * /posts/:id/save). A shared moment and a Buddy opportunity live in other id
 * spaces and have no post save, so the Wall must not pretend to save them.
 */
const POST_SAVEABLE_TYPES: ReadonlySet<string> = new Set([
  'social_post',
  'video',
  'postcard',
  'social_update',
  'discovery',
]);

/**
 * Write a save through to the CANONICAL save store (spec §2 "save", §24 "the
 * projection is never the object"). Returns whether the write landed.
 *
 * The Wall previously toggled a `React.useState` boolean and fired analytics, so
 * the bookmark persisted nothing and reset on remount — `save`, one of §2's
 * eight named real-world actions, was an animation. The store is
 * services/collections' `saveItem`/`unsaveItem`, which for `post` entities hit
 * the dedicated `post_saves` endpoint. The Wall owns neither the store nor the
 * count; it reports the state the server projected (`viewerSaved`) and writes
 * through the canonical endpoint.
 */
export async function persistWallSave(
  projection: WallProjection,
  next: boolean,
): Promise<boolean> {
  if (!POST_SAVEABLE_TYPES.has(projection.objectType)) return false;
  try {
    return next
      ? await saveItem('post', projection.canonicalObjectId)
      : await unsaveItem('post', projection.canonicalObjectId);
  } catch {
    // A failed save must never surface as a crash in the feed (spec §34/§40).
    return false;
  }
}

export function runWallAction(action: WallAction, projection: WallProjection): void {
  trackAction(projection, actionEventFor(action.type));

  // A follow initiated from the feed — flag the discovery-follow conversion (§32).
  if (action.type === 'follow') {
    trackFollowFromFeed(projection, projection.objectType === 'discovery');
  }

  // Ask Compass — hand the canonical object to the Compass ask surface (§21).
  // askCompassFromWall records the compass handoff itself, so return after it.
  if (action.type === 'ask_compass') {
    askCompassFromWall(projection);
    return;
  }

  // `save` is a WRITE, not a navigation. It goes to the canonical save store and
  // returns — there is no surface to push (spec §2/§24).
  if (action.type === 'save') {
    const next = !(action.params?.saved === true);
    void persistWallSave(projection, next);
    return;
  }

  // Record a Map/Place/Trip/Buddy bridge (§32) before routing.
  const surface = handoffSurfaceFor(action.type);
  if (surface) trackHandoff(projection, surface);

  // A physical-world commitment (see place / add to Trip / book Buddy) is also a
  // real-world OUTCOME signal — recorded ONLY under valid contribution consent
  // (§32); recordRealWorldOutcome enforces the consent gate and drops otherwise.
  const outcome = realWorldOutcomeFor(action.type);
  if (outcome) recordRealWorldOutcome(projection, outcome);

  const route = resolveActionRoute(action, projection);
  if (route) {
    try {
      router.push(route as never);
    } catch {
      // A missing route must never crash the feed (spec §40).
    }
  }
}

// ── Media (single-image frame with a processing placeholder, spec §34) ───────

export function WallImage({
  media,
  ratio = aspect.card,
  rounded = true,
}: {
  media?: DisplayMedia;
  ratio?: number;
  rounded?: boolean;
}) {
  const uri = media?.thumbnailUrl ?? media?.url ?? null;
  const frameStyle = [s.mediaFrame, { aspectRatio: ratio }, rounded ? s.mediaRounded : null];
  if (media?.processing || !uri) {
    return (
      <View style={[frameStyle, s.mediaPlaceholder]}>
        <Text style={s.mediaPlaceholderText}>
          {media?.processing ? 'Processing…' : 'No preview'}
        </Text>
      </View>
    );
  }
  // post-media is a PRIVATE Supabase bucket: a stored value is a bare
  // <bucket>/<path> reference or a legacy public URL, and NEITHER loads in a bare
  // RN <Image> (it renders dead whitespace). CachedImage runs useHydratedMedia to
  // turn either into a signed URL, and shows a visible fallback on a null resolve
  // rather than blank space (spec §34/§35). Same private-bucket concern the avatar
  // and QuickMediaRow already route through CachedImage.
  return (
    <View style={frameStyle}>
      <CachedImage source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackLabel="" />
    </View>
  );
}

// ── Actor byline ─────────────────────────────────────────────────────────────

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function ActorByline({
  actor,
  publishedAt,
  experienceAt,
  accent = false,
}: {
  actor?: PublicActorRef;
  publishedAt: string;
  experienceAt?: string;
  accent?: boolean;
}) {
  const name = actor?.displayName ?? 'Someone';
  const showExperience = !!experienceAt && experienceAt !== publishedAt;
  return (
    <View style={s.byline} accessible accessibilityRole="header">
      <View style={s.avatar}>
        {actor?.avatarUrl ? (
          <CachedImage source={{ uri: actor.avatarUrl }} style={s.avatarImg} />
        ) : (
          <Text style={s.avatarInitials}>{initialsOf(name)}</Text>
        )}
      </View>
      <View style={s.bylineText}>
        <View style={s.nameRow}>
          <Text style={[s.name, accent && s.nameAccent]} numberOfLines={1}>
            {name}
          </Text>
          {actor?.isBuddy && (
            <View style={s.buddyTag}>
              <Text style={s.buddyTagText}>{actor.buddyRole ?? 'Buddy'}</Text>
            </View>
          )}
        </View>
        <Text style={s.meta} numberOfLines={1}>
          {actor?.handle ? `@${actor.handle} · ` : ''}
          {`Posted ${formatRelative(publishedAt)}`}
          {showExperience ? `  ·  Happened ${formatRelative(experienceAt as string)}` : ''}
        </Text>
      </View>
    </View>
  );
}

// ── Place line ───────────────────────────────────────────────────────────────

/** True when the projection carries a server-issued Ask Compass action (§21). */
export function hasAskCompassAction(projection: WallProjection): boolean {
  return (projection.actions ?? []).some((a) => a.type === 'ask_compass');
}

export function PlaceLine({ projection }: { projection: WallProjection }) {
  if (!projection.place) return null;
  const p = projection.place;
  const label = [p.name, p.city].filter(Boolean).join(' · ');
  return (
    <View style={s.placeRow}>
      <MapPin size={icon.s14} color={color.deep} />
      <Text style={s.placeText} numberOfLines={1}>
        {label}
      </Text>
      {/* Ask Compass from a place-linked post (spec §21) — an ACTION, not a
          permanent panel. Quiet and secondary so the post stays primary (§35).
          The server only issues the `ask_compass` action when
          `wall_compass_handoff_enabled` is on (WallProjectionService.buildActions);
          gate the chip on that action so the client never surfaces Compass the
          server withheld (§7: intelligence is optional and server-authoritative). */}
      {hasAskCompassAction(projection) ? <AskCompassChip projection={projection} /> : null}
    </View>
  );
}

/**
 * A compact "Ask Compass" affordance for a place-linked object (spec §21). Hands
 * the canonical object to the Compass ask surface via askCompassFromWall.
 * Compass appears here as an action/interpretation entry point — never a
 * standing panel, and never presenting inference as fact.
 */
export function AskCompassChip({ projection }: { projection: WallProjection }) {
  return (
    <Pressable
      style={s.compassChip}
      onPress={() => askCompassFromWall(projection)}
      accessibilityRole="button"
      accessibilityLabel="Ask Compass"
      hitSlop={6}
      testID={`wall-ask-compass-${projection.projectionId}`}
    >
      <CompassIcon size={icon.s14} color={color.deep} />
      <Text style={s.compassChipText} numberOfLines={1}>
        Ask Compass
      </Text>
    </Pressable>
  );
}

// ── Contextual action chips (optional / additive, spec §7) ───────────────────

export function ContextualActionChips({ projection }: { projection: WallProjection }) {
  // `open_object` is the whole-card tap, not a chip. `ask_compass` is surfaced by
  // the dedicated AskCompassChip in PlaceLine (spec §21) — excluding it here keeps
  // Compass to a single quiet affordance rather than a duplicate badge (§35).
  // `save` is the bookmark in SocialActionRow, the same argument: the server
  // emits the action (spec §2 needs a producer, and it carries the viewer's
  // current state), but rendering it AGAIN as a chip would put a second Save on
  // every post in the feed — precisely the "excessive badges" §35 forbids and
  // the "do not add actions to every object" §7 warns about.
  const actions = (projection.actions ?? []).filter(
    (a) => a.type !== 'open_object' && a.type !== 'ask_compass' && a.type !== 'save',
  );
  if (actions.length === 0) return null;
  return (
    <View style={s.chipRow}>
      {actions.slice(0, 3).map((action, idx) => (
        <Pressable
          key={`${action.type}-${idx}`}
          style={s.chip}
          onPress={() => runWallAction(action, projection)}
          accessibilityRole="button"
          accessibilityLabel={action.label}
        >
          <Text style={s.chipText} numberOfLines={1}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Standard social action row (keeps it enjoyable as social media, §40) ─────

export function SocialActionRow({ projection }: { projection: WallProjection }) {
  // Server truth, not component state (spec §2/§37: server-side state is
  // authoritative; never rely on client-only state). The optimistic flip below
  // is a rendering courtesy that REVERTS when the canonical write fails.
  const [saved, setSaved] = React.useState(projection.viewerSaved === true);
  React.useEffect(() => {
    setSaved(projection.viewerSaved === true);
  }, [projection.viewerSaved]);
  const open = () => runWallAction({ type: 'open_object', label: 'Open' }, projection);
  // Stamp/comment measure the distinct engagement (spec §32) then open the
  // canonical object where the interaction actually happens (spec §24).
  const stamp = () => {
    trackEngagement(projection, 'stamp');
    open();
  };
  const comment = () => {
    trackEngagement(projection, 'comment');
    open();
  };
  const toggleSave = () => {
    const next = !saved;
    setSaved(next); // optimistic
    trackEngagement(projection, 'save');
    trackAction(projection, 'save');
    // Write through to the canonical store; revert the optimism if it did not
    // land, so the icon never claims a save the server does not hold.
    void persistWallSave(projection, next).then((ok) => {
      if (!ok) setSaved(!next);
    });
  };
  const share = () => {
    trackEngagement(projection, 'share');
    trackAction(projection, 'share');
  };
  return (
    <View style={s.actionRow}>
      <Pressable style={s.action} onPress={stamp} accessibilityRole="button" accessibilityLabel="Stamp">
        <Sparkles size={icon.s20} color={color.mute} />
      </Pressable>
      <Pressable style={s.action} onPress={comment} accessibilityRole="button" accessibilityLabel="Comment">
        <MessageCircle size={icon.s20} color={color.mute} />
      </Pressable>
      <Pressable style={s.action} onPress={share} accessibilityRole="button" accessibilityLabel="Share">
        <Share2 size={icon.s20} color={color.mute} />
      </Pressable>
      <View style={{ flex: 1 }} />
      <Pressable
        style={s.action}
        onPress={toggleSave}
        accessibilityRole="button"
        accessibilityLabel={saved ? 'Saved' : 'Save'}
      >
        <Bookmark size={icon.s20} color={saved ? color.signal : color.mute} />
      </Pressable>
    </View>
  );
}

// ── Not-interested / hide control (spec §7 quiet control, §32 signal) ─────────

/**
 * A quiet per-object "not interested" control. Tapping it records the
 * not-interested signal (analytics, ids only — spec §32), tells the server to
 * stop surfacing the object (fire-and-forget `hide`, ids only), and asks the
 * feed to drop it locally via `onHide`. Deliberately understated so it never
 * competes with the post it hangs on (spec §35).
 */
export function NotInterestedControl({
  projection,
  onHide,
}: {
  projection: WallProjection;
  onHide?: (projectionId: string) => void;
}) {
  const onPress = () => {
    trackNotInterested(projection);
    void sendAction(
      {
        objectId: projection.canonicalObjectId,
        objectType: projection.objectType,
        session: projection.ranking?.session,
      },
      'hide',
    );
    onHide?.(projection.projectionId);
  };
  return (
    <Pressable
      style={s.notInterested}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Not interested"
      hitSlop={8}
      testID={`wall-not-interested-${projection.projectionId}`}
    >
      {/* §36 / WCAG 1.4.11: this icon is the ENTIRE visual of a control — there is
          no adjacent text — so it has to clear the 3:1 non-text floor. `faint` is
          2.73:1 on paper; `mute` is 5.27:1 and still reads as understated. */}
      <EyeOff size={icon.s16} color={color.mute} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  byline: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: {
    width: avatar.s40,
    height: avatar.s40,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarInitials: { ...t.small, color: color.mute, fontWeight: '700' },
  bylineText: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { ...t.bodyStrong, color: color.ink, fontWeight: '700', flexShrink: 1 },
  nameAccent: { color: color.deep },
  buddyTag: {
    backgroundColor: color.deep,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  buddyTagText: { ...t.stamp, color: color.onInk },
  // §36 contrast: `faint` fails WCAG AA on every Wall surface (2.73:1 on
  // paper, 2.88:1 on paperRaised). `mute` clears it at 5.27 / 5.55.
  meta: { ...t.small, color: color.mute },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  placeText: { ...t.small, color: color.deep, flexShrink: 1 },
  compassChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginLeft: 'auto',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  compassChipText: { ...t.small, color: color.deep, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: color.paper,
  },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    marginTop: space.md,
  },
  action: { padding: space.xs },
  notInterested: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    padding: space.xs,
    zIndex: 2,
  },
  mediaFrame: {
    width: '100%',
    backgroundColor: color.haze,
    overflow: 'hidden',
  },
  mediaRounded: { borderRadius: radius.md },
  mediaPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  mediaPlaceholderText: { ...t.small, color: color.mute, fontWeight: '600' },
});
