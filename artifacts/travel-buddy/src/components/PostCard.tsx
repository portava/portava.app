import React, { useState } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, Platform,
  Modal, Alert, ActivityIndicator, ScrollView, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { getMediaFilter, buildCssFilter } from '../lib/media/filters';
import { MapPin, Sparkles, MessageCircleQuestion, CalendarDays, PlayCircle, MoreVertical, X } from 'lucide-react-native';
import type { Post } from '../types/models';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import { Stamp, Avatar, Scrim, needsContrastFallback } from './ui';
import { ActionBar } from './ActionBar';
import { RichText } from './RichText';
import { useSession } from '../context/SessionContext';
import { reportContent, type ReasonCode } from '../services/reports';

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

// ── Report reasons ─────────────────────────────────────────────────────────────

const REPORT_POST_REASONS: { code: ReasonCode; label: string }[] = [
  { code: 'spam',           label: 'Spam or misleading' },
  { code: 'harassment',     label: 'Harassment or bullying' },
  { code: 'hate_speech',    label: 'Hate speech' },
  { code: 'violence',       label: 'Violent or dangerous content' },
  { code: 'nudity',         label: 'Nudity or sexual content' },
  { code: 'misinformation', label: 'Misinformation' },
  { code: 'other',          label: 'Something else' },
];

// ── Report sheet ───────────────────────────────────────────────────────────────

function ReportPostSheet({
  postId,
  visible,
  onClose,
}: {
  postId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  function reset() {
    setReason(null);
    setDetail('');
    setSubmitting(false);
    setDone(false);
  }

  function handleClose() {
    onClose();
    reset();
  }

  async function submit() {
    if (!reason) return;
    setSubmitting(true);
    const res = await reportContent({
      target_type: 'post',
      target_id: postId,
      reason_code: reason,
      reason_detail: detail.trim() || undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      setDone(true);
      setTimeout(() => handleClose(), 2500);
    } else {
      Alert.alert('Error', res.error ?? 'Could not submit report');
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={rps.overlay}>
        <Pressable style={{ flex: 1 }} onPress={handleClose} />
        <View style={rps.sheet}>
          <View style={rps.handle} />
          {done ? (
            <View style={rps.doneWrap}>
              <Text style={rps.doneIcon}>✓</Text>
              <Text style={rps.doneTitle}>Report submitted</Text>
              <Text style={rps.doneSub}>Thank you — our team will review this shortly.</Text>
            </View>
          ) : (
            <>
              <View style={rps.header}>
                <Text style={rps.title}>Report post</Text>
                <Pressable onPress={handleClose} hitSlop={8}>
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rps.sub}>Why are you reporting this post?</Text>
              <ScrollView showsVerticalScrollIndicator={false}>
                {REPORT_POST_REASONS.map((r) => (
                  <Pressable
                    key={r.code}
                    style={[rps.reasonRow, reason === r.code && rps.reasonRowSelected]}
                    onPress={() => setReason(r.code)}
                  >
                    <Text style={[rps.reasonLabel, reason === r.code && rps.reasonLabelSelected]}>
                      {r.label}
                    </Text>
                    {reason === r.code && <Text style={rps.check}>✓</Text>}
                  </Pressable>
                ))}
                {reason === 'other' && (
                  <TextInput
                    style={rps.detailInput}
                    placeholder="Tell us more (optional)"
                    placeholderTextColor={color.mute}
                    value={detail}
                    onChangeText={setDetail}
                    multiline
                    maxLength={500}
                  />
                )}
              </ScrollView>
              <Pressable
                style={[rps.submitBtn, (!reason || submitting) && rps.submitBtnDisabled]}
                onPress={submit}
                disabled={!reason || submitting}
              >
                {submitting
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={rps.submitLabel}>Submit report</Text>}
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const rps = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: space.lg, paddingBottom: 34, paddingTop: space.sm, maxHeight: '80%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15 },
  sub: { ...t.small, color: color.mute, marginBottom: space.md },
  reasonRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 11, paddingHorizontal: space.sm,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginBottom: 6,
  },
  reasonRowSelected: { borderColor: color.signal, backgroundColor: `${color.signal}08` },
  reasonLabel: { ...t.body, color: color.ink },
  reasonLabelSelected: { color: color.signal, fontWeight: '700' },
  check: { color: color.signal, fontWeight: '700', fontSize: 14 },
  detailInput: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink, minHeight: 80, marginBottom: space.sm,
  },
  submitBtn: {
    marginTop: space.md, backgroundColor: color.signal,
    borderRadius: radius.md, paddingVertical: 13, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.45 },
  submitLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  doneWrap: { alignItems: 'center', paddingVertical: space.xl },
  doneIcon: { fontSize: 40, marginBottom: space.sm },
  doneTitle: { ...t.title, color: color.ink, fontWeight: '700', marginBottom: 4 },
  doneSub: { ...t.body, color: color.mute, textAlign: 'center' },
});

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

/* 1. HERO — full-bleed image, scrim, editorial title overlaid. */
function HeroCard({ post }: { post: Post }) {
  return (
    <Pressable style={[styles.card, styles.hero]} onPress={() => router.push(`/post/${post.id}`)}>
      <Image source={{ uri: post.media[0].url }} style={StyleSheet.absoluteFill} />
      <Scrim />
      <View style={styles.heroTop}>
        <Stamp label={post.category} tone="onInk" />
      </View>
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
            liked={post.liked} saved={post.saved}
            likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}
          />
        </View>
      </View>
    </Pressable>
  );
}

/* 2. STANDARD — image first (if any), caption below. Cleaner, readable. */
function StandardCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const hasMedia = post.media.length > 0;
  const isVideo = post.media[0]?.kind === 'video' || post.mediaType?.startsWith('video/');
  const hasFilterId = post.filterId && post.filterId !== 'original';
  const shouldApplyCssFilter = isVideo && hasFilterId;
  const cssFilter = shouldApplyCssFilter
    ? buildCssFilter(getMediaFilter(post.filterId), post.filterIntensity ?? 100)
    : 'none';
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);

  return (
    <View style={[styles.card, styles.standard]}>
      <View style={styles.stdHead}>
        <Byline post={post} />
        <View style={{ flex: 1 }} />
        <Locator post={post} />
        {!isOwnPost && (
          <Pressable hitSlop={8} onPress={() => setReportOpen(true)} style={styles.moreBtn}>
            <MoreVertical size={16} color={color.mute} />
          </Pressable>
        )}
      </View>
      {hasMedia && (
        <View>
          <Image
            source={{ uri: post.media[0].url }}
            style={[
              styles.stdImage,
              shouldApplyCssFilter && Platform.OS === 'web' ? { filter: cssFilter } as any : undefined,
            ]}
          />
          {post.media[0]?.kind === 'video' && (
            <View style={styles.playBadge}>
              <PlayCircle size={32} color="#FFFFFF" />
            </View>
          )}
        </View>
      )}
      <View style={styles.stdBody}>
        <View style={styles.stampRow}>
          <Stamp label={post.category} />
          {post.safetyNote && <Stamp label="safety" tone="signal" rotate={2} />}
          {post.rating != null && <Stamp label={'★'.repeat(post.rating)} tone="deep" rotate={2} />}
        </View>
        {post.caption && <RichText content={post.caption} tags={post.tags} hashtagUsages={post.hashtagUsages} currentUserId={currentUserId ?? undefined} style={styles.caption} numberOfLines={5} />}
        <ActionBar
          liked={post.liked} saved={post.saved}
          likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}
        />
      </View>
      {!isOwnPost && (
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} />
      )}
    </View>
  );
}

/* 3. QUESTION — no image, text-forward, Ask AI / Answer. */
function QuestionCard({ post }: { post: Post }) {
  const { userId: currentUserId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const isOwnPost = !!(currentUserId && post.author.id === currentUserId);

  return (
    <View style={[styles.card, styles.question]}>
      <View style={styles.stdHead}>
        <Byline post={post} />
        <View style={{ flex: 1 }} />
        <Locator post={post} />
        {!isOwnPost && (
          <Pressable hitSlop={8} onPress={() => setReportOpen(true)} style={styles.moreBtn}>
            <MoreVertical size={16} color={color.mute} />
          </Pressable>
        )}
      </View>
      <View style={styles.qIconRow}>
        <MessageCircleQuestion size={18} color={color.deep} />
        <Text style={styles.qLabel}>Question</Text>
      </View>
      <Text style={styles.qTitle}>{post.title}</Text>
      {post.caption && <RichText content={post.caption} tags={post.tags} hashtagUsages={post.hashtagUsages} currentUserId={currentUserId ?? undefined} style={styles.qBody} numberOfLines={4} />}
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
        <ReportPostSheet postId={post.id} visible={reportOpen} onClose={() => setReportOpen(false)} />
      )}
    </View>
  );
}

/* 4. ITINERARY — cover image top, trip meta, Add to Trip. */
function ItineraryCard({ post }: { post: Post }) {
  return (
    <Pressable style={[styles.card, styles.itin]} onPress={() => router.push(`/post/${post.id}`)}>
      {post.media[0] && <Image source={{ uri: post.media[0].url }} style={styles.itinCover} />}
      <View style={styles.itinBody}>
        <View style={styles.stampRow}>
          <Stamp label="itinerary" tone="deep" />
          <Stamp label={`${post.dayCount} days`} rotate={2} />
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card },

  hero: { height: 460 },
  heroTop: { position: 'absolute', top: space.lg, left: space.lg },
  heroBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, gap: space.sm },
  heroTitle: { ...t.hero, color: color.onInk },
  heroByRow: { flexDirection: 'row', alignItems: 'center' },
  heroActions: { marginTop: space.sm },

  standard: {},
  stdHead: { flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.sm },
  stdImage: { width: '100%', aspectRatio: 4 / 3, backgroundColor: color.haze },
  playBadge: { position: 'absolute', top: '50%', left: '50%', transform: [{ translateX: -16 }, { translateY: -16 }] },
  stdBody: { padding: space.lg, gap: space.md },
  moreBtn: { padding: 4 },

  question: { padding: space.lg, gap: space.md },
  qIconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qLabel: { ...t.stamp, fontFamily: 'Courier', color: color.deep },
  qTitle: { ...t.heading, color: color.ink },
  qBody: { ...t.body, color: color.mute },
  qFooter: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  qMeta: { ...t.small, color: color.faint },

  itin: {},
  itinCover: { width: '100%', height: 180, backgroundColor: color.haze },
  itinBody: { padding: space.lg, gap: space.sm },
  itinTitle: { ...t.title, color: color.ink },
  itinMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itinMeta: { ...t.small, color: color.mute },

  stampRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  caption: { ...t.body, color: color.ink },

  locator: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  locatorText: { ...t.stamp, fontFamily: 'Courier' },
  byline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bylineName: { ...t.bodyStrong },

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
