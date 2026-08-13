import React, { useState, useMemo } from 'react';
import {
  View, Text, Pressable, Modal, TextInput, ActivityIndicator,
  Alert, StyleSheet, useWindowDimensions,
} from 'react-native';
import { CachedImage, withStorageParams } from './CachedImage.tsx';
import { useHydratedMedia } from '../services/mediaUrl.ts';
import { router } from 'expo-router';
import { MapPin, Pin, MoreHorizontal, Plus, Clock, AlertCircle, Layers, ChevronDown, Lock, Ban, EyeOff, Image as ImageIcon } from 'lucide-react-native';
import type { PassportPostcard } from '../types/models.ts';
import { MediaStampOverlay } from './StampOverlayBadge.tsx';
import { MediaCard } from './cards/MediaCard.tsx';
import { MediaGridSkeleton } from './loading/MediaGridSkeleton.tsx';
import { EmptyState } from './ui/EmptyState.tsx';
import type { usePostcardActions } from '../hooks/usePostcardActions.ts';
import type { PostcardsSentinel } from '../services/profile.ts';
import { color, space, radius, type as t, avatar, icon } from '../theme/tokens.ts';

/* ────────────────────────────────────────────────────────── */
/* Sentinel state views (private / blocked / unavailable)     */
/* ────────────────────────────────────────────────────────── */
const SENTINEL_COPY: Record<PostcardsSentinel, { Icon: React.ComponentType<any>; title: string; body: string }> = {
  private: {
    Icon: Lock,
    title: 'Private passport',
    body: 'This passport is private. Follow this traveler to see their postcards.',
  },
  blocked: {
    Icon: Ban,
    title: 'Content unavailable',
    body: 'Postcard content is not available.',
  },
  unavailable: {
    Icon: EyeOff,
    title: 'Account unavailable',
    body: 'This account is no longer available.',
  },
};

function PostcardSentinelView({ kind }: { kind: PostcardsSentinel }) {
  const { Icon, title, body } = SENTINEL_COPY[kind];
  return (
    <View style={sv.root} accessibilityRole="text" accessibilityLabel={title}>
      <View style={sv.iconWrap}>
        <Icon size={28} color={color.mute} strokeWidth={1.6} />
      </View>
      <Text style={sv.title}>{title}</Text>
      <Text style={sv.body}>{body}</Text>
    </View>
  );
}

const sv = StyleSheet.create({
  root: {
    paddingVertical: space.xxxl,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    gap: space.sm,
  },
  iconWrap: {
    width: avatar.s56, height: avatar.s56, borderRadius: avatar.s56 / 2,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: { fontSize: 16, fontWeight: '700', color: color.ink, textAlign: 'center' },
  body:  { fontSize: 14, color: color.mute, textAlign: 'center', lineHeight: 20 },
});

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

type Actions = ReturnType<typeof usePostcardActions>;

/* ────────────────────────────────────────────────────────── */
/* Action menu bottom sheet                                   */
/* ────────────────────────────────────────────────────────── */
function CardMenu({
  card,
  visible,
  onClose,
  actions,
}: {
  card: PassportPostcard;
  visible: boolean;
  onClose: () => void;
  actions: Actions;
}) {
  const [noteMode, setNoteMode] = useState(false);
  const [noteText, setNoteText] = useState(card.note ?? '');
  const isPinned = Boolean(card.pinnedAt);
  const isDeleting = actions.busy === card.id;

  const doPin = async () => { onClose(); await (isPinned ? actions.unpin(card.id) : actions.pin(card.id)); };
  const doSaveNote = async () => {
    await actions.editNote(card.id, noteText.trim() || null);
    setNoteMode(false);
    onClose();
  };
  const doClearNote = async () => { await actions.clearNote(card.id); setNoteMode(false); onClose(); };
  const doRemove = () => {
    onClose();
    Alert.alert('Remove from Passport', 'This hides the postcard from your Passport but keeps the original post.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => actions.remove(card.id) },
    ]);
  };
  const doDelete = () => {
    onClose();
    Alert.alert('Delete post', 'This permanently deletes the original post and removes it from your Passport.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => actions.deletePostAndCard(card.id, card.postId) },
    ]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={mn.overlay} onPress={onClose} />
      <View style={mn.sheet}>
        {noteMode ? (
          <>
            <Text style={mn.sheetTitle}>Edit note</Text>
            <TextInput
              style={mn.noteInput}
              value={noteText}
              onChangeText={setNoteText}
              placeholder="Add a note to this postcard…"
              placeholderTextColor={color.faint}
              multiline
              maxLength={500}
              autoFocus
            />
            <View style={mn.noteActions}>
              <Pressable style={mn.noteBtn} onPress={() => setNoteMode(false)}><Text style={mn.noteBtnText}>Cancel</Text></Pressable>
              <Pressable style={[mn.noteBtn, mn.noteSave]} onPress={doSaveNote}><Text style={[mn.noteBtnText, { color: color.onInk }]}>Save</Text></Pressable>
            </View>
            {card.note && (
              <Pressable style={mn.clearNote} onPress={doClearNote}><Text style={mn.clearNoteText}>Clear note</Text></Pressable>
            )}
          </>
        ) : (
          <>
            <View style={mn.handle} />
            <Text style={mn.sheetTitle}>Postcard options</Text>
            {isDeleting && <ActivityIndicator style={{ marginVertical: space.sm }} color={color.signal} />}
            <Pressable style={mn.item} onPress={() => setNoteMode(true)}>
              <Text style={mn.itemText}>{card.note ? 'Edit note' : 'Add note'}</Text>
            </Pressable>
            {card.note ? (
              <Pressable style={mn.item} onPress={doClearNote}>
                <Text style={mn.itemText}>Clear note</Text>
              </Pressable>
            ) : null}
            <Pressable style={mn.item} onPress={doPin}>
              <Text style={mn.itemText}>{isPinned ? 'Unpin postcard' : 'Pin to top'}</Text>
            </Pressable>
            <View style={mn.divider} />
            <Pressable style={mn.item} onPress={doRemove}>
              <Text style={[mn.itemText, mn.danger]}>Remove from Passport</Text>
            </Pressable>
            <Pressable style={mn.item} onPress={doDelete}>
              <Text style={[mn.itemText, mn.danger]}>Delete post</Text>
            </Pressable>
            <Pressable style={[mn.item, mn.cancelItem]} onPress={onClose}>
              <Text style={mn.itemText}>Cancel</Text>
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────── */
/* Single postcard tile — uses MediaCard as the base renderer  */
/* with passport-specific overlays layered on top.            */
/* ────────────────────────────────────────────────────────── */
function PostcardTile({
  card,
  isOwner,
  actions,
  width,
}: {
  card: PassportPostcard;
  isOwner: boolean;
  actions?: Actions;
  width: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPinned = Boolean(card.pinnedAt);

  // media — prefer thumbnail_url from structured media[], fall back to legacy mediaUrl
  const allMedia = card.media ?? [];
  const firstReady = allMedia.find((m) => m.processing_status === 'ready');
  const firstAny = allMedia[0];
  const displayItem = firstReady ?? firstAny;
  // Preference order per item: thumbnail (400px, smallest that still reads at
  // this size) → 0208 feed variant (~1500px) → original. feed_url is NULL for
  // pre-0208 uploads, videos and failed derives, so it is skipped rather than
  // requested-and-404'd; the chain below already degrades to the original.
  const displayUri =
    firstReady?.thumbnail_url ?? firstReady?.feed_url ?? firstReady?.url ??
    firstAny?.thumbnail_url ?? firstAny?.feed_url ?? firstAny?.url ??
    card.mediaUrl;
  const isVideo = (firstReady ?? firstAny)?.media_type === 'video' || card.hasVideo;
  const hasPending = allMedia.length > 0 && !firstReady && allMedia.some((m) => m.processing_status === 'pending');
  const hasFailed = allMedia.length > 0 && !firstReady && allMedia.every((m) => m.processing_status === 'failed');
  const isCarousel = allMedia.length > 1;

  // Route post-media URLs through the signed-URL hydration layer.  Passing
  // transform here causes the server to call createSignedUrl with a transform
  // block, producing a /render/image/sign/ URL that Supabase resizes to 400 px
  // wide at delivery time.  This is the only resize path that works for private
  // buckets — withStorageParams on an already-signed URL has no effect.
  const { resolved: mediaResolved } = useHydratedMedia(displayUri ? [displayUri] : [], { width: 400, quality: 80 });
  const hydratedUri = (displayUri && mediaResolved[displayUri]) ?? displayUri;
  const hydratedWithParams = hydratedUri
    ? withStorageParams(hydratedUri, 'width=400&quality=80')
    : null;

  const location = [card.locationCity ?? card.locationName, card.locationCountry]
    .filter(Boolean).join(', ');

  // Suppress MediaCard's built-in badge when we're showing our own state badge
  const hideBadge = hasPending || hasFailed;

  return (
    <View style={{ width }}>
      <MediaCard
        id={card.id}
        thumbnailUrl={hydratedWithParams}
        mediaType={isVideo ? 'video' : 'image'}
        onPress={() => card.postId && router.push(`/post/${card.postId}` as any)}
        onLongPress={isOwner && actions ? () => setMenuOpen(true) : undefined}
        hideBadge={hideBadge}
      />

      {/* Absolute overlays — stamp, location, pin, status badges */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* Passport-stamp overlay — parse-gated; malformed data renders nothing */}
        {displayItem ? <MediaStampOverlay raw={displayItem.stamp_overlay} /> : null}

        {/* Location chip */}
        {location ? (
          <View style={pc.locChip}>
            <Text style={pc.locChipText} numberOfLines={1}>{location}</Text>
          </View>
        ) : null}

        {/* Pinned badge */}
        {isPinned && (
          <View style={[pc.cornerBadge, isOwner && actions ? pc.pinBadge : pc.menuBtn]}>
            <Pin size={12} color="#fff" strokeWidth={2.2} />
          </View>
        )}

        {/* Owner menu button */}
        {isOwner && actions && (
          <Pressable
            style={[pc.cornerBadge, pc.menuBtn]}
            onPress={() => setMenuOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Postcard options"
          >
            <MoreHorizontal size={14} color="#fff" />
          </Pressable>
        )}

        {/* Processing / failed / carousel badges */}
        {hasPending ? (
          <View style={pc.stateBadge}>
            <Clock size={12} color="#fff" />
            <Text style={pc.stateBadgeText}>Processing…</Text>
          </View>
        ) : hasFailed ? (
          <View style={[pc.stateBadge, pc.stateBadgeFailed]}>
            <AlertCircle size={12} color="#fff" />
            <Text style={pc.stateBadgeText}>Failed</Text>
          </View>
        ) : isCarousel ? (
          <View style={pc.typeBadge}>
            <Layers size={13} color="#fff" strokeWidth={2.2} />
          </View>
        ) : null}

        {/* Owner-only visibility chip (non-public; yields to processing badges) */}
        {isOwner && card.visibility !== 'public' && !hasPending && !hasFailed && (
          <View style={pc.visChip}>
            <Text style={pc.visChipText}>{card.visibility === 'trip_only' ? 'Trip' : 'Private'}</Text>
          </View>
        )}
      </View>

      {isOwner && actions && (
        <CardMenu
          card={card}
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          actions={actions}
        />
      )}
    </View>
  );
}

/* ────────────────────────────────────────────────────────── */
/* PostcardsTab                                               */
/* ────────────────────────────────────────────────────────── */
const PAGE_SIZE = 16;

type SortKey = 'newest' | 'oldest';

export function PostcardsTab({
  postcards,
  isOwner,
  actions,
  onAddPostcard,
  sentinel,
  loading,
}: {
  postcards: PassportPostcard[];
  isOwner: boolean;
  actions?: Actions;
  onAddPostcard?: () => void;
  /** Sentinel returned by the postcards endpoint — renders a graceful state instead of the grid. */
  sentinel?: PostcardsSentinel;
  /** When true, renders a MediaGridSkeleton placeholder instead of the grid. */
  loading?: boolean;
}) {
  const { width } = useWindowDimensions();
  const [sort, setSort] = useState<SortKey>('newest');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const columns = width >= 600 ? 3 : 2;
  const gap = width < 350 ? 6 : 8;
  const pad = space.md;
  const tileW = (Math.min(width, 760) - pad * 2 - gap * (columns - 1)) / columns;

  const sorted = useMemo(() => {
    const list = postcards.slice();
    // pinned first, then by date
    list.sort((a, b) => {
      const pin = (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0);
      if (pin !== 0) return pin;
      const cmp = (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      return sort === 'newest' ? cmp : -cmp;
    });
    return list;
  }, [postcards, sort]);

  // Sentinel states take precedence over an empty (or populated) postcard list.
  if (sentinel) return <PostcardSentinelView kind={sentinel} />;

  if (loading) {
    return <MediaGridSkeleton columns={columns} count={columns * 3} />;
  }

  if (postcards.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title={isOwner ? 'Your adventure starts here' : 'No postcards yet'}
        description={
          isOwner
            ? 'Every journey has a first moment. Share a place to start your story.'
            : "This traveler hasn't shared a public postcard yet."
        }
        primaryAction={
          isOwner && onAddPostcard
            ? { label: 'Post your first postcard', onPress: onAddPostcard }
            : undefined
        }
      />
    );
  }

  const shown = sorted.slice(0, visibleCount);
  const hasMore = sorted.length > visibleCount;

  return (
    <View style={pc.listWrap}>
      {/* toolbar: add + sort */}
      <View style={pc.toolbar}>
        {isOwner && onAddPostcard ? (
          <Pressable style={pc.addBtn} onPress={onAddPostcard}>
            <Plus size={16} color={color.onInk} />
            <Text style={pc.addBtnText}>Add Postcard</Text>
          </Pressable>
        ) : <View />}
        <Pressable
          style={pc.sortBtn}
          onPress={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          accessibilityRole="button"
          accessibilityLabel={`Sorted by ${sort}. Tap to change`}
        >
          <Text style={pc.sortText}>{sort === 'newest' ? 'Newest' : 'Oldest'}</Text>
          <ChevronDown size={14} color={color.mute} />
        </Pressable>
      </View>

      {/* photo grid */}
      <View style={[pc.grid, { paddingHorizontal: pad, gap }]}>
        {shown.map((card) => (
          <PostcardTile
            key={card.id}
            card={card}
            isOwner={isOwner}
            actions={actions}
            width={tileW}
          />
        ))}
      </View>

      {hasMore && (
        <Pressable
          style={pc.moreBtn}
          onPress={() => setVisibleCount((c) => c + PAGE_SIZE)}
          accessibilityRole="button"
          accessibilityLabel="Show more postcards"
        >
          <Text style={pc.moreText}>Show more</Text>
        </Pressable>
      )}
    </View>
  );
}

const pc = StyleSheet.create({
  listWrap: {},
  toolbar: {
    minHeight: 48, paddingHorizontal: space.lg, paddingTop: space.sm,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  addBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  sortBtn: {
    minHeight: 32, paddingHorizontal: 10, borderRadius: radius.sm,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  sortText: { ...t.small, fontSize: 12.5, fontWeight: '600', color: color.mute },

  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: space.sm },

  locChip: {
    position: 'absolute', top: space.sm, left: space.sm, maxWidth: '78%',
    minHeight: 24, paddingHorizontal: space.sm, borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center',
  },
  locChipText: { fontSize: 11, fontWeight: '600', color: '#fff' },
  cornerBadge: {
    position: 'absolute', width: icon.s26, height: icon.s26, borderRadius: icon.s26 / 2,
    backgroundColor: 'rgba(0,0,0,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  pinBadge: { top: space.sm, right: space.xl + space.sm },
  menuBtn: { top: space.sm, right: space.sm },
  typeBadge: {
    position: 'absolute', bottom: space.sm, right: space.sm,
    width: icon.s26, height: icon.s26, borderRadius: icon.s26 / 2,
    backgroundColor: 'rgba(0,0,0,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  stateBadge: {
    position: 'absolute', bottom: space.sm, left: space.sm,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    paddingHorizontal: space.sm, paddingVertical: 4,
  },
  stateBadgeFailed: { backgroundColor: 'rgba(200,30,30,0.75)' },
  stateBadgeText: { ...t.small, color: '#fff', fontSize: 10, fontWeight: '600' },
  visChip: {
    position: 'absolute', bottom: space.sm, left: space.sm,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  visChipText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  moreBtn: {
    marginTop: space.md, marginHorizontal: space.lg, minHeight: 38, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  moreText: { ...t.small, fontSize: 13, fontWeight: '600', color: color.mute },
});

const mn = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: space.lg, paddingBottom: 40, paddingTop: space.md,
    minHeight: 200,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  sheetTitle: { ...t.heading, color: color.ink, marginBottom: space.md, textAlign: 'center' },
  item: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.haze },
  itemText: { ...t.body, color: color.ink, textAlign: 'center', fontWeight: '600' },
  danger: { color: '#D93025' },
  cancelItem: { borderBottomWidth: 0, marginTop: space.sm },
  divider: { height: 1, backgroundColor: color.haze, marginVertical: space.xs },
  noteInput: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink, minHeight: 100,
    textAlignVertical: 'top', marginBottom: space.md,
  },
  noteActions: { flexDirection: 'row', gap: space.md, justifyContent: 'flex-end' },
  noteBtn: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  noteSave: { backgroundColor: color.signal, borderColor: color.signal },
  noteBtnText: { ...t.bodyStrong, color: color.ink },
  clearNote: { marginTop: space.md, alignItems: 'center' },
  clearNoteText: { ...t.small, color: color.mute, textDecorationLine: 'underline' },
});
