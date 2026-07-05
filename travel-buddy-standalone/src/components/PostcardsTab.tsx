import React, { useState } from 'react';
import {
  View, Text, Image, Pressable, Modal, TextInput, ActivityIndicator,
  Alert, StyleSheet, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin, Pin, MoreHorizontal, ShieldCheck, X, Plus, PlayCircle } from 'lucide-react-native';
import type { PassportPostcard } from '../types/models';
import type { usePostcardActions } from '../hooks/usePostcardActions';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

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
/* Single postcard card                                        */
/* ────────────────────────────────────────────────────────── */
function PostcardCard({
  card,
  isOwner,
  actions,
}: {
  card: PassportPostcard;
  isOwner: boolean;
  actions?: Actions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPinned = Boolean(card.pinnedAt);
  const isVerified = card.locationVerified && card.stampEligible;
  const date = card.createdAt
    ? new Date(card.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <View style={pc.card}>
      {/* media */}
      {card.mediaUrl ? (
        <Pressable onPress={() => card.postId && router.push(`/post/${card.postId}` as any)}>
          <Image
            source={{ uri: card.mediaUrl }}
            style={pc.media}
            defaultSource={undefined}
          />
          {card.hasVideo && (
            <View style={pc.videoPlayOverlay}>
              <PlayCircle size={36} color="#fff" />
            </View>
          )}
        </Pressable>
      ) : (
        <View style={[pc.media, pc.noMedia]}>
          <Text style={pc.noMediaText}>📷</Text>
        </View>
      )}

      {/* overlays */}
      {isPinned && (
        <View style={pc.pinBadge}>
          <Pin size={11} color={color.signal} fill={color.signal} />
          <Text style={pc.pinText}>PINNED</Text>
        </View>
      )}
      {isOwner && actions && (
        <Pressable style={pc.menuBtn} onPress={() => setMenuOpen(true)} hitSlop={8}>
          <MoreHorizontal size={18} color={color.ink} />
        </Pressable>
      )}

      {/* body */}
      <View style={pc.body}>
        <View style={pc.metaRow}>
          {(card.locationCity || card.locationName) && (
            <View style={pc.locRow}>
              <MapPin size={11} color={color.deep} />
              <Text style={pc.locText} numberOfLines={1}>
                {card.locationCity ?? card.locationName}
                {card.locationCountry ? `, ${card.locationCountry}` : ''}
              </Text>
            </View>
          )}
          {date ? <Text style={pc.dateText}>{date}</Text> : null}
        </View>

        {(card.caption || card.note) ? (
          <Text style={pc.caption} numberOfLines={3}>
            {card.note ? `"${card.note}"` : card.caption}
          </Text>
        ) : null}

        <View style={pc.badgeRow}>
          {isVerified ? (
            <View style={pc.verifiedBadge}>
              <ShieldCheck size={11} color={color.success} />
              <Text style={pc.verifiedText}>GPS Verified</Text>
            </View>
          ) : (
            <View style={pc.tagBadge}>
              <Text style={pc.tagText}>📍 Manual tag</Text>
            </View>
          )}
          {isOwner && (
            <View style={[pc.visLabel, card.visibility === 'public' ? pc.visPublic : pc.visPrivate]}>
              <Text style={pc.visText}>{card.visibility === 'public' ? 'Public' : card.visibility === 'trip_only' ? 'Trip' : 'Private'}</Text>
            </View>
          )}
        </View>
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
  if (postcards.length === 0) {
    return (
      <View style={pc.empty}>
        <Text style={pc.emptyIcon}>🌍</Text>
        <Text style={pc.emptyTitle}>No postcards yet</Text>
        <Text style={pc.emptySub}>
          {isOwner
            ? 'Share a travel moment to start your Passport wall.'
            : "This traveler hasn't posted any postcards yet."}
        </Text>
        {isOwner && (
          <Pressable style={pc.emptyBtn} onPress={onAddPostcard ?? (() => router.push('/create' as any))}>
            <Text style={pc.emptyBtnText}>Add first Postcard</Text>
          </Pressable>
        )}
      </View>
    );
  }

  const pinned = postcards.find((c) => c.pinnedAt);
  const rest = postcards.filter((c) => !c.pinnedAt);
  const sorted = pinned ? [pinned, ...rest] : rest;

  return (
    <View style={pc.listWrap}>
      {isOwner && onAddPostcard && (
        <Pressable style={pc.addBtn} onPress={onAddPostcard}>
          <Plus size={16} color={color.onInk} />
          <Text style={pc.addBtnText}>Add Postcard</Text>
        </Pressable>
      )}
      <View style={pc.list}>
        {sorted.map((card) => (
          <PostcardCard key={card.id} card={card} isOwner={isOwner} actions={actions} />
        ))}
      </View>
    </View>
  );
}

const pc = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    overflow: 'hidden', ...shadow.card, marginBottom: space.md,
  },
  media: { width: '100%', height: 220, backgroundColor: color.haze },
  noMedia: { alignItems: 'center', justifyContent: 'center' },
  noMediaText: { fontSize: 40 },
  pinBadge: {
    position: 'absolute', top: 10, left: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(250,249,246,0.92)',
    borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: color.signal,
  },
  pinText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: color.signal, letterSpacing: 1 },
  menuBtn: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(250,249,246,0.92)',
    borderRadius: 20, padding: 6,
    borderWidth: 1, borderColor: color.haze,
  },
  body: { padding: space.md, gap: space.sm },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  locText: { ...t.small, color: color.deep, fontFamily: 'Courier', fontWeight: '700', fontSize: 11 },
  dateText: { ...t.small, color: color.faint, fontFamily: 'Courier', fontSize: 10 },
  caption: { ...t.body, color: color.ink, lineHeight: 20 },
  badgeRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E3F1EA', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  verifiedText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 11 },
  tagBadge: { backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: color.haze },
  tagText: { ...t.small, color: color.mute, fontSize: 11 },
  visLabel: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  visPublic: { backgroundColor: '#E3F1EA' },
  visPrivate: { backgroundColor: '#FCE9E4' },
  visText: { ...t.small, fontSize: 11, fontWeight: '700', color: color.ink },
  listWrap: {},
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    alignSelf: 'flex-start', marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  addBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  list: { paddingHorizontal: space.lg, paddingTop: space.md },
  videoPlayOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
  emptyBtn: { backgroundColor: color.signal, paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.pill },
  emptyBtnText: { ...t.bodyStrong, color: color.onInk },
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
