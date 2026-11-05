/**
 * SavedPostsList — the "Saved posts" view of the Saved screen (app/saved.tsx).
 *
 * A post bookmark writes post_saves (GET /posts/saved-by-me lists them), which
 * no collection shows, so a post the user saved appeared nowhere on the Saved
 * screen. This lists those posts, newest save first.
 *
 * Each row is read through GET /posts/:id, so the post's own visibility rules
 * decide what the saver sees. States are true ones: a failed read of the list
 * is "couldn't load" with a retry (never "no saved posts"), a row that failed
 * to load says so and retries on tap, and a post that is gone says that.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { BookmarkX, ChevronLeft, ChevronRight, FolderPlus, Image as ImageIcon } from 'lucide-react-native';
import { EmptyState } from './ui/EmptyState.tsx';
import { ErrorState } from './ui/ErrorState.tsx';
import { getMySavedPostIds } from '../services/collections.ts';
import { getPostById, type PostRow } from '../services/posts.ts';
import { useNavBarScrollHandler, NavBarFiller } from '../hooks/useNavBarCollapse.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

type RowState =
  | { state: 'loading' }
  | { state: 'ok'; post: PostRow }
  | { state: 'gone' }
  | { state: 'error' };

function SavedPostRow({ postId, onOrganize }: { postId: string; onOrganize?: (postId: string) => void }) {
  const [row, setRow] = useState<RowState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setRow({ state: 'loading' });
    getPostById(postId)
      .then((res) => {
        if (!alive) return;
        if (res.ok && res.data) setRow({ state: 'ok', post: res.data });
        // not_found is also the answer for a post the saver can no longer read
        // (deleted, made private, blocked); any other failure is retryable.
        else setRow(res.errorKind === 'not_found' ? { state: 'gone' } : { state: 'error' });
      })
      .catch(() => { if (alive) setRow({ state: 'error' }); });
    return () => { alive = false; };
  }, [postId, attempt]);

  if (row.state === 'ok') {
    const firstLine = row.post.content.trim().split('\n')[0] ?? '';
    const handle = row.post.author?.handle;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          onPress={() => router.push(`/post/${postId}` as any)}
          style={({ pressed }) => [s.row, { flex: 1 }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          testID={`saved-post-${postId}`}
        >
          <View style={s.icon}><ImageIcon size={15} color={color.mute} /></View>
          <View style={s.body}>
            <Text style={s.title} numberOfLines={1}>{firstLine || 'Post'}</Text>
            <Text style={s.meta} numberOfLines={1}>{handle ? `@${handle}` : 'Post'}</Text>
          </View>
          <ChevronRight size={14} color={color.faint} />
        </Pressable>
        {onOrganize ? (
          <Pressable onPress={() => onOrganize(postId)} style={{ padding: space.sm }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Add ${firstLine || 'post'} to collection`}>
            <FolderPlus size={20} color={color.deep} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  const title = row.state === 'loading' ? 'Loading…'
    : row.state === 'gone' ? 'Post unavailable'
    : 'Couldn’t load this post';
  const meta = row.state === 'gone' ? 'Deleted or no longer visible to you'
    : row.state === 'error' ? 'Tap to try again'
    : '';
  const content = (
    <>
      <View style={s.icon}><ImageIcon size={15} color={color.mute} /></View>
      <View style={s.body}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={s.meta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {row.state === 'loading' ? <ActivityIndicator size="small" color={color.mute} /> : null}
    </>
  );
  if (row.state !== 'error') return <View style={s.row}>{content}</View>;
  return (
    <Pressable
      style={s.row}
      onPress={() => setAttempt((n) => n + 1)}
      accessibilityRole="button"
      testID={`saved-post-retry-${postId}`}
    >
      {content}
    </Pressable>
  );
}

type ListState =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ok'; postIds: string[] };

export function SavedPostsList({ onBack, onOrganize, revision = 0 }: { onBack: () => void; onOrganize?: (postId: string) => void; revision?: number }) {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const generation = useRef(0);

  const fetchIds = useCallback(async () => {
    const attempt = ++generation.current;
    // Keep the list on screen while a refocus re-reads it.
    setList((prev) => (prev.state === 'ok' ? prev : { state: 'loading' }));
    const res = await getMySavedPostIds();
    if (generation.current !== attempt) return;
    setList(res.ok ? { state: 'ok', postIds: res.postIds } : { state: 'error' });
  }, [revision]);

  // Re-read on focus, so a post unsaved on its detail screen drops off here.
  useFocusEffect(useCallback(() => {
    void fetchIds();
    return () => { generation.current += 1; };
  }, [fetchIds]));

  const count = list.state === 'ok' ? list.postIds.length : null;
  const header = (
    <View style={s.header}>
      <Pressable onPress={onBack} style={s.backBtn} hitSlop={8} accessibilityLabel="Back">
        <ChevronLeft size={22} color={color.ink} />
      </Pressable>
      <Text style={s.headerTitle} numberOfLines={1}>Saved posts</Text>
      {count !== null ? (
        <Text style={s.headerMeta}>{count} {count === 1 ? 'post' : 'posts'}</Text>
      ) : null}
    </View>
  );

  if (list.state !== 'ok' || list.postIds.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        {list.state === 'loading' ? (
          <View style={s.center} testID="saved-posts-loading"><ActivityIndicator color={color.signal} /></View>
        ) : list.state === 'error' ? (
          <ErrorState message="We couldn't load your saved posts." onRetry={() => { void fetchIds(); }} />
        ) : (
          <EmptyState
            icon={BookmarkX}
            title="No saved posts yet"
            description="Tap the bookmark on a post to keep it here."
          />
        )}
      </View>
    );
  }

  return (
    <FlatList
      data={list.postIds}
      keyExtractor={(id) => id}
      contentContainerStyle={{ padding: space.lg, gap: space.sm }}
      renderItem={({ item }) => <SavedPostRow postId={item} onOrganize={onOrganize} />}
      onScroll={navBarScrollHandler}
      scrollEventThrottle={16}
      ListHeaderComponent={header}
      ListFooterComponent={<NavBarFiller />}
    />
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { padding: 4 },
  headerTitle: { ...t.heading, color: color.ink, flex: 1, fontSize: 15 },
  headerMeta: { ...t.small, color: color.mute, fontSize: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: `${color.haze}60`,
  },
  icon: {
    width: 32, height: 32, borderRadius: radius.sm,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  meta: { ...t.small, color: color.mute, fontSize: 11 },
});
