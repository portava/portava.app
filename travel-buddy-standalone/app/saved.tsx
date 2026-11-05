/**
 * Saved — Collections hub screen.
 *
 * Shows all of the user's collections as a grid of cards.
 * Tapping a collection opens its items list within the same screen.
 * The legacy place-bookmarks are preserved in the default "Saved" collection.
 */
import React, { useState, useCallback, useRef } from 'react';
import { usePrivateSurfaceKey } from '../src/hooks/usePrivateSurfaceKey.ts';
import {
  View, Text, ScrollView, FlatList, StyleSheet,
  ActivityIndicator, Pressable, Animated, TextInput, Modal,
} from 'react-native';
import { CachedImage } from '../src/components/CachedImage';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import { getPlaceCategoryFallback } from '../src/utils/placeCategoryFallback';
import { useFocusEffect, router } from 'expo-router';
import { AppHeader } from '../src/components/ui/AppHeader';
import { color, space, radius, shadow, type as t } from '../src/theme/tokens';
import {
  readCollections, createCollection, deleteCollection, updateCollection,
  getCollectionItems,
  type Collection, type CollectionItem,
} from '../src/services/collections';
import { SavedGemsList } from '../src/components/SavedGemsList.tsx';
import { SavedPostsList } from '../src/components/SavedPostsList';
import { SaveToCollectionSheet } from '../src/components/SaveToCollectionSheet';
import { KeyboardSafeView } from '../src/components/ui/KeyboardSafeView.tsx';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';
import {
  Bookmark, FolderPlus, Folder, Trash2, X, ChevronRight,
  ChevronLeft, MapPin, User, Image as ImageIcon, Hash, CalendarDays,
  Pencil, ChevronRight as NavArrow, BookmarkX,
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
    // entityId is the profile's user id (uuid) — the /u/ route resolves
    // uuid params to the canonical handle via its UuidHandleRedirect fallback.
    case 'profile':   return `/u/${item.entityId}`;
    case 'place':     return `/place/${item.entityId}`;
    case 'hashtag':   return `/hashtag/${item.title?.startsWith('#') ? item.title.slice(1) : item.entityId}`;
    case 'memory':    return `/memory/${encodeURIComponent(item.entityId)}`;
    case 'gem':       return `/gems/${encodeURIComponent(item.entityId)}`;
    case 'highlight': return `/highlights/${encodeURIComponent(item.entityId)}`;
    default:          return null;
  }
}

// ── Collection grid card ──────────────────────────────────────────────────────
interface CollectionCardProps {
  col: Collection;
  onPress: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  deleting?: boolean;
}

function CollectionCard({ col, onPress, onDelete, onRename, deleting }: CollectionCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [s.colCard, pressed && { opacity: 0.8 }]}
      onPress={onPress}
      disabled={deleting}
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
            disabled={deleting}
            accessibilityLabel={`Rename ${col.name}`}
          >
            <Pencil size={14} color={color.mute} />
          </Pressable>
        )}
        {!col.isDefault && onDelete && (
          <Pressable
            hitSlop={8}
            onPress={(e) => { (e as any).stopPropagation?.(); onDelete(); }}
            style={s.actionBtn}
            disabled={deleting}
            accessibilityLabel={`Delete ${col.name}`}
          >
            {deleting ? <ActivityIndicator size="small" color={color.mute} /> : <Trash2 size={14} color={color.mute} />}
          </Pressable>
        )}
        <ChevronRight size={16} color={color.faint} />
      </View>
    </Pressable>
  );
}

// ── Collection item row ────────────────────────────────────────────────────────
function PlaceThumb({ coverUrl }: { coverUrl: string | null }) {
  const fallback = getPlaceCategoryFallback('places');
  const [failed, setFailed] = React.useState(false);
  if (coverUrl && !failed) {
    return (
      <View style={s.placeThumb} testID="place-collection-thumb">
        <CachedImage
          source={{ uri: coverUrl }}
          style={s.placeThumbImg}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      </View>
    );
  }
  return (
    <View
      style={[s.placeThumb, s.placeThumbFallback, { backgroundColor: fallback.color + '20' }]}
      testID="place-collection-thumb"
    >
      <Text style={s.placeThumbEmoji}>{fallback.emoji}</Text>
    </View>
  );
}

function CollectionItemRow({ item, onOrganize }: { item: CollectionItem; onOrganize: (item: CollectionItem) => void }) {
  const dest = routeForItem(item);
  const isPlace = item.entityType === 'place';
  const inner = (
    <View style={s.itemRow}>
      {isPlace ? (
        <PlaceThumb coverUrl={item.coverUrl} />
      ) : (
        <View style={s.itemIcon}>
          <EntityIcon type={item.entityType} size={15} />
        </View>
      )}
      <View style={s.itemBody}>
        <Text style={s.itemTitle} numberOfLines={1}>
          {item.title ?? item.entityId.slice(0, 8)}
        </Text>
        <Text style={s.itemMeta}>{isPlace ? 'Place' : item.entityType}</Text>
      </View>
      {dest ? <NavArrow size={14} color={color.faint} /> : null}
    </View>
  );

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {dest ? (
        <Pressable onPress={() => router.push(dest as any)} style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}>
          {inner}
        </Pressable>
      ) : <View style={{ flex: 1 }}>{inner}</View>}
      <Pressable onPress={() => onOrganize(item)} style={s.actionBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Add ${item.title ?? 'item'} to collection`}>
        <FolderPlus size={20} color={color.deep} />
      </Pressable>
    </View>
  );
}

// ── Collection items view ─────────────────────────────────────────────────────
interface CollectionItemsViewProps {
  collection: Collection;
  onBack: () => void;
  onOrganize: (item: CollectionItem) => void;
  revision: number;
}

function CollectionItemsView({ collection, onBack, onOrganize, revision }: CollectionItemsViewProps) {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [items, setItems]     = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor]   = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const generation = useRef(0);
  const pendingPage = useRef(false);

  const load = useCallback(async () => {
    const attempt = ++generation.current;
    pendingPage.current = false;
    setLoading(true);
    setLoadingMore(false);
    const result = await getCollectionItems(collection.id);
    if (generation.current !== attempt) return;
    setLoadFailed(!result.ok);
    setMoreFailed(false);
    if (result.ok) {
      setItems(result.items);
      setHasMore(result.hasMore);
      setCursor(result.nextCursor);
    }
    setLoading(false);
  }, [collection.id, revision]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { generation.current += 1; pendingPage.current = false; };
  }, [load]));

  const loadMore = async () => {
    if (!hasMore || !cursor || loading || pendingPage.current) return;
    pendingPage.current = true;
    const attempt = generation.current;
    setLoadingMore(true);
    const result = await getCollectionItems(collection.id, cursor);
    if (generation.current !== attempt) return;
    pendingPage.current = false;
    setMoreFailed(!result.ok);
    if (result.ok) {
      setItems((prev) => [...new Map([...prev, ...result.items].map(item => [item.id, item])).values()]);
      setHasMore(result.hasMore);
      setCursor(result.nextCursor);
    }
    setLoadingMore(false);
  };

  const subHeader = (
    <View style={s.subHeader}>
      <Pressable onPress={onBack} style={s.backBtn} hitSlop={8} accessibilityLabel="Back to collections">
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
      ) : loadFailed ? (
        <View style={{ flex: 1 }}>
          {subHeader}
          <ErrorState message="This collection could not be loaded. Please try again." onRetry={() => void load()} />
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1 }}>
          {subHeader}
          <EmptyState
            icon={BookmarkX}
            title="Nothing saved here yet"
            description="Tap the bookmark icon on posts, places, and more to add items."
          />
        </View>
      ) : (
        <FlatList
          testID="saved-collection-items"
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          renderItem={({ item }) => <CollectionItemRow item={item} onOrganize={onOrganize} />}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          onEndReached={moreFailed ? undefined : loadMore}
          onEndReachedThreshold={0.3}
          ListHeaderComponent={subHeader}
          ListFooterComponent={
            <>
              {moreFailed ? <ErrorState message="More saved items could not be loaded." onRetry={() => void loadMore()} /> : null}
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
  initialName: string;
  existingNames: string[];
  onClose: () => void;
  onCreated: (col: Collection) => void;
}

function CreateCollectionModal({
  initialName, existingNames, onClose, onCreated,
}: CreateCollectionModalProps) {
  const [name, setName]       = useState(initialName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy.current) return;
    busy.current = true;
    setError(null);
    setLoading(true);
    const col = await createCollection(trimmed).catch(() => null);
    if (!mounted.current) return;
    busy.current = false;
    setLoading(false);
    if (col) { setName(''); onCreated(col); }
    else setError('Couldn’t create this collection. Try again.');
  };

  const suggestions = STARTER_SUGGESTIONS.filter((n) => !existingNames.includes(n));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.modalBackdrop} onPress={onClose} />
      <KeyboardSafeView contentContainerStyle={s.modalContainer}>
      <View style={s.modalBox}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>New collection</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close new collection">
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <TextInput
          style={s.modalInput}
          value={name}
          editable={!loading}
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
              <Pressable key={sug} style={chips.chip} onPress={() => setName(sug)} disabled={loading}>
                <Text style={chips.chipLabel}>{sug}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {error ? <Text accessibilityRole="alert" style={{ color: color.signal }}>{error}</Text> : null}
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
      </KeyboardSafeView>
    </Modal>
  );
}

// ── Rename collection modal ───────────────────────────────────────────────────
interface RenameCollectionModalProps {
  collection: Collection;
  onClose: () => void;
  onRenamed: (col: Collection) => void;
}

function RenameCollectionModal({ collection, onClose, onRenamed }: RenameCollectionModalProps) {
  const [name, setName]       = useState(collection?.name ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy.current || trimmed === collection.name) return;
    busy.current = true;
    setError(null);
    setLoading(true);
    const updated = await updateCollection(collection.id, { name: trimmed }).catch(() => null);
    if (!mounted.current) return;
    busy.current = false;
    setLoading(false);
    if (updated) onRenamed(updated);
    else setError('Couldn’t rename this collection. Try again.');
  };

  return (
    <Modal visible={!!collection} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.modalBackdrop} onPress={onClose} />
      <KeyboardSafeView contentContainerStyle={s.modalContainer}>
      <View style={s.modalBox}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Rename collection</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close rename collection">
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <TextInput
          style={s.modalInput}
          value={name}
          editable={!loading}
          onChangeText={setName}
          placeholder="Collection name"
          placeholderTextColor={color.faint}
          autoFocus
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={handleRename}
          selectTextOnFocus
        />
        {error ? <Text accessibilityRole="alert" style={{ color: color.signal }}>{error}</Text> : null}
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
      </KeyboardSafeView>
    </Modal>
  );
}

// ── Saved people entry — TM-social PLAT-F16 ──────────────────────────────────
// Saved PROFILES live in user_saves, not in a collection, so they get their
// own row here rather than a fake collection card with a guessed count.
function SavedPeopleEntry() {
  return (
    <Pressable
      style={s.newCollectionRow}
      onPress={() => router.push('/saved-people' as never)}
      accessibilityRole="button"
      accessibilityLabel="Saved people"
      testID="saved-people-entry"
    >
      <User size={18} color={color.deep} />
      <Text style={s.newCollectionText}>Saved people</Text>
      <View style={{ flex: 1 }} />
      <ChevronRight size={16} color={color.mute} />
    </Pressable>
  );
}

// ── Saved posts ───────────────────────────────────────────────────────────────
// A post bookmark writes post_saves, which no collection lists, so a post the
// user saved appeared nowhere on this screen. This row opens that list
// (src/components/SavedPostsList).
function SavedPostsEntry({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={s.newCollectionRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Saved posts"
      testID="saved-posts-entry"
    >
      <ImageIcon size={18} color={color.deep} />
      <Text style={s.newCollectionText}>Saved posts</Text>
      <View style={{ flex: 1 }} />
      <ChevronRight size={16} color={color.mute} />
    </Pressable>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SavedScreen() {
  const scope = usePrivateSurfaceKey();
  return <SavedForViewer key={scope} />;
}

function SavedForViewer() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [collections, setCollections]           = useState<Collection[]>([]);
  const [loading, setLoading]                   = useState(true);
  const [loadFailed, setLoadFailed]             = useState(false);
  const [activeCollection, setActiveCollection] = useState<Collection | null>(null);
  const [savedGemsOpen, setSavedGemsOpen] = useState(false);
  const [savedPostsOpen, setSavedPostsOpen]     = useState(false);
  const [organizeItem, setOrganizeItem] = useState<Pick<CollectionItem, 'entityType' | 'entityId'> | null>(null);
  const [createOpen, setCreateOpen]             = useState(false);
  const [createName, setCreateName] = useState('');
  const [contentsRevision, setContentsRevision] = useState(0);
  const [renameTarget, setRenameTarget]         = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const pendingDeletes = useRef(new Set<string>());
  const generation = useRef(0);
  const mounted = useRef(true);
  const [removeError, setRemoveError]           = useState<string | null>(null);
  const errorY = useRef(new Animated.Value(80)).current;
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorY.stopAnimation();
    };
  }, [errorY]);

  const showError = useCallback((msg: string) => {
    if (!mounted.current) return;
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setRemoveError(msg);
    Animated.spring(errorY, { toValue: 0, useNativeDriver: true }).start();
    errorTimer.current = setTimeout(() => {
      Animated.timing(errorY, { toValue: 80, duration: 220, useNativeDriver: true }).start(
        () => { if (mounted.current) setRemoveError(null); },
      );
    }, 3000);
  }, [errorY]);

  const load = useCallback(async () => {
    const attempt = ++generation.current;
    setLoading(true);
    const read = await readCollections();
    if (!mounted.current || generation.current !== attempt) return;
    setCollections(read.data);
    setLoadFailed(!read.ok);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    // A collection may have been created or filled on the screen we just left.
    void load();
    return () => { generation.current += 1; };
  }, [load]));

  const handleDelete = useCallback(async (col: Collection) => {
    if (pendingDeletes.current.has(col.id)) return;
    pendingDeletes.current.add(col.id);
    setDeleting(new Set(pendingDeletes.current));
    const ok = await deleteCollection(col.id).catch(() => false);
    if (!mounted.current) return;
    generation.current += 1;
    setLoading(false);
    pendingDeletes.current.delete(col.id);
    setDeleting(new Set(pendingDeletes.current));
    if (ok) setCollections(previous => previous.filter(item => item.id !== col.id));
    else showError('Couldn’t delete this collection. Try again.');
  }, [showError]);

  const handleRenamed = useCallback((updated: Collection) => {
    generation.current += 1;
    setLoading(false);
    setCollections((cs) => cs.map((c) => c.id === updated.id ? updated : c));
    setRenameTarget(null);
  }, []);

  const existingNames = collections.map((c) => c.name);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {savedGemsOpen ? (
        <SavedGemsList revision={contentsRevision} onBack={() => setSavedGemsOpen(false)} onOrganize={gemId => setOrganizeItem({ entityType: 'gem', entityId: gemId })} />
      ) : savedPostsOpen ? (
        <SavedPostsList revision={contentsRevision} onBack={() => setSavedPostsOpen(false)} onOrganize={(postId) => setOrganizeItem({ entityType: 'post', entityId: postId })} />
      ) : activeCollection ? (
        <CollectionItemsView
          key={activeCollection.id}
          collection={collections.find(item => item.id === activeCollection.id) ?? activeCollection}
          revision={contentsRevision}
          onBack={() => setActiveCollection(null)}
          onOrganize={setOrganizeItem}
        />
      ) : (
        <>
          <AppHeader variant="detail" title="Saved" onBack={router.back} />
          {loading ? (
            <View style={{ flex: 1 }}>
              <View style={s.center}><ActivityIndicator color={color.signal} /></View>
            </View>
          ) : loadFailed && collections.length === 0 ? (
            <ScrollView
              contentContainerStyle={s.emptyState}
              onScroll={navBarScrollHandler}
              scrollEventThrottle={16}
            >
              <SavedPeopleEntry />
              <SavedPostsEntry onPress={() => setSavedPostsOpen(true)} />
              <Pressable style={s.newCollectionRow} accessibilityRole="button" accessibilityLabel="Saved gems" onPress={() => setSavedGemsOpen(true)}><Bookmark size={18} color={color.deep} /><Text style={s.newCollectionText}>Saved gems</Text></Pressable>
              {/* Not the empty state: its starter chips would make duplicates of collections that exist. */}
              <View testID="collections-load-error">
                <ErrorState message="Your collections could not be loaded. They are still saved." onRetry={() => void load()} />
              </View>
              <NavBarFiller />
            </ScrollView>
          ) : collections.length === 0 ? (
            <ScrollView
              contentContainerStyle={s.emptyState}
              onScroll={navBarScrollHandler}
              scrollEventThrottle={16}
            >
              <SavedPeopleEntry />
              <SavedPostsEntry onPress={() => setSavedPostsOpen(true)} />
              <Pressable style={s.newCollectionRow} accessibilityRole="button" accessibilityLabel="Saved gems" onPress={() => setSavedGemsOpen(true)}><Bookmark size={18} color={color.deep} /><Text style={s.newCollectionText}>Saved gems</Text></Pressable>
              <EmptyState
                icon={Bookmark}
                title="No collections yet"
                description="Saved posts, gems and people are listed above. Save places, events, and more into collections — they'll appear here."
                primaryAction={{ label: 'Create a collection', onPress: () => { setCreateName(''); setCreateOpen(true); } }}
              />
              <Text style={s.suggestLabel}>Starter ideas</Text>
              <View style={s.suggestRow}>
                {STARTER_SUGGESTIONS.map((name) => (
                  <Pressable
                    key={name}
                    style={chips.chip}
                    onPress={() => { setCreateName(name); setCreateOpen(true); }}
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
                      <SavedPeopleEntry />
                  <SavedPostsEntry onPress={() => setSavedPostsOpen(true)} />
              <Pressable style={s.newCollectionRow} accessibilityRole="button" accessibilityLabel="Saved gems" onPress={() => setSavedGemsOpen(true)}><Bookmark size={18} color={color.deep} /><Text style={s.newCollectionText}>Saved gems</Text></Pressable>
                  <Pressable style={s.newCollectionRow} onPress={() => { setCreateName(''); setCreateOpen(true); }}>
                    <FolderPlus size={18} color={color.deep} />
                    <Text style={s.newCollectionText}>New collection</Text>
                  </Pressable>
                </>
              }
              renderItem={({ item: col }) => (
                <CollectionCard
                  col={col}
                  deleting={deleting.has(col.id)}
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

      {createOpen ? <CreateCollectionModal
        initialName={createName}
        existingNames={existingNames}
        onClose={() => setCreateOpen(false)}
        onCreated={(col) => {
          generation.current += 1;
          setLoading(false);
          setCollections((prev) => [...prev.filter(item => item.id !== col.id), col]);
          setCreateOpen(false);
          setActiveCollection(col);
        }}
      /> : null}

      {organizeItem ? (
        <SaveToCollectionSheet
          key={`${organizeItem.entityType}:${organizeItem.entityId}`}
          visible
          entityType={organizeItem.entityType}
          entityId={organizeItem.entityId}
          isSaved
          onSaved={() => {}}
          onClose={() => { setOrganizeItem(null); setContentsRevision(value => value + 1); void load(); }}
        />
      ) : null}

      {renameTarget ? <RenameCollectionModal
        key={renameTarget.id}
        collection={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={handleRenamed}
      /> : null}

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

  // Place-specific thumbnail
  placeThumb:         { width: 40, height: 40, borderRadius: radius.sm, overflow: 'hidden' },
  placeThumbImg:      { width: 40, height: 40 },
  placeThumbFallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.haze },
  placeThumbEmoji:    { fontSize: 18 },

  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalBox: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg, padding: space.lg, gap: space.md,
    ...shadow.float,
  },
  modalContainer: { flexGrow: 1, justifyContent: 'center', padding: space.lg },
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
