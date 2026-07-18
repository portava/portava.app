import React, { useState, useMemo } from 'react';
import {
  View, Text, Image, Pressable, Modal, TextInput, ActivityIndicator,
  Alert, StyleSheet, ScrollView, useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin, Pin, MoreHorizontal, Plus, PlayCircle, Clock, AlertCircle, Layers, ChevronDown } from 'lucide-react-native';
import type { PassportPostcard } from '../types/models.ts';
import { MediaStampOverlay } from './StampOverlayBadge.tsx';
import { PostcardEmptyState } from './PostcardEmptyState.tsx';
import type { usePostcardActions } from '../hooks/usePostcardActions.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

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
/* Single postcard tile (photo-grid presentation)              */
/*                                                             */
/* Tap opens the existing post viewer (/post/[id]) where       */
/* caption, note, GPS-verified badge, likes, and comments      */
/* live. Owners open the CardMenu sheet via the corner button  */
/* or a long-press on the tile.                                */
/* ────────────────────────────────────────────────────────── */
function PostcardTile({
  card,
  isOwner,
  actions,
  width,
  height,
}: {
  card: PassportPostcard;
  isOwner: boolean;
  actions?: Actions;
  width: number;
  height: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPinned = Boolean(card.pinnedAt);

  // media — prefer thumbnail_url from structured media[], fall back to legacy mediaUrl
  const allMedia = card.media ?? [];
  const firstReady = allMedia.find((m) => m.processing_status === 'ready');
  const firstAny = allMedia[0];
  const displayItem = firstReady ?? firstAny;
  const displayUri = firstReady?.thumbnail_url ?? firstReady?.url ?? firstAny?.thumbnail_url ?? firstAny?.url ?? card.mediaUrl;
  const isVideo = (firstReady ?? firstAny)?.media_type === 'video' || card.hasVideo;
  const hasPending = allMedia.length > 0 && !firstReady && allMedia.some((m) => m.processing_status === 'pending');
  const hasFailed = allMedia.length > 0 && !firstReady && allMedia.every((m) => m.processing_status === 'failed');
  const isCarousel = allMedia.length > 1;

  const location = [card.locationCity ?? card.locationName, card.locationCountry]
    .filter(Boolean).join(', ');

  return (
    <Pressable
      style={[pc.tile, { width, height }]}
      onPress={() => card.postId && router.push(`/post/${card.postId}` as any)}
      onLongPress={isOwner && actions ? () => setMenuOpen(true) : undefined}
      accessibilityRole="button"
      accessibilityLabel={`Postcard${location ? ` from ${location}` : ''}`}
    >
      {displayUri ? (
        <>
          <Image source={{ uri: displayUri }} style={pc.media} resizeMode="cover" />
          {/* Passport-stamp overlay — parse-gated; malformed data renders nothing */}
          {displayItem ? <MediaStampOverlay raw={displayItem.stamp_overlay} /> : null}
        </>
      ) : (
        <View style={[pc.media, pc.noMedia]}>
          {hasPending ? (
            <Clock size={20} color={color.mute} />
          ) : hasFailed ? (
            <AlertCircle size={20} color={color.mute} />
          ) : (
            <MapPin size={20} color={color.mute} strokeWidth={1.6} />
          )}
        </View>
      )}

      {/* location chip */}
      {location ? (
        <View style={pc.locChip}>
          <Text style={pc.locChipText} numberOfLines={1}>{location}</Text>
        </View>
      ) : null}

      {/* pinned badge — sits beside the menu button when the owner is viewing */}
      {isPinned && (
        <View style={[pc.cornerBadge, isOwner && actions ? pc.pinBadge : pc.menuBtn]}>
          <Pin size={12} color="#fff" strokeWidth={2.2} />
        </View>
      )}

      {/* owner menu button */}
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

      {/* media-type / processing badges */}
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
      ) : isVideo ? (
        <View style={pc.typeBadge}>
          <PlayCircle size={13} color="#fff" strokeWidth={2.2} />
        </View>
      ) : isCarousel ? (
        <View style={pc.typeBadge}>
          <Layers size={13} color="#fff" strokeWidth={2.2} />
        </View>
      ) : null}

      {/* owner-only visibility chip (non-public only; yields to processing badges) */}
      {isOwner && card.visibility !== 'public' && !hasPending && !hasFailed && (
        <View style={pc.visChip}>
          <Text style={pc.visChipText}>{card.visibility === 'trip_only' ? 'Trip' : 'Private'}</Text>
        </View>
      )}

      {isOwner && actions && (
        <CardMenu
          card={card}
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          actions={actions}
        />
      )}
    </Pressable>
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
}: {
  postcards: PassportPostcard[];
  isOwner: boolean;
  actions?: Actions;
  onAddPostcard?: () => void;
}) {
  const { width } = useWindowDimensions();
  const [sort, setSort] = useState<SortKey>('newest');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const columns = width >= 600 ? 3 : 2;
  const gap = width < 350 ? 6 : 8;
  const pad = space.md;
  const tileW = (Math.min(width, 760) - pad * 2 - gap * (columns - 1)) / columns;
  const tileH = tileW * 1.25; // 4:5 portrait

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

  if (postcards.length === 0) {
    return (
      <PostcardEmptyState
        isOwner={isOwner}
        onAddPostcard={onAddPostcard}
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
            height={tileH}
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
  tile: {
    borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.haze,
  },
  media: { width: '100%', height: '100%', backgroundColor: color.haze },
  noMedia: { alignItems: 'center', justifyContent: 'center' },

  locChip: {
    position: 'absolute', top: 6, left: 6, maxWidth: '78%',
    minHeight: 24, paddingHorizontal: 8, borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center',
  },
  locChipText: { fontSize: 11, fontWeight: '600', color: '#fff' },
  cornerBadge: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  pinBadge: { top: 6, right: 38 },
  menuBtn: { top: 6, right: 6 },
  typeBadge: {
    position: 'absolute', bottom: 6, right: 6, width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  stateBadge: {
    position: 'absolute', bottom: 6, left: 6,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  stateBadgeFailed: { backgroundColor: 'rgba(200,30,30,0.75)' },
  stateBadgeText: { ...t.small, color: '#fff', fontSize: 10, fontWeight: '600' },
  visChip: {
    position: 'absolute', bottom: 6, left: 6,
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
