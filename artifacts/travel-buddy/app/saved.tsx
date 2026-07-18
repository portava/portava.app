/**
 * Saved — Collections hub screen.
 *
 * Shows all of the user's collections as a grid of cards.
 * Tapping a collection opens its items list within the same screen.
 * The legacy place-bookmarks are preserved in the default "Saved" collection.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, FlatList, StyleSheet,
  ActivityIndicator, Pressable, Animated, TextInput, Modal,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { FEED_FOCUS_TTL_MS } from '../src/hooks/usePosts';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, radius, shadow, type as t } from '../src/theme/tokens';
import {
  getCollections, createCollection, deleteCollection, updateCollection,
  getCollectionItems,
  type Collection, type CollectionItem,
} from '../src/services/collections';
import { withOptimisticRemoveBool } from '../src/utils/optimisticRemove';
import { NavBarFiller, useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import {
  Bookmark, FolderPlus, Folder, Trash2, X, ChevronRight,
  ChevronLeft, MapPin, User, Image as ImageIcon, Hash, CalendarDays,
  Pencil, ChevronRight as NavArrow,
} from 'lucide-react-native';

// ── Suggested starter collections ────────────────────────────────────────────
const STARTER_SUGGESTIONS = ['Food', 'Nightlife', 'Beaches', 'Hidden Gems', 'Future Trips'];

// ── Entity type icon ──────────────────────────────────────────────────────────
function EntityIcon({ type, size = 14 }: { type: string; size?: number }) {
  const c = color.mute;
  switch (type) {
    case 'place':   return <MapPin size={size} color={c} />;
    case 'profile': return <User size={size} color={c} />;
    case 'hashtag': return <Hash size={size} color={c} />;
    case 'event':   return <CalendarDays size={size} color={c} />;
    default:        return <ImageIcon size={size} color={c} />;
  }
}

// ── Entity routing ───────────────────────────────────────────────────────────
function routeForItem(item: CollectionItem): string | null {
  switch (item.entityType) {
    case 'post':      return `/post/${item.entityId}`;
    case 'event':     return `/event/${item.entityId}`;
    case 'trip':      return `/trip/${item.entityId}`;
    case 'profile':   return `/u/${item.entityId}`;
    case 'place':     return `/place/${item.entityId}`;
    case 'hashtag':   return `/hashtag/${item.title?.startsWith('#') ? item.title.slice(1) : item.entityId}`;
    case 'highlight': return null;
    default:          return null;
  }
}

// ── Collection grid card ──────────────────────────────────────────────────────
interface CollectionCardProps {
  col: Collection;
  onPress: () => void;
  onDelete?: () => void;
  onRename?: () => void;
}

function CollectionCard({ col, onPress, onDelete, onRename }: CollectionCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [s.colCard, pressed && { opacity: 0.8 }]}
      onPress={onPress}
    >
      <View style={s.colCoverPlaceholder}>
        <Folder size={28} color={color.signal} />
      </View>
      <View style={s.colCardBody}>
        <Text style={s.colName} numberOfLines={1}>{col.name}</Text>
        <Text style={s.colMeta}>
          {col.itemCount} {col.itemCount === 1 ? 'item' : 'items'}
        </Text>
      </View>
      <View style={s.colCardActions}>
        {!col.isDefault && onRename && (
          <Pressable
            hitSlop={8}
            onPress={(e) => { (e as any).stopPropagation?.(); onRename(); }}
            style={s.actionBtn}
          >
            <Pencil size={14} color={color.mute} />
          </Pressable>
        )}
        {!col.isDefault && onDelete && (
          <Pressable
            hitSlop={8}
            onPress={(e) => { (e as any).stopPropagation?.(); onDelete(); }}
            style={s.actionBtn}
          >
            <Trash2 size={14} color={color.mute} />
          </Pressable>
        )}
        <ChevronRight size={16} color={color.faint} />
      </View>
    </Pressable>
  );
}

// ── Collection item row ────────────────────────────────────────────────────────
function CollectionItemRow({ item }: { item: CollectionItem }) {
  const dest = routeForItem(item);
  const inner = (
    <View style={s.itemRow}>
      <View style={s.itemIcon}>
        <EntityIcon type={item.entityType} size={15} />
      </View>
      <View style={s.itemBody}>
        <Text style={s.itemTitle} numberOfLines={1}>
          {item.title ?? item.entityId.slice(0, 8)}
        </Text>
        <Text style={s.itemMeta}>{item.entityType}</Text>
      </View>
      {dest ? <NavArrow size={14} color={color.faint} /> : null}
    </View>
  );

  if (!dest) return inner;

  return (
    <Pressable
      onPress={() => router.push(dest as any)}
      style={({ pressed }) => [pressed && { opacity: 0.7 }]}
    >
      {inner}
    </Pressable>
  );
}

// ── Collection items view ─────────────────────────────────────────────────────
interface CollectionItemsViewProps {
  collection: Collection;
  onBack: () => void;
}

function CollectionItemsView({ collection, onBack }: CollectionItemsViewProps) {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [items, setItems]     = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor]   = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastLoadedAt = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getCollectionItems(collection.id);
    setItems(result.items);
    setHasMore(result.hasMore);
    setCursor(result.nextCursor);
    lastLoadedAt.current = Date.now();
    setLoading(false);
  }, [collection.id]);

  useFocusEffect(useCallback(() => {
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {
      void load();
    }
  }, [load]));

  const loadMore = async () => {
    if (!hasMore || !cursor || loadingMore) return;
    setLoadingMore(true);
    const result = await getCollectionItems(collection.id, cursor);
    setItems((prev) => [...prev, ...result.items]);
    setHasMore(result.hasMore);
    setCursor(result.nextCursor);
    setLoadingMore(false);
  };

  const subHeader = (
    <View style={s.subHeader}>
      <Pressable onPress={onBack} style={s.backBtn} hitSlop={8}>
        <ChevronLeft size={22} color={color.ink} />
      </Pressable>
      <Text style={s.subHeaderTitle} numberOfLines={1}>{collection.name}</Text>
      <Text style={s.subHeaderMeta}>
        {collection.itemCount} {collection.itemCount === 1 ? 'item' : 'items'}
      </Text>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {loading ? (
        <View style={{ flex: 1 }}>
          {subHeader}
          <View style={s.center}><ActivityIndicator color={color.signal} /></View>
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1 }}>
          {subHeader}
          <View style={s.center}>
            <Bookmark size={32} color={color.haze} />
            <Text style={s.emptyTitle}>Nothing saved here yet</Text>
            <Text style={s.emptySub}>
              Tap the bookmark icon on posts, places, and more to add items.
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          renderItem={({ item }) => <CollectionItemRow item={item} />}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListHeaderComponent={subHeader}
          ListFooterComponent={
            <>
              {loadingMore ? (
                <View style={{ paddingVertical: space.lg, alignItems: 'center' }}>
                  <ActivityIndicator color={color.signal} />
                </View>
              ) : null}
              <NavBarFiller />
            </>
          }
        />
      )}
    </View>
  );
}

// ── Create collection modal ───────────────────────────────────────────────────
interface CreateCollectionModalProps {
  visible: boolean;
  existingNames: string[];
  onClose: () => void;
  onCreated: (col: Collection) => void;
}

function CreateCollectionModal({
  visible, existingNames, onClose, onCreated,
}: CreateCollectionModalProps) {
  const [name, setName]       = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    const col = await createCollection(trimmed);
    setLoading(false);
    if (col) { setName(''); onCreated(col); }
  };

  const suggestions = STARTER_SUGGESTIONS.filter((n) => !existingNames.includes(n));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.modalBackdrop} onPress={onClose} />
      <View style={s.modalBox}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>New collection</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <TextInput
          style={s.modalInput}
          value={name}
          onChangeText={setName}
          placeholder="Collection name"
          placeholderTextColor={color.faint}
          autoFocus
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={handleCreate}
        />
        {suggestions.length > 0 && (
          <View style={s.suggestRow}>
            {suggestions.map((sug) => (
              <Pressable key={sug} style={chips.chip} onPress={() => setName(sug)}>
                <Text style={chips.chipLabel}>{sug}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Pressable
          style={[s.modalConfirm, (!name.trim() || loading) && s.btnDisabled]}
          onPress={handleCreate}
          disabled={!name.trim() || loading}
        >
          {loading
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Text style={s.modalConfirmText}>Create</Text>
          }
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Rename collection modal ───────────────────────────────────────────────────
interface RenameCollectionModalProps {
  collection: Collection | null;
  onClose: () => void;
  onRenamed: (col: Collection) => void;
}

function RenameCollectionModal({ collection, onClose, onRenamed }: RenameCollectionModalProps) {
  const [name, setName]       = useState(collection?.name ?? '');
  const [loading, setLoading] = useState(false);

  // Keep input in sync when the target collection changes
  React.useEffect(() => { setName(collection?.name ?? ''); }, [collection?.id]);

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || !collection || loading || trimmed === collection.name) return;
    setLoading(true);
    const updated = await updateCollection(collection.id, { name: trimmed });
    setLoading(false);
    if (updated) onRenamed(updated);
  };

  return (
    <Modal visible={!!collection} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.modalBackdrop} onPress={onClose} />
      <View style={s.modalBox}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Rename collection</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <TextInput
          style={s.modalInput}
          value={name}
          onChangeText={setName}
          placeholder="Collection name"
          placeholderTextColor={color.faint}
          autoFocus
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={handleRename}
          selectTextOnFocus
        />
        <Pressable
          style={[s.modalConfirm, (!name.trim() || loading || name.trim() === collection?.name) && s.btnDisabled]}
          onPress={handleRename}
          disabled={!name.trim() || loading || name.trim() === collection?.name}
        >
          {loading
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Text style={s.modalConfirmText}>Save</Text>
          }
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SavedScreen() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [collections, setCollections]           = useState<Collection[]>([]);
  const [loading, setLoading]                   = useState(true);
  const [activeCollection, setActiveCollection] = useState<Collection | null>(null);
  const [createOpen, setCreateOpen]             = useState(false);
  const [renameTarget, setRenameTarget]         = useState<Collection | null>(null);
  const [removeError, setRemoveError]           = useState<string | null>(null);
  const errorY = useRef(new Animated.Value(80)).current;
  const lastLoadedAt = useRef(0);

  const showError = useCallback((msg: string) => {
    setRemoveError(msg);
    Animated.spring(errorY, { toValue: 0, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(errorY, { toValue: 80, duration: 220, useNativeDriver: true }).start(
        () => setRemoveError(null),
      );
    }, 3000);
  }, [errorY]);

  const load = useCallback(async () => {
    setLoading(true);
    const cols = await getCollections();
    setCollections(cols);
    lastLoadedAt.current = Date.now();
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {
      void load();
    }
  }, [load]));

  const handleDelete = useCallback(async (col: Collection) => {
    await withOptimisticRemoveBool({
      target: col,
      getItems: () => collections,
      setItems: setCollections,
      match: (item, t) => item.id === t.id,
      deleteOp: (c) => deleteCollection(c.id),
      onError: showError,
    });
  }, [collections, showError]);

  const handleRenamed = useCallback((updated: Collection) => {
    setCollections((cs) => cs.map((c) => c.id === updated.id ? updated : c));
    setRenameTarget(null);
  }, []);

  const existingNames = collections.map((c) => c.name);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {activeCollection ? (
        <CollectionItemsView
          collection={activeCollection}
          onBack={() => setActiveCollection(null)}
        />
      ) : (
        <>
          {loading ? (
            <View style={{ flex: 1 }}>
              <ScreenHeader title="Saved" back />
              <View style={s.center}><ActivityIndicator color={color.signal} /></View>
            </View>
          ) : collections.length === 0 ? (
            <ScrollView
              contentContainerStyle={s.emptyState}
              onScroll={navBarScrollHandler}
              scrollEventThrottle={16}
            >
              <ScreenHeader title="Saved" back />
              <Bookmark size={40} color={color.haze} />
              <Text style={s.emptyTitle}>Nothing saved yet</Text>
              <Text style={s.emptySub}>
                Save posts, places, events, and more — they&apos;ll appear here in collections.
              </Text>
              <Pressable style={s.createFirstBtn} onPress={() => setCreateOpen(true)}>
                <FolderPlus size={16} color={color.onInk} />
                <Text style={s.createFirstText}>Create your first collection</Text>
              </Pressable>
              <Text style={s.suggestLabel}>Starter ideas</Text>
              <View style={s.suggestRow}>
                {STARTER_SUGGESTIONS.map((name) => (
                  <Pressable
                    key={name}
                    style={chips.chip}
                    onPress={async () => {
                      const col = await createCollection(name);
                      if (col) setCollections((prev) => [...prev, col]);
                    }}
                  >
                    <Text style={chips.chipLabel}>{name}</Text>
                  </Pressable>
                ))}
              </View>
              <NavBarFiller />
            </ScrollView>
          ) : (
            <FlatList
              data={collections}
              keyExtractor={(c) => c.id}
              contentContainerStyle={{ padding: space.lg, gap: space.md }}
              onScroll={navBarScrollHandler}
              scrollEventThrottle={16}
              ListHeaderComponent={
                <>
                  <ScreenHeader title="Saved" back />
                  <Pressable style={s.newCollectionRow} onPress={() => setCreateOpen(true)}>
                    <FolderPlus size={18} color={color.deep} />
                    <Text style={s.newCollectionText}>New collection</Text>
                  </Pressable>
                </>
              }
              renderItem={({ item: col }) => (
                <CollectionCard
                  col={col}
                  onPress={() => setActiveCollection(col)}
                  onDelete={col.isDefault ? undefined : () => handleDelete(col)}
                  onRename={col.isDefault ? undefined : () => setRenameTarget(col)}
                />
              )}
              ListFooterComponent={<NavBarFiller />}
            />
          )}
        </>
      )}

      <CreateCollectionModal
        visible={createOpen}
        existingNames={existingNames}
        onClose={() => setCreateOpen(false)}
        onCreated={(col) => {
          setCollections((prev) => [...prev, col]);
          setCreateOpen(false);
          setActiveCollection(col);
        }}
      />

      <RenameCollectionModal
        collection={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={handleRenamed}
      />

      {removeError && (
        <Animated.View
          style={[s.errorToast, { transform: [{ translateY: errorY }] }]}
          pointerEvents="none"
        >
          <Text style={s.errorToastText}>{removeError}</Text>
        </Animated.View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },

  emptyState: {
    alignItems: 'center',
    padding: space.lg,
    paddingTop: space.xxxl,
    gap: space.md,
  },
  emptyTitle: { ...t.heading, color: color.ink, fontSize: 17 },
  emptySub: {
    ...t.body, color: color.mute, textAlign: 'center',
    paddingHorizontal: space.xl, lineHeight: 20,
  },

  createFirstBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.signal,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.pill, marginTop: space.sm,
  },
  createFirstText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },

  suggestLabel: {
    ...t.stamp, color: color.faint, fontSize: 11,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' },

  newCollectionRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    marginBottom: space.sm,
  },
  newCollectionText: { ...t.bodyStrong, color: color.deep, fontSize: 14 },

  colCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md, gap: space.md,
    ...shadow.card,
  },
  colCoverPlaceholder: {
    width: 52, height: 52, borderRadius: radius.sm,
    backgroundColor: `${color.signal}12`,
    alignItems: 'center', justifyContent: 'center',
  },
  colCardBody: { flex: 1, gap: 4 },
  colName:   { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  colMeta:   { ...t.small, color: color.mute, fontSize: 12 },
  colCardActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actionBtn: {
    width: 28, height: 28, borderRadius: 8,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },

  subHeader: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { padding: 4 },
  subHeaderTitle: { ...t.heading, color: color.ink, flex: 1, fontSize: 15 },
  subHeaderMeta:  { ...t.small, color: color.mute, fontSize: 12 },

  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: `${color.haze}60`,
  },
  itemIcon: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  itemBody:  { flex: 1, gap: 2 },
  itemTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  itemMeta:  { ...t.small, color: color.mute, fontSize: 11, textTransform: 'capitalize' },

  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalBox: {
    position: 'absolute', top: '30%', left: space.lg, right: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg, padding: space.lg, gap: space.md,
    ...shadow.float,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  modalTitle:       { ...t.heading, color: color.ink, fontSize: 16 },
  modalInput: {
    borderWidth: 1.5, borderColor: color.signal,
    borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    fontSize: 14, color: color.ink,
  },
  modalConfirm: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  modalConfirmText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  btnDisabled:      { opacity: 0.5 },

  errorToast: {
    position: 'absolute', bottom: 24, left: space.lg, right: space.lg,
    backgroundColor: '#DC2626',
    borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: 10,
    alignItems: 'center',
  },
  errorToastText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});

const chips = StyleSheet.create({
  chip: {
    paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze,
  },
  chipLabel: { ...t.small, color: color.mute, fontSize: 12 },
});
