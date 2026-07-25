/**
 * Memory detail screen — /memory/:id
 *
 * Loads the memory and renders all attached photos/videos in a scrollable
 * view. Owners see a delete-item button on each photo and a delete-memory
 * option in the header.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, Image,
  StyleSheet, ActivityIndicator, Alert, Dimensions,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Trash2, Heart, Globe, Users, Lock, Eye,
  MoreHorizontal, Plus, CalendarDays, MapPin,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getMemory, deleteMemoryItem, deleteMemory, likeMemory, unlikeMemory,
  addMemoryItem, type Memory, type MemoryItem,
} from '../../src/services/memories';
import { useSession } from '../../src/context/SessionContext';
import { EngagementUserListSheet } from '../../src/components/EngagementUserListSheet';
import * as ImagePicker from 'expo-image-picker';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';

const { width: SCREEN_W } = Dimensions.get('window');

// ── Helpers ───────────────────────────────────────────────────────────────────

function visibilityLabel(v: string): string {
  if (v === 'public')       return 'Public';
  if (v === 'friends_only') return 'Friends';
  if (v === 'trip_crew')    return 'Trip crew';
  if (v === 'circle_only')  return 'Circle';
  if (v === 'only_me')      return 'Only me';
  return v;
}

function VisibilityIcon({ v }: { v: string }) {
  const sz = 13;
  if (v === 'public')       return <Globe  size={sz} color={color.success} />;
  if (v === 'friends_only') return <Users  size={sz} color={color.signal} />;
  if (v === 'trip_crew')    return <Eye    size={sz} color={color.deep} />;
  if (v === 'only_me')      return <Lock   size={sz} color={color.mute} />;
  return <Lock size={sz} color={color.mute} />;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function MemoryDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [memory, setMemory] = useState<Memory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingMedia, setAddingMedia] = useState(false);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [likeLoading, setLikeLoading] = useState(false);
  const [likerSheetOpen, setLikerSheetOpen] = useState(false);

  const isOwner = memory?.ownerId === userId;

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    const result = await getMemory(id);
    setLoading(false);
    if (!result.ok) { setError(result.message); return; }
    setMemory(result.memory);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Owner actions menu ──────────────────────────────────────────────────────

  const handleOwnerMenu = useCallback(() => {
    if (!memory) return;
    Alert.alert('Memory options', undefined, [
      {
        text: 'Edit',
        onPress: () => router.push({ pathname: '/memory/edit' as any, params: { id: memory.id } }),
      },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Delete memory?',
            'This will permanently remove the memory and all its photos.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete', style: 'destructive',
                onPress: async () => {
                  await deleteMemory(memory.id);
                  router.back();
                },
              },
            ],
          );
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [memory]);

  // ── Delete item ─────────────────────────────────────────────────────────────

  const handleDeleteItem = useCallback((item: MemoryItem) => {
    if (!memory) return;
    Alert.alert('Remove photo?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          setDeletingItemId(item.id);
          const res = await deleteMemoryItem(memory.id, item.id);
          setDeletingItemId(null);
          if (res.ok) {
            setMemory((prev) => {
              if (!prev) return prev;
              return { ...prev, items: (prev.items ?? []).filter((i) => i.id !== item.id) };
            });
          } else {
            Alert.alert('Could not remove', 'Something went wrong. Please try again.');
          }
        },
      },
    ]);
  }, [memory]);

  // ── Add media ───────────────────────────────────────────────────────────────

  const handleAddMedia = useCallback(async () => {
    if (!memory) return;

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow access to your photo library to attach media.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: Math.max(1, 10 - (memory.items?.length ?? 0)),
    });

    if (result.canceled) return;

    setAddingMedia(true);
    const currentCount = memory.items?.length ?? 0;

    const results = await Promise.allSettled(
      result.assets.map((asset, i) => {
        const mediaType = asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        return addMemoryItem(memory.id, asset.uri, mediaType, null, currentCount + i);
      }),
    );

    const newItems: MemoryItem[] = results
      .filter((r): r is PromiseFulfilledResult<{ ok: true; item: MemoryItem }> =>
        r.status === 'fulfilled' && r.value.ok)
      .map((r) => r.value.item);

    if (newItems.length > 0) {
      setMemory((prev) => {
        if (!prev) return prev;
        return { ...prev, items: [...(prev.items ?? []), ...newItems] };
      });
    }

    const failures = results.length - newItems.length;
    if (failures > 0) {
      Alert.alert('Upload issue', `${failures} photo(s) failed to upload. Please try again.`);
    }

    setAddingMedia(false);
  }, [memory]);

  // ── Like ────────────────────────────────────────────────────────────────────

  const handleLike = useCallback(async () => {
    if (!memory || likeLoading) return;
    setLikeLoading(true);
    if (memory.likedByMe) {
      const res = await unlikeMemory(memory.id);
      if (res.ok) {
        setMemory((prev) => prev ? { ...prev, likedByMe: false, likeCount: (prev.likeCount ?? 1) - 1 } : prev);
      }
    } else {
      const res = await likeMemory(memory.id);
      if (res.ok) {
        setMemory((prev) => prev ? { ...prev, likedByMe: true, likeCount: (prev.likeCount ?? 0) + 1 } : prev);
      }
    }
    setLikeLoading(false);
  }, [memory, likeLoading]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (error || !memory) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <Text style={s.errorText}>{error || 'Memory not found'}</Text>
        <Pressable onPress={() => router.back()} style={s.backLink}>
          <Text style={s.backLinkText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const items = memory.items ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>
          {memory.title ?? 'Memory'}
        </Text>
        {isOwner ? (
          <Pressable onPress={handleOwnerMenu} hitSlop={8}>
            <MoreHorizontal size={22} color={color.ink} />
          </Pressable>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >

        {/* Media items */}
        {items.length > 0 ? (
          <View>
            {items.map((item) => (
              <View key={item.id} style={s.mediaItem}>
                {item.mediaUrl ? (
                  <Image
                    source={{ uri: item.mediaUrl }}
                    style={s.mediaImage}
                    resizeMode="cover"
                    onError={() => {/* expo-image shows blank on error; container provides fallback bg */}}
                  />
                ) : (
                  <View style={[s.mediaImage, s.mediaFallback]}>
                    <Text style={s.mediaFallbackText}>Photo unavailable</Text>
                  </View>
                )}
                {item.caption ? (
                  <Text style={s.mediaCaption}>{item.caption}</Text>
                ) : null}
                {isOwner && (
                  <Pressable
                    style={s.deleteItemBtn}
                    onPress={() => handleDeleteItem(item)}
                    hitSlop={4}
                    disabled={deletingItemId === item.id}
                  >
                    {deletingItemId === item.id
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Trash2 size={15} color="#fff" />}
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        ) : (
          <View style={s.emptyMedia}>
            <Text style={s.emptyMediaText}>No photos yet</Text>
          </View>
        )}

        {/* Add media button (owner + under limit) */}
        {isOwner && items.length < 10 && (
          <Pressable
            style={[s.addMoreBtn, addingMedia && s.addMoreBtnDisabled]}
            onPress={handleAddMedia}
            disabled={addingMedia}
          >
            {addingMedia
              ? <ActivityIndicator size="small" color={color.signal} />
              : <Plus size={18} color={color.signal} />}
            <Text style={s.addMoreText}>
              {addingMedia ? 'Uploading…' : 'Add photos'}
            </Text>
          </Pressable>
        )}

        {/* Meta block */}
        <View style={s.meta}>
          {/* Owner */}
          {memory.owner && (
            <Text style={s.ownerText}>
              {memory.owner.name ?? memory.owner.handle ?? 'Unknown'}
            </Text>
          )}

          {/* Title */}
          {memory.title && (
            <Text style={s.titleText}>{memory.title}</Text>
          )}

          {/* Caption */}
          {memory.caption && (
            <Text style={s.captionText}>{memory.caption}</Text>
          )}

          {/* Location */}
          {(memory.locationCity || memory.locationCountry) && (
            <Pressable
              style={s.locationRow}
              onPress={() => router.push({
                pathname: '/memory/location' as any,
                params: {
                  label: [memory.locationCity, memory.locationCountry].filter(Boolean).join(', '),
                  ...(memory.canonicalLocationId ? { canonicalLocationId: memory.canonicalLocationId } : {}),
                  ...(memory.locationCity    ? { city: memory.locationCity }       : {}),
                  ...(memory.locationCountry ? { country: memory.locationCountry } : {}),
                },
              })}
              hitSlop={6}
            >
              <MapPin size={13} color={color.signal} />
              <Text style={[s.locationText, s.locationTextTappable]}>
                {[memory.locationCity, memory.locationCountry].filter(Boolean).join(', ')}
              </Text>
            </Pressable>
          )}

          {/* Metadata row */}
          <View style={s.metaRow}>
            <VisibilityIcon v={memory.visibility} />
            <Text style={s.metaChip}>{visibilityLabel(memory.visibility)}</Text>
            <Text style={s.metaDot}>·</Text>
            <CalendarDays size={13} color={color.mute} />
            <Text style={s.metaChip}>{formatDate(memory.createdAt)}</Text>
          </View>

          {/* Like */}
          <View style={s.likeRow}>
            <Pressable
              onPress={handleLike}
              onLongPress={() => setLikerSheetOpen(true)}
              disabled={likeLoading}
              hitSlop={8}
            >
              <Heart
                size={20}
                color={memory.likedByMe ? color.signal : color.mute}
                fill={memory.likedByMe ? color.signal : 'none'}
              />
            </Pressable>
            {(memory.likeCount ?? 0) > 0 && (
              <Pressable onPress={() => setLikerSheetOpen(true)} hitSlop={6}>
                <Text style={s.likeCount}>{memory.likeCount}</Text>
              </Pressable>
            )}
          </View>
        </View>

        <PlainBottomFiller />
      </ScrollView>

      {likerSheetOpen && (
        <EngagementUserListSheet
          visible
          targetType="memory_like"
          targetId={id ?? ''}
          title="Liked by"
          initialTotal={memory.likeCount ?? 0}
          onClose={() => setLikerSheetOpen(false)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: color.paper },
  errorText: { ...(t.body as object), color: color.mute, textAlign: 'center', margin: space.xl },
  backLink: { marginTop: space.md },
  backLinkText: { ...(t.body as object), color: color.signal },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  headerTitle: { ...(t.bodyStrong as object), color: color.ink, flex: 1, marginHorizontal: space.md },

  mediaItem: {
    position: 'relative',
    borderBottomWidth: 1,
    borderColor: color.haze,
  },
  mediaImage: {
    width: SCREEN_W,
    height: SCREEN_W,
  },
  mediaFallback: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaFallbackText: {
    ...(t.small as object),
    color: color.mute,
  },
  mediaCaption: {
    ...(t.small as object),
    color: color.mute,
    padding: space.md,
    backgroundColor: color.paperRaised,
  },
  deleteItemBtn: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    padding: 7,
  },

  emptyMedia: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.haze,
  },
  emptyMediaText: { ...(t.body as object), color: color.faint },

  addMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  addMoreBtnDisabled: { opacity: 0.5 },
  addMoreText: { ...(t.body as object), color: color.signal, fontWeight: '600' },

  meta: {
    padding: space.lg,
    gap: space.sm,
  },
  ownerText: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  titleText: { ...(t.title as object), color: color.ink },
  captionText: { ...(t.body as object), color: color.ink, lineHeight: 22 },

  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  locationText: { ...(t.small as object), color: color.mute },
  locationTextTappable: { color: color.signal },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.xs },
  metaChip: { ...(t.small as object), color: color.mute },
  metaDot: { ...(t.small as object), color: color.faint },

  likeRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  likeCount: { ...(t.small as object), color: color.mute },
});
