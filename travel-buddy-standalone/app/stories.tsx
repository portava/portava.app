/**
 * Stories — /stories (PLAT-F32 / PLAT-F33).
 *
 * StoriesStrip, StoryViewer and StoryComposer were built and nothing under
 * app/ mounted any of them: no story could be opened, so none could be
 * reacted to, replied to or saved to a highlight. This is where they live.
 *
 *   Your story  — GET /me/stories (the feed never includes your own). With a
 *                 live story it opens the viewer, where Save to highlight is;
 *                 without one it opens the composer.
 *   Others      — GET /stories/feed: exactly the stories the server decided
 *                 you may see (audience, close friends, blocks, expiry).
 *
 * A feed that could not be read is an error with a retry, never "no stories";
 * stories switched off says so.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Plus } from 'lucide-react-native';
import { color, radius, space, type as t, avatar } from '../src/theme/tokens.ts';
import { getStoriesFeed, getMyStories, type StoryFeedUser } from '../src/services/stories.ts';
import { StoryViewer } from '../src/components/StoryViewer.tsx';
import { StoryComposer } from '../src/components/StoryComposer.tsx';
import { AvatarImage } from '../src/components/ui/DisplayMediaImage.tsx';
import { primaryIdentityText } from '../src/lib/displayIdentity.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; mine: StoryFeedUser | null; mineError: string | null; others: StoryFeedUser[] };

export default function StoriesRoute() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [viewing, setViewing] = useState<StoryFeedUser | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const [mine, feed] = await Promise.all([getMyStories(), getStoriesFeed()]);
    if (!mine.ok && mine.disabled) { setState({ kind: 'disabled' }); return; }
    if (!feed.ok) { setState({ kind: 'error', message: 'Stories could not be loaded right now.' }); return; }
    setState({
      kind: 'ready',
      mine: mine.ok ? mine.user : null,
      mineError: mine.ok ? null : mine.message,
      others: feed.users.filter((u) => u.stories.length > 0),
    });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openMine = () => {
    if (state.kind !== 'ready') return;
    if (state.mine && state.mine.stories.length > 0) setViewing(state.mine);
    else setComposerOpen(true);
  };

  return (
    <View style={s.screen}>
      <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Stories</Text>
        <Pressable onPress={() => setComposerOpen(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Post a story" testID="stories-new">
          <Plus size={22} color={color.ink} />
        </Pressable>
      </View>

      {state.kind === 'loading' ? (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      ) : state.kind === 'disabled' ? (
        <View style={s.center} testID="stories-disabled">
          <Text style={s.strong}>Stories are not available yet</Text>
        </View>
      ) : state.kind === 'error' ? (
        <View style={s.center} testID="stories-error">
          <Text style={s.body}>{state.message}</Text>
          <Pressable onPress={load} style={s.retry} accessibilityRole="button" testID="stories-retry"><Text style={s.retryText}>Try again</Text></Pressable>
        </View>
      ) : (
        <FlatList
          data={state.others}
          keyExtractor={(u) => u.userId}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + space.xl }]}
          ListHeaderComponent={(
            <View style={s.header}>
              <Pressable style={s.row} onPress={openMine} accessibilityRole="button" testID="stories-mine">
                <View style={[s.ring, state.mine && state.mine.stories.length > 0 ? s.ringOn : s.ringOff]}>
                  <AvatarImage uri={state.mine?.avatarUrl ?? null} size={avatar.s36} />
                </View>
                <View style={s.rowText}>
                  <Text style={s.strong}>Your story</Text>
                  <Text style={s.caption}>
                    {state.mineError ?? (state.mine && state.mine.stories.length > 0
                      ? `${state.mine.stories.length} live · tap to view, react to viewers or save to a highlight`
                      : 'Tap to post a story')}
                  </Text>
                </View>
              </Pressable>
              <Text style={s.section}>From people you follow and travel with</Text>
            </View>
          )}
          ListEmptyComponent={(
            <View style={s.empty} testID="stories-empty">
              <Text style={s.body}>No stories to see right now.</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <Pressable style={s.row} onPress={() => setViewing(item)} accessibilityRole="button" testID={`stories-user-${item.userId}`}>
              <View style={[s.ring, item.hasUnviewed ? s.ringOn : s.ringOff]}>
                <AvatarImage uri={item.avatarUrl} size={avatar.s36} />
              </View>
              <View style={s.rowText}>
                <Text style={s.strong} numberOfLines={1}>{primaryIdentityText({ name: item.name, handle: item.handle })}</Text>
                <Text style={s.caption}>{item.stories.length === 1 ? '1 story' : `${item.stories.length} stories`}</Text>
              </View>
            </Pressable>
          )}
        />
      )}

      <StoryViewer visible={viewing !== null} feedUser={viewing} onClose={() => setViewing(null)} />
      <StoryComposer visible={composerOpen} onClose={() => setComposerOpen(false)} onPosted={() => { setComposerOpen(false); void load(); }} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.md },
  title: { ...(t.bodyStrong as object), color: color.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  list: { paddingHorizontal: space.lg },
  header: { gap: space.md, marginBottom: space.sm },
  section: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  rowText: { flex: 1 },
  ring: { padding: 2, borderRadius: radius.pill, borderWidth: 2 },
  ringOn: { borderColor: color.signal },
  ringOff: { borderColor: color.haze },
  strong: { ...(t.bodyStrong as object), color: color.ink },
  body: { ...(t.body as object), color: color.mute, textAlign: 'center' },
  caption: { ...(t.small as object), color: color.mute },
  empty: { paddingVertical: space.xl, alignItems: 'center' },
  retry: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  retryText: { ...(t.bodyStrong as object), color: color.deep },
});
