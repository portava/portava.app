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
  trackAction,
  trackEngagement,
  trackFollowFromFeed,
  trackHandoff,
  trackNotInterested,
  type WallHandoffSurface,
} from '../../services/wallAnalytics.ts';
import { askCompassFromWall } from '../../services/wallCompass.ts';
import { sendAction, type WallActionEvent } from '../../services/wallApi.ts';
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
    default:
      return null;
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

  // Record a Map/Place/Trip/Buddy bridge (§32) before routing.
  const surface = handoffSurfaceFor(action.type);
  if (surface) trackHandoff(projection, surface);

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
          permanent panel. Quiet and secondary so the post stays primary (§35). */}
      <AskCompassChip projection={projection} />
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
  const actions = (projection.actions ?? []).filter((a) => a.type !== 'open_object');
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
  const [saved, setSaved] = React.useState(false);
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
    setSaved((v) => !v);
    trackEngagement(projection, 'save');
    trackAction(projection, 'save');
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
      <EyeOff size={icon.s16} color={color.faint} />
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
  meta: { ...t.small, color: color.faint },
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
  mediaPlaceholderText: { ...t.small, color: color.faint, fontWeight: '600' },
});
