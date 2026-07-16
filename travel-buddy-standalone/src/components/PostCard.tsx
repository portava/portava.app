import React, { useState } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, Platform, Dimensions,
} from 'react-native';
import { router } from 'expo-router';
import { getMediaFilter, buildCssFilter } from '../lib/media/filters.ts';
import { MapPin, Sparkles, MessageCircleQuestion, CalendarDays, PlayCircle, MoreVertical } from 'lucide-react-native';
import type { Post } from '../types/models.ts';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { Stamp, Avatar, Scrim, needsContrastFallback } from './ui.tsx';
import { ActionBar } from './ActionBar.tsx';
import { RichText } from './RichText.tsx';
import { useSession } from '../context/SessionContext.tsx';
import { ReportPostSheet } from './ReportPostSheet.tsx';
import { PostOwnerMenu, type PostSettings } from './PostOwnerMenu.tsx';
import { MediaStampOverlay } from './StampOverlayBadge.tsx';
import { SaveButton } from './SaveButton.tsx';

const { height: _screenH } = Dimensions.get('window');
const HERO_HEIGHT = Math.min(Math.round(_screenH * 0.60), 560);

const DEFAULT_SETTINGS: PostSettings = {
  commentsSetting: 'everyone',
  likesHidden: false,
  sharingDisabled: false,
  repostingDisabled: false,
};

/** Routes a post to the right card by kind. Hero falls back to standard if image too bright. */
export function PostCard({ post }: { post: Post }) {
  if (post.kind === 'hero') {
    const bright = needsContrastFallback(post.media[0]?.brightness);
    return bright ? <StandardCard post={post} /> : <HeroCard post={post} />;
  }
  if (post.kind === 'question') return <QuestionCard post={post} />;
  if (post.kind === 'itinerary') return <ItineraryCard post={post} />;
  return <StandardCard post={post} />;
}

// ── Subcomponents ──────────────────────────────────────────────────────────────

function Locator({ post, onInk }: { post: Post; onInk?: boolean }) {
  return (
    <Pressable
      onPress={() => router.push(`/destination/${post.destination.slug}`)}
      style={styles.locator}
      hitSlop={6}
    >
      <MapPin size={12} color={onInk ? color.onInk : color.deep} />
      <Text style={[styles.locatorText, { color: onInk ? color.onInk : color.deep }]}>
        {post.destination.city}
      </Text>
    </Pressable>
  );
}

function Byline({ post, onInk }: { post: Post; onInk?: boolean }) {
  return (
    <Pressable
      style={styles.byline}
      onPress={() => router.push(`/profile/${post.author.handle}`)}
    >
      <Avatar uri={post.author.avatarUrl} size={28} />
      <Text style={[styles.bylineName, { color: onInk ? color.onInk : color.ink }]}>
        {post.author.name}
      </Text>
    </Pressable>
  );
}

function ImgPlaceholder({ city, fill }: { city?: string; fill?: boolean }) {
  return (
    <View style={[styles.imgPlaceholder, fill ? StyleSheet.absoluteFill : undefined]}>
      <MapPin size={28} color={color.onInk} />
      {city ? <Text style={styles.imgPlaceholderCity}>{city.toUpperCase()}</Text> : null}
    </View>
  );
}

/* 1. HERO — full-bleed image, scrim, editorial title overlaid. */
function HeroCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const [isReported, setIsReported] = useState(false);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [settings, setSettings] = useState<PostSettings>(DEFAULT_SETTINGS);
  const [imgFailed, setImgFailed] = useState(false);
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);
  if (isReported) return null;

  return (
    <Pressable style={[styles.card, styles.hero]} onPress={() => router.push(`/post/${post.id}`)}>
      {!imgFailed
        ? <Image source={{ uri: post.media[0].url }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setImgFailed(true)} />
        : <ImgPlaceholder city={post.destination?.city} fill />
      }
      {!imgFailed && <MediaStampOverlay raw={post.media[0]?.stampOverlay} />}
      <Scrim />
      <View style={styles.heroTop}>
        <Stamp label={post.category} tone="onInk" />
      </View>
      <Pressable
        hitSlop={8}
        onPress={() => isOwnPost ? setOwnerMenuOpen(true) : setReportOpen(true)}
        style={styles.heroMoreBtn}
      >
        <MoreVertical size={20} color={color.onInk} />
      </Pressable>
      <View style={styles.heroBottom}>
        <Locator post={post} onInk />
        <Text style={styles.heroTitle} numberOfLines={2}>{post.title}</Text>
        <View style={styles.heroByRow}>
          <Byline post={post} onInk />
          <View style={{ flex: 1 }} />
        </View>
        <View style={styles.heroActions}>
          <ActionBar
            tint={color.onInk}
            liked={post.liked}
            likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}
            renderSave={<SaveButton entityType="post" entityId={post.id} initialSaved={post.saved ?? false} size={20} tint={color.onInk} />}
          />
        </View>
      </View>
      {!isOwnPost && (
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} onReported={() => setIsReported(true)} />
      )}
      {isOwnPost && (
        <PostOwnerMenu
          visible={ownerMenuOpen}
          postId={post.id}
          settings={settings}
          onClose={() => setOwnerMenuOpen(false)}
          onSettingsChange={setSettings}
          onArchived={() => setOwnerMenuOpen(false)}
          onDeleted={() => router.back()}
          onEdit={() => router.push(`/post/${post.id}/edit` as any)}
        />
      )}
    </Pressable>
  );
}

/* 2. STANDARD — image first (if any), caption below. Cleaner, readable. */
function StandardCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const [isReported, setIsReported] = useState(false);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [settings, setSettings] = useState<PostSettings>(DEFAULT_SETTINGS);
  const hasMedia = post.media.length > 0;
  const isVideo = post.media[0]?.kind === 'video' || post.mediaType?.startsWith('video/');
  const hasFilterId = post.filterId && post.filterId !== 'original';
  const shouldApplyCssFilter = isVideo && hasFilterId;
  const cssFilter = shouldApplyCssFilter
    ? buildCssFilter(getMediaFilter(post.filterId), post.filterIntensity ?? 100)
    : 'none';
  const [imgFailed, setImgFailed] = useState(false);
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);
  if (isReported) return null;

  return (
    <View style={[styles.card, styles.standard]}>
      <View style={styles.stdHead}>
        <Byline post={post} />
        <View style={{ flex: 1 }} />
        <Locator post={post} />
        <Pressable
          hitSlop={8}
          onPress={() => isOwnPost ? setOwnerMenuOpen(true) : setReportOpen(true)}
          style={styles.moreBtn}
        >
          <MoreVertical size={16} color={color.mute} />
        </Pressable>
      </View>
      {/* Always render the media wrapper — placeholder shown for text-only or failed images */}
      <View style={styles.stdImageWrap}>
        {hasMedia && !imgFailed ? (
          <Image
            source={{ uri: post.media[0].url }}
            style={[
              StyleSheet.absoluteFill,
              shouldApplyCssFilter && Platform.OS === 'web' ? { filter: cssFilter } as any : undefined,
            ]}
            resizeMode="cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <ImgPlaceholder city={post.destination?.city} fill />
        )}
        {hasMedia && !imgFailed && post.media[0]?.kind === 'video' && (
          <View style={styles.playBadge}>
            <PlayCircle size={32} color="#FFFFFF" />
          </View>
        )}
        {hasMedia && !imgFailed && <MediaStampOverlay raw={post.media[0]?.stampOverlay} />}
      </View>
      <View style={styles.stdBody}>
        <View style={styles.stampRow}>
          <Stamp label={post.category} />
          {post.safetyNote && <Stamp label="safety" tone="signal" rotate={2} />}
          {post.rating != null && <Stamp label={'★'.repeat(post.rating)} tone="deep" rotate={2} />}
        </View>
        {post.caption && (
          <RichText
            content={post.caption}
            tags={post.tags}
            hashtagUsages={post.hashtagUsages}
            currentUserId={currentUserId ?? undefined}
            style={styles.caption}
            numberOfLines={5}
          />
        )}
        <ActionBar
          liked={post.liked}
          likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}
          renderSave={<SaveButton entityType="post" entityId={post.id} initialSaved={post.saved ?? false} />}
        />
      </View>
      {!isOwnPost && (
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} onReported={() => setIsReported(true)} />
      )}
      {isOwnPost && (
        <PostOwnerMenu
          visible={ownerMenuOpen}
          postId={post.id}
          settings={settings}
          onClose={() => setOwnerMenuOpen(false)}
          onSettingsChange={setSettings}
          onArchived={() => setOwnerMenuOpen(false)}
          onDeleted={() => router.back()}
          onEdit={() => router.push(`/post/${post.id}/edit` as any)}
        />
      )}
    </View>
  );
}

/* 3. QUESTION — no image, text-forward, Ask AI / Answer. */
function QuestionCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const [isReported, setIsReported] = useState(false);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [settings, setSettings] = useState<PostSettings>(DEFAULT_SETTINGS);
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);
  if (isReported) return null;

  return (
    <View style={[styles.card, styles.question]}>
      <View style={styles.stdHead}>
        <Byline post={post} />
        <View style={{ flex: 1 }} />
        <Locator post={post} />
        <Pressable
          hitSlop={8}
          onPress={() => isOwnPost ? setOwnerMenuOpen(true) : setReportOpen(true)}
          style={styles.moreBtn}
        >
          <MoreVertical size={16} color={color.mute} />
        </Pressable>
      </View>
      <View style={styles.qIconRow}>
        <MessageCircleQuestion size={18} color={color.deep} />
        <Text style={styles.qLabel}>Question</Text>
      </View>
      <Text style={styles.qTitle}>{post.title}</Text>
      {post.caption && (
        <RichText
          content={post.caption}
          tags={post.tags}
          hashtagUsages={post.hashtagUsages}
          currentUserId={currentUserId ?? undefined}
          style={styles.qBody}
          numberOfLines={4}
        />
      )}
      <View style={styles.qFooter}>
        <Text style={styles.qMeta}>{post.commentCount} answers</Text>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.ghostBtn} onPress={() => router.push('/(tabs)/ai')}>
          <Sparkles size={14} color={color.ink} />
          <Text style={styles.ghostBtnText}>Ask AI</Text>
        </Pressable>
        <Pressable style={styles.solidBtn} onPress={() => router.push(`/post/${post.id}`)}>
          <Text style={styles.solidBtnText}>Answer</Text>
        </Pressable>
      </View>
      {!isOwnPost && (
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} onReported={() => setIsReported(true)} />
      )}
      {isOwnPost && (
        <PostOwnerMenu
          visible={ownerMenuOpen}
          postId={post.id}
          settings={settings}
          onClose={() => setOwnerMenuOpen(false)}
          onSettingsChange={setSettings}
          onArchived={() => setOwnerMenuOpen(false)}
          onDeleted={() => router.back()}
          onEdit={() => router.push(`/post/${post.id}/edit` as any)}
        />
      )}
    </View>
  );
}

/* 4. ITINERARY — cover image top, trip meta, Add to Trip. */
function ItineraryCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const [isReported, setIsReported] = useState(false);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [settings, setSettings] = useState<PostSettings>(DEFAULT_SETTINGS);
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);
  if (isReported) return null;

  return (
    <Pressable style={[styles.card, styles.itin]} onPress={() => router.push(`/post/${post.id}`)}>
      {post.media[0] && (
        <View style={styles.itinCover}>
          <Image source={{ uri: post.media[0].url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <MediaStampOverlay raw={post.media[0]?.stampOverlay} />
        </View>
      )}
      <View style={styles.itinBody}>
        <View style={styles.itinHead}>
          <View style={styles.stampRow}>
            <Stamp label="itinerary" tone="deep" />
            <Stamp label={`${post.dayCount} days`} rotate={2} />
          </View>
          <Pressable
            hitSlop={8}
            onPress={() => isOwnPost ? setOwnerMenuOpen(true) : setReportOpen(true)}
            style={styles.moreBtn}
          >
            <MoreVertical size={16} color={color.mute} />
          </Pressable>
        </View>
        <Text style={styles.itinTitle}>{post.title}</Text>
        <View style={styles.itinMetaRow}>
          <CalendarDays size={14} color={color.mute} />
          <Text style={styles.itinMeta}>
            {post.destination.city} · {post.saveCount} saves
          </Text>
        </View>
        <Pressable style={styles.solidBtnWide} onPress={() => router.push('/(tabs)/trips')}>
          <Text style={styles.solidBtnText}>Add to Trip</Text>
        </Pressable>
      </View>
      {!isOwnPost && (
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} onReported={() => setIsReported(true)} />
      )}
      {isOwnPost && (
        <PostOwnerMenu
          visible={ownerMenuOpen}
          postId={post.id}
          settings={settings}
          onClose={() => setOwnerMenuOpen(false)}
          onSettingsChange={setSettings}
          onArchived={() => setOwnerMenuOpen(false)}
          onDeleted={() => router.back()}
          onEdit={() => router.push(`/post/${post.id}/edit` as any)}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: 14, overflow: 'hidden', ...shadow.card },

  hero: { height: HERO_HEIGHT },
  heroTop: { position: 'absolute', top: 18, left: 18 },
  heroMoreBtn: { position: 'absolute', top: 16, right: 16, padding: 6, borderRadius: 20, backgroundColor: 'rgba(17,17,15,0.35)' },
  heroBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 22, gap: 10 },
  heroTitle: { ...t.hero, fontSize: 28, lineHeight: 32, color: color.onInk },
  heroByRow: { flexDirection: 'row', alignItems: 'center' },
  heroActions: { marginTop: 4 },

  standard: {},
  stdHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  stdImageWrap: { width: '100%', aspectRatio: 4 / 5, backgroundColor: color.deep, overflow: 'hidden' },
  playBadge: { position: 'absolute', top: '50%', left: '50%', transform: [{ translateX: -20 }, { translateY: -20 }] },
  stdBody: { padding: 16, gap: 10 },
  moreBtn: { padding: 6 },

  imgPlaceholder: { alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: color.deep },
  imgPlaceholderCity: { fontFamily: 'Courier', fontSize: 11, color: color.onInk, fontWeight: '700', letterSpacing: 1.5 },

  question: { padding: space.lg, gap: space.md },
  qIconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qLabel: { ...t.stamp, fontFamily: 'Courier', color: color.deep },
  qTitle: { ...t.heading, color: color.ink },
  qBody: { ...t.body, color: color.mute },
  qFooter: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  qMeta: { ...t.small, color: color.faint },

  itin: {},
  itinCover: { width: '100%', height: 200, backgroundColor: color.haze },
  itinBody: { padding: space.lg, gap: space.sm },
  itinHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itinTitle: { ...t.title, color: color.ink },
  itinMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itinMeta: { ...t.small, color: color.mute },

  stampRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  caption: { ...t.body, color: color.ink, lineHeight: 22 },

  locator: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  locatorText: { ...t.stamp, fontFamily: 'Courier', fontSize: 11 },
  byline: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  bylineName: { ...t.bodyStrong, fontSize: 14, letterSpacing: -0.1 },

  ghostBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  ghostBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  solidBtn: {
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderRadius: radius.pill, backgroundColor: color.ink,
  },
  solidBtnWide: {
    marginTop: space.xs, paddingVertical: space.md,
    borderRadius: radius.pill, backgroundColor: color.ink, alignItems: 'center',
  },
  solidBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
});
