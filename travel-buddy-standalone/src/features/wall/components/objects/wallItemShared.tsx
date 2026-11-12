import { PostTakeover } from '../../../../components/PostTakeover.tsx';
import { FullscreenPhoto } from '../../../../components/ui/FullscreenPhoto.tsx';
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
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Share, Alert } from 'react-native';
import { CachedImage } from '../../../../components/CachedImage.tsx';
import { router } from 'expo-router';
import {
  MapPin,
  Sparkles,
  MessageCircle,
  Share2,
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
import { SaveButton } from '../../../../components/SaveButton.tsx';
import { ShareSheet } from '../../../../components/ShareSheet.tsx';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../../../services/discoveryViewerScope.ts';
import { useInputAccountEpoch } from '../../../../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { useWallActionOptions, type WallActionOptions } from '../WallActionContext.tsx';
import { followUser } from '../../../../services/follows.ts';
import { bumpSocialVersion } from '../../../../hooks/useSocialVersion.ts';
import { openDirectThread } from '../../../../services/messaging.ts';
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
  const placeId = action.targetType === 'place' ? action.targetId : projection.place?.placeId ?? null;
  const objId = projection.canonicalObjectId;
  switch (action.type) {
    case 'open_object':
      if (projection.objectType === 'shared_moment') return `/shared-moments/${objId}`; // the screen is app/shared-moments/[id]; a bare /shared-moments opened "This screen doesn't exist"
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
      if (!placeId) return '/map?entry=unknown';
      const mapParams = new URLSearchParams({ focusId: placeId, entityTypes: 'place' });
      const p = projection.place;
      if (p?.placeId === placeId && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        mapParams.set('lat', String(p.lat)); mapParams.set('lng', String(p.lng));
        mapParams.set('zoom', '15');
      }
      return `/map?entry=unknown&${mapParams}`;
    case 'add_to_trip':
      return null; // the canonical plan picker receives the place through WallActionContext
    case 'message':
      // /messages/[id] takes a thread ID. Resolve the recipient asynchronously
      // through the canonical messaging service; opening this action never sends.
      return null; // the asynchronous direct-thread resolver below preserves the recipient
    case 'explore':
      return action.targetType === 'hidden_gem' && action.targetId ? `/gems/${encodeURIComponent(action.targetId)}` : '/gems';
    case 'see_who':
      return `/post/${objId}`;
    case 'see_live':
      return null; // handled by the Live For You strip, not per-object
    case 'ask_compass':
      return null; // handled by askCompassFromWall (canonical prefill handoff, §21)
    case 'book_buddy':
      return action.targetId ? `/(rent-a-buddy)/buddy/${encodeURIComponent(action.targetId)}` : null;
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

export async function runWallAction(action: WallAction, projection: WallProjection, options: WallActionOptions = {}): Promise<boolean> {
  const scope = currentDiscoveryScope();
  const current = () => isCurrentDiscoveryScope(scope) && (options.isCurrent?.() ?? true);
  if (!current()) return false;
  if (action.type === 'follow' || action.type === 'message') {
    const target = action.targetType === 'user' ? action.targetId : projection.actor?.userId;
    if (!target) { Alert.alert('Could not open this action', 'The person is no longer available.'); return false; }
    try {
      if (action.type === 'follow') {
        if (!current()) return false;
        const res = await followUser(target);
        if (!current()) return false;
        if (!res.ok || res.data?.following !== true) throw new Error(res.message ?? 'Please try again.');
        bumpSocialVersion();
        trackFollowFromFeed(projection, projection.objectType === 'discovery');
      } else {
        if (!current()) return false;
        const res = await openDirectThread(target);
        if (!current()) return false;
        if (!res.ok || !res.data?.threadId) throw new Error(res.message ?? 'Messaging is not available for this person.');
        router.push(`/messages/${encodeURIComponent(res.data.threadId)}` as never);
        trackHandoff(projection, 'buddy');
      }
      trackAction(projection, actionEventFor(action.type));
      return true;
    } catch (error) {
      if (current()) Alert.alert(action.type === 'follow' ? 'Could not follow' : 'Could not open chat', error instanceof Error ? error.message : 'Please try again.');
      return false;
    }
  }
  if (action.type === 'add_to_trip') {
    const place = projection.place;
    const placeId = typeof action.params?.placeId === 'string' ? action.params.placeId : action.targetType === 'place' ? action.targetId : place?.placeId;
    if (!placeId || !options.openPlanPicker) {
      Alert.alert('Could not add to a trip', 'This place is not available. Please open the place and try again.');
      return false;
    }
    try {
      const matchingPlace = place?.placeId === placeId ? place : undefined;
      options.openPlanPicker({ id: placeId, type: 'place', title: matchingPlace?.name ?? 'Place', city: matchingPlace?.city ?? undefined, locationName: matchingPlace?.name, lat: matchingPlace?.lat, lng: matchingPlace?.lng });
      trackAction(projection, 'tap');
      trackHandoff(projection, 'trip');
      return true;
    } catch {
      if (current()) Alert.alert('Could not add to a trip', 'Please try again.');
      return false;
    }
  }
  trackAction(projection, actionEventFor(action.type));

  // Ask Compass — hand the canonical object to the Compass ask surface (§21).
  // askCompassFromWall records the compass handoff itself, so return after it.
  if (action.type === 'ask_compass') {
    askCompassFromWall(projection);
    return true;
  }

  // `save` is a WRITE, not a navigation. It goes to the canonical save store and
  // returns — there is no surface to push (spec §2/§24).
  if (action.type === 'save') {
    const next = !(action.params?.saved === true);
    const ok = await persistWallSave(projection, next);
    if (!ok && current()) Alert.alert('Could not save', 'Please try again.');
    return ok;
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
      return true;
    } catch {
      Alert.alert('Could not open this item', 'Please try again.');
    }
  }
  return false;
}

// ── Media (single-image frame with a processing placeholder, spec §34) ───────

export function WallImage({
  media, postId,
  ratio = aspect.card,
  rounded = true,
}: {
  media?: DisplayMedia;
  postId?: string;
  ratio?: number;
  rounded?: boolean;
}) {
  const [opened, setOpened] = React.useState(false);
  const uri = pickWallImageRef(media, wallImageTargetPx(useWindowDimensions())); // §33: the smallest stored variant that covers the frame — the same pick the prefetch warms
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
  const image = <CachedImage source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackLabel="" />;
  if (postId) return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Open post" style={frameStyle} onPress={() => setOpened(true)}>{image}</Pressable>
    {opened && <PostTakeover postId={postId} initialMediaUri={media?.url ?? undefined} onClose={() => setOpened(false)} />}
  </>;
  return media?.kind === 'image' ? <FullscreenPhoto uri={media.url ?? uri} style={frameStyle}>{image}</FullscreenPhoto>
    : <View style={frameStyle}>{image}</View>;
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

export function PlaceLine({ projection, onDark = false }: { projection: WallProjection; onDark?: boolean }) {
  if (!projection.place) return null;
  const p = projection.place;
  const label = [p.name, p.city].filter(Boolean).join(' · ');
  return (
    <View style={s.placeRow}>
      <MapPin size={icon.s14} color={onDark ? color.onInk : color.deep} />
      <Text style={[s.placeText, onDark && { color: color.onInk }]} numberOfLines={1}>
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
  const epoch = useInputAccountEpoch();
  return <ContextualActionChipsForObject key={`${epoch}:${projection.projectionId}`} projection={projection} />;
}

function ContextualActionChipsForObject({ projection }: { projection: WallProjection }) {
  const options = useWallActionOptions();
  const [pending, setPending] = React.useState<string | null>(null);
  const [followed, setFollowed] = React.useState(false);
  const busy = React.useRef(false);
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
          disabled={pending !== null || (action.type === 'follow' && followed)}
          onPress={async () => {
            if (busy.current || (action.type === 'follow' && followed)) return;
            busy.current = true; setPending(action.type);
            try {
              const ok = await runWallAction(action, projection, options);
              if (ok && action.type === 'follow' && options.isCurrent?.() !== false) setFollowed(true);
            } finally {
              busy.current = false;
              if (options.isCurrent?.() !== false) setPending(null);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={action.type === 'follow' && followed ? 'Following' : action.label}
          accessibilityState={{ disabled: pending !== null || (action.type === 'follow' && followed), busy: pending === action.type }}
        >
          <Text style={s.chipText} numberOfLines={1}>
            {action.type === 'follow' && followed ? 'Following' : pending === action.type ? 'Please wait…' : action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Standard social action row (keeps it enjoyable as social media, §40) ─────

export function SocialActionRow({ projection, onDark = false, onOpenPost }: { projection: WallProjection; onDark?: boolean; onOpenPost?: () => void }) {
  const epoch = useInputAccountEpoch();
  return <SocialActionRowForObject key={`${epoch}:${projection.projectionId}`} projection={projection} onDark={onDark} onOpenPost={onOpenPost} />;
}

function SocialActionRowForObject({ projection, onDark, onOpenPost }: { projection: WallProjection; onDark: boolean; onOpenPost?: () => void }) {
  const actionTint = onDark ? color.onInk : color.mute;
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareMounted, setShareMounted] = React.useState(false);
  const postLike = POST_SAVEABLE_TYPES.has(projection.objectType);
  const canonicalLink = !postLike ? wallShareUrl(projection) : null;
  const [postOpen, setPostOpen] = React.useState(false);
  const open = () => {
    if (postLike) {
      trackAction(projection, 'tap');
      if (onOpenPost) onOpenPost(); else setPostOpen(true);
    } else void runWallAction({ type: 'open_object', label: 'Open' }, projection);
  };
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
  const share = () => {
    if (postLike || canonicalLink) { setShareMounted(true); setShareOpen(true); }
    else Alert.alert('Could not share', 'This item has no shareable link.');
  };
  return (
    <View style={s.actionRow}>
      <Pressable style={s.action} onPress={stamp} accessibilityRole="button" accessibilityLabel="Stamp">
        <Sparkles size={icon.s20} color={actionTint} />
      </Pressable>
      <Pressable style={s.action} onPress={comment} accessibilityRole="button" accessibilityLabel="Comment">
        <MessageCircle size={icon.s20} color={actionTint} />
      </Pressable>
      <Pressable style={s.action} onPress={share} accessibilityRole="button" accessibilityLabel="Share">
        <Share2 size={icon.s20} color={actionTint} />
      </Pressable>
      <View style={{ flex: 1 }} />
      {postLike ? <SaveButton entityType="post" entityId={projection.canonicalObjectId} initialSaved={projection.viewerSaved === true} size={icon.s20} tint={onDark ? color.onInk : undefined} recordRankOutcome={false} onSavedChange={(saved) => {
        if (saved) { trackEngagement(projection, 'save'); trackAction(projection, 'save'); }
      }} /> : null}
      {postOpen && <PostTakeover postId={projection.canonicalObjectId} onClose={() => setPostOpen(false)} />}
      {shareMounted ? <ShareSheet visible={shareOpen} {...(postLike ? { postId: projection.canonicalObjectId, telegraphObject: { objectType: 'POST' as const, objectId: projection.canonicalObjectId } } : { canonicalLink: { url: canonicalLink!, title: 'Share moment' } })} onClose={() => setShareOpen(false)} onShareSuccess={() => {
        trackEngagement(projection, 'share'); trackAction(projection, 'share');
      }} /> : null}
    </View>
  );
}

// ── Not-interested / hide control (spec §7 quiet control, §32 signal) ─────────

/**
 * A quiet per-object "not interested" control. Tapping it records the
 * not-interested signal (analytics, ids only — spec §32), tells the server to
 * stop surfacing the object (`hide`, ids only), and asks the
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
  const busy = React.useRef(false);
  const onPress = async () => {
    if (busy.current) return;
    busy.current = true;
    const owner = currentDiscoveryScope();
    trackNotInterested(projection);
    onHide?.(projection.projectionId);
    let saved = false;
    try { saved = await sendAction(
      {
        objectId: projection.canonicalObjectId,
        objectType: projection.objectType,
        session: projection.ranking?.session,
      },
      'hide',
    ); } catch {} finally { busy.current = false; }
    if (!saved && isCurrentDiscoveryScope(owner)) Alert.alert('Hidden from this feed', 'Couldn’t save this preference. It may appear again after you reopen the app.');
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

// Imported at the TAIL so no cited line above moves; ESM hoists it.
import { pickWallImageRef, wallImageTargetPx } from '../../services/wallImageVariant.ts';
import { entityUrl } from '../../../../services/shareAdapters.ts';

// ── Share (spec §2 "share") — at the tail for the same reason ───────────────

/**
 * The public link for a Wall object, from the share layer's one path map
 * (services/shareAdapters): the post's page for a post-like object, the
 * Moment's page for a shared moment, null for an object with no page.
 */
export function wallShareUrl(projection: WallProjection): string | null {
  if (projection.objectType === 'shared_moment') return entityUrl('sharedMoment', projection.canonicalObjectId);
  if (POST_SAVEABLE_TYPES.has(projection.objectType)) return entityUrl('post', projection.canonicalObjectId);
  return null;
}

/** Opens the OS share sheet with the object's link; says so when it cannot. */
async function shareWallObject(projection: WallProjection): Promise<void> {
  const url = wallShareUrl(projection);
  if (!url) {
    Alert.alert('Can’t share this', 'This item has no link to share.');
    return;
  }
  const text = projection.text?.trim() ?? '';
  const preview = text ? `${text.length > 120 ? `${text.slice(0, 120)}…` : text}\n\n` : '';
  try {
    await Share.share({ message: `${preview}${url}`, url });
  } catch {
    Alert.alert('Couldn’t share', 'Sharing isn’t available right now. Please try again.');
  }
}
