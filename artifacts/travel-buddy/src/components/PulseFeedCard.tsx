import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, Share, useWindowDimensions } from 'react-native';
import { CachedImage, withStorageParams } from './CachedImage.tsx';
import { AvatarImage } from './ui/DisplayMediaImage.tsx';
import { batchSignUrls } from '../lib/batchSignMedia.ts';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  MapPin, Heart, MessageCircle, Bookmark, MoreHorizontal, HelpCircle, Users,
  Sparkles, Gem, Route, Info, Plus, ShieldCheck, Clock, PlayCircle,
} from 'lucide-react-native';
import type { PulseFeedItem } from '../types/models.ts';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens.ts';
import { usePlanPicker } from './PlanPickerController.tsx';
import { RichText } from './RichText.tsx';
import { CompassFeedbackMenu } from './compass/CompassFeedbackMenu.tsx';
import { CompassWhySheet } from './compass/CompassWhySheet.tsx';
import { resolveCompassTitle, formatCompassSubtitle } from '../utils/compassFormat.ts';
import { PostEngagementBar } from './PostEngagementBar.tsx';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { useSession } from '../context/SessionContext.tsx';
import { LocationChip } from './LocationChip.tsx';
import type { LocationChipVariant } from './LocationChip.tsx';
import { ReportSheet } from './ReportSheet.tsx';
import { SaveButton } from './SaveButton.tsx';
import { deletePost } from '../services/postEngagement.ts';
import { hidePost } from '../services/posts.ts';
import { primaryIdentityText } from '../lib/displayIdentity.ts';
import { MediaStampOverlay } from './StampOverlayBadge.tsx';
import { VideoThumbnail } from './ui/VideoThumbnail.tsx';
import { UserIdentityLink } from './interaction/UserIdentityLink.tsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Map pulse_geo_tags.location_visibility to the LocationChip variant.
 * Falls back to city-level when no visibility info is available.
 */
function resolveLocationChipVariant(
  visibility: PulseFeedItem['locationVisibility'],
  neighborhood?: string,
): LocationChipVariant {
  switch (visibility) {
    case 'venue_tagged': return neighborhood ? 'neighborhood' : 'current_city';
    case 'neighborhood': return 'neighborhood';
    case 'city_only':    return 'current_city';
    case 'exact_hidden': return 'exact_private';
    case 'no_location':  return 'no_location';
    default:             return 'current_city';
  }
}

/* shared bits */
function AuthorRow({
  item, badge, light, onHide, onUnhide, onDeleteSuccess,
}: {
  item: PulseFeedItem;
  badge?: { label: string; bg: string; fg: string };
  light?: boolean;
  onHide?: () => void;
  onUnhide?: () => void;
  onDeleteSuccess?: () => void;
}) {
  const { userId: currentUserId } = useSession();
  const isOwner = !!currentUserId && currentUserId === item.author?.id;
  const ringState = useHighlightRingState(item.author?.id ?? null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const AVATAR_SIZE = 40;

  const handleAuthorPress = item.author?.username
    ? () => router.push(`/u/${item.author!.username}` as any)
    : undefined;

  const authorText = item.author
    ? primaryIdentityText({ name: item.author.name, username: item.author.username })
    : '';

  async function sharePost() {
    const permalink = `https://travelbuddy.app/posts/${item.id}`;
    try {
      await Share.share({ message: `Check out this post!\n${permalink}`, url: permalink });
    } catch {
      // user cancelled or share unavailable — silent
    }
  }

  function openOverflow() {
    if (isOwner) {
      Alert.alert('Post Options', undefined, [
        {
          text: 'Delete post',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Delete post?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  const ok = await deletePost(item.id);
                  if (ok) {
                    onDeleteSuccess?.();
                  } else {
                    Alert.alert('Error', 'Could not delete post. Please try again.');
                  }
                },
              },
            ]),
        },
        { text: 'Share post', onPress: sharePost },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      Alert.alert('Post Options', undefined, [
        { text: 'Share post', onPress: sharePost },
        { text: 'Report', onPress: () => setReportOpen(true) },
        {
          text: 'Hide from feed',
          onPress: async () => {
            onHide?.(); // optimistic dismiss
            const ok = await hidePost(item.id);
            if (!ok) {
              onUnhide?.(); // restore card
              Alert.alert('Error', 'Could not hide this post. Please try again.');
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  return (
    <View style={s.authorRow}>
      {item.author ? (
        <HighlightRing
          hasActive={ringState?.hasActive ?? false}
          allViewed={ringState?.allViewed ?? false}
          size={AVATAR_SIZE}
          ringWidth={2}
          gap={2}
          onPress={ringState?.hasActive ? () => setViewerOpen(true) : handleAuthorPress}
        >
          <AvatarImage
            uri={item.author.avatarUrl ?? undefined}
            user={{ name: item.author.name ?? undefined, username: item.author.username ?? undefined }}
            size={AVATAR_SIZE}
            style={s.avatar}
          />
        </HighlightRing>
      ) : null}
      <View style={{ flex: 1 }}>
        {badge ? <View style={[s.kindBadge, { backgroundColor: badge.bg }]}><Text style={[s.kindText, { color: badge.fg }]}>{badge.label}</Text></View> : null}
        {item.author ? (
          <Pressable onPress={handleAuthorPress}>
            <Text style={[s.author, light ? { color: color.onInk } : undefined]}>{authorText}</Text>
          </Pressable>
        ) : null}
        <Text style={[s.meta, light ? { color: color.onInkMute } : undefined]}>{item.timeAgo}{item.neighborhood ? ` · ${item.neighborhood}` : item.city ? ` · ${item.city}` : ''}</Text>
      </View>
      <Pressable hitSlop={layout.hitSlop} onPress={openOverflow}>
        <MoreHorizontal size={18} color={light ? color.onInkMute : color.faint} />
      </Pressable>

      {ringState?.highlights && (
        <HighlightViewer
          visible={viewerOpen}
          highlights={ringState.highlights}
          currentUserId={currentUserId ?? undefined}
          onClose={() => setViewerOpen(false)}
        />
      )}

      <ReportSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        subjectType="post"
        subjectId={item.id}
        subjectUserId={item.author?.id ?? undefined}
        subjectName={authorText || undefined}
      />
    </View>
  );
}

function TagRow({ tags, fallbackFirst }: { tags: string[]; fallbackFirst?: boolean }) {
  if (!tags.length) return null;
  return (
    <View style={s.tags}>
      {tags.map((tg, i) => (
        <View key={tg} style={s.tag}>
          <Text style={[s.tagText, fallbackFirst && i === 0 ? s.tagTextMuted : null]}>{tg}</Text>
        </View>
      ))}
    </View>
  );
}

function FitBadge() {
  return <View style={s.fit}><Clock size={11} color={color.success} /><Text style={s.fitText}>Fits your time</Text></View>;
}

/* ── Traveler Post placeholder (no media / failed image) ── */
function PostMediaPlaceholder({ city }: { city?: string }) {
  return (
    <View style={s.postPlaceholder}>
      <MapPin size={30} color={color.onInk} />
      {city ? <Text style={s.postPlaceholderCity}>{city.toUpperCase()}</Text> : null}
    </View>
  );
}

/* ── Traveler Post ── */
function PostCard({ item, onWhyPress, onDeleteSuccess, sessionId }: { item: PulseFeedItem; onWhyPress?: (id: string) => void; onDeleteSuccess?: () => void; sessionId?: string | null }) {
  const { width } = useWindowDimensions();
  const chipVariant = resolveLocationChipVariant(item.locationVisibility, item.neighborhood);
  const chipLabel   = item.venueName ?? item.neighborhood ?? item.city;
  const chipSublabel = item.locationDistrict ?? (item.neighborhood ? item.city : undefined);
  const [dismissed, setDismissed] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const dismiss = () => setDismissed(true);
  const undismiss = () => setDismissed(false);
  const handleDeleted = () => { dismiss(); onDeleteSuccess?.(); };

  // Batch-sign the main media URL so list renders share a single POST
  // /api/media/sign call (45-min cache) rather than one redirect per image.
  // When the private-bucket flag is OFF this resolves immediately with the
  // original URL (zero network overhead).
  const rawMediaUrl: string | undefined =
    item.media?.[0]?.thumbnail_url ?? item.media?.[0]?.url ?? item.mediaUrl ?? undefined;
  const [signedMediaUrl, setSignedMediaUrl] = useState<string | undefined>(rawMediaUrl);

  useEffect(() => {
    if (!rawMediaUrl) return;
    let cancelled = false;
    batchSignUrls([rawMediaUrl]).then((signed) => {
      if (!cancelled) setSignedMediaUrl(signed.get(rawMediaUrl) ?? rawMediaUrl);
    });
    return () => { cancelled = true; };
  }, [rawMediaUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (dismissed) return null;

  // 4:5 portrait media frame; capped at 600 for tablet/web
  const effectiveWidth = Math.min(width, 600);
  const mediaHeight = Math.round(effectiveWidth * (5 / 4));
  const tripLabel = item.tripLabel ?? undefined;

  return (
    <Pressable
      style={({ pressed }) => [s.postCard, width > 600 ? s.postCardWide : undefined, pressed && { opacity: 0.93 }]}
      onPress={() => router.push(`/post/${item.id}` as any)}
      accessible={false}
    >
      {/* ── Immersive media frame ── */}
      <View style={[s.postMedia, { height: mediaHeight }]}>
        {(item.media?.[0]?.thumbnail_url ?? item.media?.[0]?.url ?? item.mediaUrl) && !mediaFailed ? (
          item.media?.[0]?.media_type === 'video' ? (
            <VideoThumbnail
              posterUri={item.media[0].thumbnail_url ?? item.media[0].url}
              duration={item.media[0].duration_seconds ?? undefined}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            // signedMediaUrl is pre-resolved via batchSignUrls (relay URL when flag
            // is ON, original URL when OFF). withStorageParams passes relay URLs
            // through unchanged and adds Supabase transform params to original URLs.
            <CachedImage
              source={{ uri: withStorageParams(signedMediaUrl, 'width=400&quality=80') }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onError={() => setMediaFailed(true)}
            />
          )
        ) : (
          <PostMediaPlaceholder city={item.city} />
        )}
        {/* Passport-stamp overlay — sits on the photo, under the scrim/labels */}
        {!mediaFailed && <MediaStampOverlay raw={item.media?.[0]?.stamp_overlay} />}
        {/* Bottom scrim for AuthorRow readability.
            End-stop 0.85 + height 60 % ensures WCAG AA contrast (≥4.5:1) for
            white author-name text on the brightest travel media (snowy/beach). */}
        <LinearGradient
          colors={['rgba(17,17,15,0)', 'rgba(17,17,15,0.85)']}
          style={s.postScrim}
          pointerEvents="none"
        />
        {/* Passport-stamp label — city name top-left */}
        <View style={s.postcardLabel}>
          <MapPin size={9} color={color.onInk} />
          <Text style={s.postcardLabelText}>{item.city?.toUpperCase() ?? 'POSTCARD'}</Text>
        </View>
        {/* Date mark top-right */}
        <Text style={s.postcardDate}>{item.timeAgo}</Text>
        {/* Optional trip label badge */}
        {tripLabel ? (
          <View style={s.tripLabelBadge}>
            <Text style={s.tripLabelBadgeText}>{tripLabel}</Text>
          </View>
        ) : null}
        {/* AuthorRow on bottom scrim */}
        <View style={s.postAuthorOverlay}>
          <AuthorRow item={item} light onHide={dismiss} onUnhide={undismiss} onDeleteSuccess={handleDeleted} />
        </View>
      </View>

      {/* ── Content footer ── */}
      <View style={s.postFooter}>
        {item.caption ? (
          <RichText content={item.caption} tags={item.spanTags} hashtagUsages={item.spanHashtags} style={s.caption} numberOfLines={4} />
        ) : null}
        <TagRow tags={item.tags} fallbackFirst={item.categoryFallback} />
        {chipVariant !== 'no_location' && (
          <LocationChip
            variant={chipVariant}
            label={chipLabel}
            sublabel={chipSublabel}
            size="sm"
            muted
          />
        )}
        <View style={s.actions}>
          <View style={{ flex: 1 }}>
            <PostEngagementBar
              postId={item.id}
              likeCount={item.likeCount ?? 0}
              commentCount={item.commentCount ?? 0}
              likedByMe={item.likedByMe ?? false}
              canLike={item.canLike !== false}
              canComment={item.canComment !== false}
              canShare={item.canShare !== false}
            />
          </View>
          <SaveButton
            entityType="post"
            entityId={item.id}
            initialSaved={item.savedByMe ?? false}
            size={17}
            sessionId={sessionId}
          />
          <CompassFeedbackMenu
            recommendationId={item.id}
            itemType={item.type}
            category={item.type}
            onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
            onDismiss={dismiss}
          />
        </View>
      </View>
    </Pressable>
  );
}

/* ── Question ── */
function QuestionCard({ item, onWhyPress, onDeleteSuccess }: { item: PulseFeedItem; onWhyPress?: (id: string) => void; onDeleteSuccess?: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => setDismissed(true);
  const undismiss = () => setDismissed(false);
  const handleDeleted = () => { dismiss(); onDeleteSuccess?.(); };
  if (dismissed) return null;
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'QUESTION', bg: '#EFE7FA', fg: '#7A4DBF' }} onHide={dismiss} onUnhide={undismiss} onDeleteSuccess={handleDeleted} />
      <Text style={s.question}>{item.question}</Text>
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <View style={s.action}><HelpCircle size={15} color={color.mute} /><Text style={s.actionText}>{item.replyCount ?? 0} answers</Text></View>
        <View style={{ flex: 1 }} />
        <Pressable style={s.outlineBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={s.outlineText}>Answer</Text></Pressable>
        <CompassFeedbackMenu
          recommendationId={item.id}
          itemType={item.type}
          category={item.type}
          onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
          onDismiss={() => setDismissed(true)}
        />
      </View>
      {item.source === 'user' && (
        <PostEngagementBar
          postId={item.id}
          likeCount={item.likeCount ?? 0}
          commentCount={item.commentCount ?? 0}
          likedByMe={item.likedByMe ?? false}
          canLike={item.canLike !== false}
          canComment={item.canComment !== false}
          canShare={item.canShare !== false}
        />
      )}
    </View>
  );
}

/* ── Open Plan ── */
function PlanCard({ item, onWhyPress, onDeleteSuccess }: { item: PulseFeedItem; onWhyPress?: (id: string) => void; onDeleteSuccess?: () => void }) {
  const planPicker = usePlanPicker();
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => setDismissed(true);
  const undismiss = () => setDismissed(false);
  const handleDeleted = () => { dismiss(); onDeleteSuccess?.(); };
  if (dismissed) return null;
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'OPEN PLAN', bg: '#E3F1EA', fg: color.success }} onHide={dismiss} onUnhide={undismiss} onDeleteSuccess={handleDeleted} />
      <Text style={s.title}>{item.title}</Text>
      {item.time ? <View style={s.line}><Clock size={13} color={color.mute} /><Text style={s.lineText}>{item.time}</Text></View> : null}
      {item.neighborhood || item.city ? <View style={s.line}><MapPin size={13} color={color.mute} /><Text style={s.lineText}>{item.neighborhood ?? item.city}</Text></View> : null}
      {item.availabilityMatch ? <FitBadge /> : null}
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <Text style={s.going}>{item.attendeeCount ?? 0} going</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          style={({ pressed }) => [s.outlineBtn, pressed && { opacity: 0.7 }]}
          onPress={() => planPicker.open({ id: item.id, type: 'plan', title: item.title ?? 'Meetup', city: item.city, category: 'meeting_point' })}
        >
          <Text style={s.outlineText}>Add to Plan</Text>
        </Pressable>
        <Pressable style={s.solidBtn} onPress={() => router.push((item.relatedTripId ? `/trip/${item.relatedTripId}` : '/(tabs)/trips') as any)}><Text style={s.solidText}>Join Plan</Text></Pressable>
        <CompassFeedbackMenu
          recommendationId={item.id}
          itemType={item.type}
          category={item.type}
          onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
          onDismiss={() => setDismissed(true)}
        />
      </View>
    </View>
  );
}

/* ── Hidden Gem Share ── */
function GemCard({ item, onWhyPress, onDeleteSuccess, sessionId }: { item: PulseFeedItem; onWhyPress?: (id: string) => void; onDeleteSuccess?: () => void; sessionId?: string | null }) {
  const planPicker = usePlanPicker();
  const { userId: currentUserId } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => setDismissed(true);
  const undismiss = () => setDismissed(false);
  const handleDeleted = () => { dismiss(); onDeleteSuccess?.(); };
  if (dismissed) return null;
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'HIDDEN GEM', bg: '#E3F1EA', fg: color.success }} onHide={dismiss} onUnhide={undismiss} onDeleteSuccess={handleDeleted} />
      <View style={s.media}><View style={s.gemIcon}><Gem size={15} color={color.onInk} /></View></View>
      <Text style={s.title}>{item.title}</Text>
      {item.blurb ? <RichText content={item.blurb} tags={item.spanTags} hashtagUsages={item.spanHashtags} currentUserId={currentUserId ?? undefined} style={s.blurb} /> : null}
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => planPicker.open({ id: item.id, type: 'hidden_gem', title: item.title ?? 'Hidden gem', city: item.city, category: 'Hidden Gem' })}><Text style={s.outlineText}>Add to Plan</Text></Pressable>
        <View style={{ flex: 1 }} />
        <SaveButton entityType="post" entityId={item.id} initialSaved={item.savedByMe ?? false} size={17} sessionId={sessionId} />
        <CompassFeedbackMenu
          recommendationId={item.id}
          itemType={item.type}
          category={item.type}
          onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
          onDismiss={dismiss}
        />
      </View>
    </View>
  );
}

/* ── Itinerary / Plan Idea ── */
function ItineraryCard({ item, onWhyPress, onDeleteSuccess, sessionId }: { item: PulseFeedItem; onWhyPress?: (id: string) => void; onDeleteSuccess?: () => void; sessionId?: string | null }) {
  const planPicker = usePlanPicker();
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => setDismissed(true);
  const undismiss = () => setDismissed(false);
  const handleDeleted = () => { dismiss(); onDeleteSuccess?.(); };
  if (dismissed) return null;
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'ITINERARY', bg: '#E2EDF0', fg: color.deep }} onHide={dismiss} onUnhide={undismiss} onDeleteSuccess={handleDeleted} />
      <View style={s.titleRow}>
        <Route size={16} color={color.deep} />
        <Text style={[s.title, { flex: 1 }]}>{item.title}</Text>
        {item.estimate ? <Text style={s.estimate}>{item.estimate}</Text> : null}
      </View>
      {item.steps?.map((step, i) => (
        <View key={i} style={s.step}><Text style={s.stepN}>{i + 1}</Text><Text style={s.stepText}>{step}</Text></View>
      ))}
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => planPicker.open({ id: item.id, type: 'experience', title: item.title ?? 'Itinerary', city: item.city, category: 'Itinerary' })}><Text style={s.outlineText}>Use this plan</Text></Pressable>
        <View style={{ flex: 1 }} />
        <SaveButton entityType="post" entityId={item.id} initialSaved={item.savedByMe ?? false} size={17} sessionId={sessionId} />
        <CompassFeedbackMenu
          recommendationId={item.id}
          itemType={item.type}
          category={item.type}
          onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
          onDismiss={dismiss}
        />
      </View>
    </View>
  );
}

/* ── Circle Activity ── */
function CircleCard({ item }: { item: PulseFeedItem }) {
  const { userId: currentUserId } = useSession();
  return (
    <View style={[s.card, s.circleCard]}>
      <View style={s.circleHead}>
        <View style={s.circleBadge}><Users size={13} color={color.onInk} /></View>
        <Text style={s.circleLabel}>CIRCLE ACTIVITY</Text>
      </View>
      <Text style={s.circleText}>{item.activityText}</Text>
      <View style={s.circleRow}>
        <View style={{ flexDirection: 'row' }}>
          {(item.participants ?? []).slice(0, 4).map((p, i) => (
            <UserIdentityLink
              key={p.id}
              userId={p.id}
              handle={p.username ?? null}
              currentUserId={currentUserId}
              style={{ marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }}
              testID={`identity-link-${p.id}`}
            >
              <AvatarImage
                uri={p.avatarUrl ?? undefined}
                size={30}
                style={s.circleAvatar}
              />
            </UserIdentityLink>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        <Pressable style={s.outlineBtn} onPress={() => router.push('/circle')}><Text style={s.outlineText}>See Circle</Text></Pressable>
      </View>
    </View>
  );
}

/* ── Compass Suggestion (stub-real: only with explicit reason) ── */
function CompassCard({ item, onWhyPress }: { item: PulseFeedItem; onWhyPress?: (id: string) => void }) {
  const planPicker = usePlanPicker();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <View style={[s.card, s.compassCard]}>
      <View style={s.compassHead}>
        <View style={s.compassBadge}><Sparkles size={13} color={color.onInk} /></View>
        <Text style={s.compassLabel}>COMPASS SUGGESTION</Text>
      </View>
      <Text style={s.title}>{resolveCompassTitle(item)}</Text>
      {(() => {
        const subtitle = formatCompassSubtitle(item);
        return subtitle ? <Text style={s.meta} numberOfLines={1}>{subtitle}</Text> : null;
      })()}
      {item.reason ? <View style={s.reasonRow}><Info size={13} color={color.deep} /><Text style={s.reason}>{item.reason}</Text></View> : null}
      {item.isProvisional ? <Text style={s.prov}>Based on starter city notes — provisional</Text> : null}
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={s.outlineText}>View Details</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable style={s.solidBtn} onPress={() => planPicker.open({ id: item.id, type: 'compass_suggestion', title: resolveCompassTitle(item), city: item.city, category: 'Compass' })}><Plus size={14} color={color.onInk} /><Text style={s.solidText}>Add to Plan</Text></Pressable>
        <CompassFeedbackMenu
          recommendationId={item.id}
          itemType={item.type}
          category={item.type}
          onWhyPress={item.recommendationId ? () => onWhyPress?.(item.recommendationId!) : undefined}
          onDismiss={() => setDismissed(true)}
        />
      </View>
    </View>
  );
}

/* ── City Note (provisional) ── */
function CityNoteCard({ item }: { item: PulseFeedItem }) {
  const { userId: currentUserId } = useSession();
  return (
    <View style={[s.card, s.noteCard]}>
      <View style={s.noteHead}><Text style={s.noteLabel}>STARTER CITY NOTE</Text></View>
      <Text style={s.title}>{item.title}</Text>
      {item.blurb ? <RichText content={item.blurb} tags={item.spanTags} hashtagUsages={item.spanHashtags} currentUserId={currentUserId ?? undefined} style={s.blurb} /> : null}
      <View style={s.provRow}><Info size={11} color={color.mute} /><Text style={s.provInline}>Provisional — not verified</Text></View>
    </View>
  );
}

/* ── Safety (only renders when item present) ── */
function SafetyCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, s.safetyCard]}>
      <View style={s.safetyHead}><ShieldCheck size={16} color={color.success} /><Text style={s.safetyLabel}>HEADS-UP</Text></View>
      <Text style={s.blurb}>{item.blurb}</Text>
    </View>
  );
}

/* ── Rent a Buddy promotional card ── */
function RentABuddyCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, rab.card]}>
      <View style={rab.head}>
        <View style={rab.stamp}><Text style={rab.stampText}>RENT A BUDDY</Text></View>
        <Text style={rab.title}>Connect with a local who knows the city</Text>
        <Text style={rab.sub}>Arrival help, city tours, nightlife, language support & more in {item.city}.</Text>
      </View>
      <View style={rab.ctaRow}>
        <Pressable style={rab.ctaSolid} onPress={() => router.push('/(rent-a-buddy)/search' as any)}>
          <Users size={13} color="#fff" />
          <Text style={rab.ctaSolidText}>Find a Buddy</Text>
        </Pressable>
        <Pressable style={rab.ctaOutline} onPress={() => router.push('/(rent-a-buddy)/become' as any)}>
          <Text style={rab.ctaOutlineText}>Become a Buddy</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ── Place recommendation card (type = 'place_card') ── */
function PlaceRecommendationCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, plc.card]}>
      <View style={plc.badge}><Text style={plc.badgeText}>NEARBY PLACE</Text></View>
      <Text style={plc.name} numberOfLines={2}>{item.title}</Text>
      {(item.neighborhood ?? item.city) ? (
        <View style={s.locationRow}>
          <MapPin size={11} color={color.mute} />
          <Text style={s.lineText} numberOfLines={1}>
            {[item.neighborhood, item.city].filter(Boolean).join(', ')}
          </Text>
        </View>
      ) : null}
      {item.blurb ? <Text style={plc.blurb} numberOfLines={2}>{item.blurb}</Text> : null}
      {item.tags?.length ? (
        <View style={[s.tags, { marginTop: 2 }]}>
          {item.tags.slice(0, 2).map((tag) => (
            <View key={tag} style={s.tag}><Text style={s.tagText}>{tag}</Text></View>
          ))}
        </View>
      ) : null}
      <Pressable
        style={plc.exploreBtn}
        onPress={() => router.push({
          pathname: '/(tabs)/discovery' as any,
          params: {
            placeId: item.placeId ?? '',
            placeName: item.title ?? '',
            placeCity: item.city ?? '',
            placeBlurb: item.blurb ?? '',
          },
        })}
      >
        <Text style={plc.exploreBtnText}>See Place Details →</Text>
      </Pressable>
    </View>
  );
}

/* ── Unified renderer: switch on type ── */
export function PulseFeedCard({ item, onDeleteSuccess, sessionId }: { item: PulseFeedItem; onDeleteSuccess?: () => void; sessionId?: string | null }) {
  const [whyId, setWhyId] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);

  const handleWhyPress = (id: string) => { setWhyId(id); setWhyOpen(true); };

  let card: React.ReactNode;
  switch (item.type) {
    case 'post':               card = <PostCard item={item} onWhyPress={handleWhyPress} onDeleteSuccess={onDeleteSuccess} sessionId={sessionId} />; break;
    case 'question':           card = <QuestionCard item={item} onWhyPress={handleWhyPress} onDeleteSuccess={onDeleteSuccess} />; break;
    case 'plan':               card = <PlanCard item={item} onWhyPress={handleWhyPress} onDeleteSuccess={onDeleteSuccess} />; break;
    case 'hidden_gem':         card = <GemCard item={item} onWhyPress={handleWhyPress} onDeleteSuccess={onDeleteSuccess} sessionId={sessionId} />; break;
    case 'itinerary':          card = <ItineraryCard item={item} onWhyPress={handleWhyPress} onDeleteSuccess={onDeleteSuccess} sessionId={sessionId} />; break;
    case 'circle_activity':    card = <CircleCard item={item} />; break;
    case 'compass_suggestion': card = item.reason ? <CompassCard item={item} onWhyPress={handleWhyPress} /> : null; break;
    case 'city_note':          card = item.isProvisional ? <CityNoteCard item={item} /> : null; break;
    case 'safety':             card = item.blurb ? <SafetyCard item={item} /> : null; break;
    case 'rent_a_buddy':       card = <RentABuddyCard item={item} />; break;
    case 'place_card':         card = <PlaceRecommendationCard item={item} />; break;
    default:                   card = null;
  }

  return (
    <>
      {card}
      <CompassWhySheet
        visible={whyOpen}
        recommendationId={whyId}
        onClose={() => setWhyOpen(false)}
      />
    </>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.deep },
  avatarFallbackText: { color: color.onInk, fontSize: 16, fontWeight: '700' },
  author: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  meta: { ...t.small, color: color.faint, fontSize: 12, lineHeight: 16 },
  kindBadge: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm, marginBottom: 3 },
  kindText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

  media: { height: 150, borderRadius: radius.sm, backgroundColor: color.deep, overflow: 'hidden', justifyContent: 'flex-start', padding: space.sm },
  mediaTag: { alignSelf: 'flex-start', backgroundColor: 'rgba(17,17,15,0.5)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  mediaTagText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  gemIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.success, alignItems: 'center', justifyContent: 'center' },

  caption: { ...t.body, color: color.ink, lineHeight: 22 },
  question: { ...t.heading, color: color.ink, fontSize: 17 },
  title: { ...t.heading, color: color.ink, fontSize: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  estimate: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  blurb: { ...t.small, color: color.mute },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  lineText: { ...t.small, color: color.mute },
  locationRow: { flexDirection: 'row', alignItems: 'center', marginTop: -2 },

  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  tagText: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 11 },
  tagTextMuted: { ...t.small, color: color.mute, fontWeight: '400', fontSize: 11 },

  fit: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: '#E3F1EA', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  fitText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 11 },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 2 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { ...t.small, color: color.mute, fontWeight: '600' },
  going: { ...t.small, color: color.mute },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  outlineText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  solidBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  solidText: { ...t.small, fontWeight: '800', color: color.onInk, fontSize: 12 },

  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepN: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.deep, width: 16 },
  stepText: { ...t.small, color: color.ink, flex: 1 },

  circleCard: { backgroundColor: '#F3F0FB', borderColor: '#E0D6F5' },
  circleHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  circleBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#7A4DBF', alignItems: 'center', justifyContent: 'center' },
  circleLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: '#7A4DBF', letterSpacing: 1 },
  circleText: { ...t.bodyStrong, color: color.ink },
  circleRow: { flexDirection: 'row', alignItems: 'center' },
  circleAvatar: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#F3F0FB', backgroundColor: color.haze },

  compassCard: { borderColor: color.deep, borderWidth: 1.5 },
  compassHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  compassBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  compassLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.deep, letterSpacing: 1 },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E2EDF0', alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  reason: { ...t.small, color: color.deep, fontSize: 11 },
  prov: { ...t.small, color: color.faint, fontStyle: 'italic', fontSize: 11 },

  noteCard: { backgroundColor: color.paper, borderStyle: 'dashed' },
  noteHead: {},
  noteLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1 },
  provRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  provInline: { ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' },

  safetyCard: { backgroundColor: '#FBF6EC', borderColor: '#EAD9B5' },
  safetyHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  safetyLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.warn, letterSpacing: 1 },

  // ── Immersive PostCard (type='post') — full-bleed, edge-to-edge on mobile ─────
  postCard: { backgroundColor: color.paperRaised, overflow: 'hidden' },
  postCardWide: { maxWidth: 600, alignSelf: 'center' as const, width: '100%', borderRadius: 14, ...shadow.card },
  postMedia: { overflow: 'hidden', backgroundColor: color.deep },
  videoPlayBadge: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
  },
  postScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '65%' },
  postAuthorOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, paddingBottom: 14 },
  postcardLabel: {
    position: 'absolute', top: 14, left: 14,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(17,17,15,0.48)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  postcardLabelText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: 'rgba(250,249,246,0.95)', letterSpacing: 1.2 },
  postcardDate: { position: 'absolute', top: 16, right: 14, fontFamily: 'Courier', fontSize: 10, fontWeight: '600', color: 'rgba(250,249,246,0.70)', letterSpacing: 0.5 },
  tripLabelBadge: { position: 'absolute', bottom: 76, left: 14, backgroundColor: color.signal, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12 },
  tripLabelBadgeText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: color.onInk, letterSpacing: 0.5 },
  postFooter: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 10, backgroundColor: color.paperRaised },
  postPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  postPlaceholderCity: { fontFamily: 'Courier', fontSize: 11, color: color.onInk, fontWeight: '700', letterSpacing: 1.5 },
});

const plc = StyleSheet.create({
  card:           { backgroundColor: '#F0FBF4', borderColor: '#A8DFB8' },
  badge:          { alignSelf: 'flex-start', backgroundColor: '#D1F0DC', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm },
  badgeText:      { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: '#276C43', letterSpacing: 0.5 },
  name:           { ...t.heading, color: color.ink, fontSize: 16 },
  blurb:          { ...t.small, color: color.mute },
  exploreBtn:     { marginTop: 2, alignSelf: 'flex-start', backgroundColor: '#276C43', borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 7 },
  exploreBtnText: { ...t.small, color: '#fff', fontWeight: '700', fontSize: 12 },
});

const rab = StyleSheet.create({
  card: { backgroundColor: '#FFF5F5', borderColor: '#E53935' + '30' },
  head: { gap: 4 },
  stamp: { alignSelf: 'flex-start', backgroundColor: '#E53935', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, transform: [{ rotate: '-1deg' }], marginBottom: 4 },
  stampText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: '#fff', letterSpacing: 1.5 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  sub: { ...t.small, color: color.mute, fontSize: 12 },
  ctaRow: { flexDirection: 'row', gap: space.sm, marginTop: 2 },
  ctaSolid: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#E53935', borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8 },
  ctaSolidText: { ...t.small, fontWeight: '800', color: '#fff', fontSize: 12 },
  ctaOutline: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: '#E53935', borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8 },
  ctaOutlineText: { ...t.small, fontWeight: '800', color: '#E53935', fontSize: 12 },
});
