import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../../context/SessionContext.tsx';
import { onAuthChange } from '../../services/auth.ts';
import { getLifeChapters, type LifeChaptersResult } from '../../services/memoryChapters.ts';
import { color, radius, space, type as typography } from '../../theme/tokens.ts';

type State = { ownerId: string; result: LifeChaptersResult } | null;

export function LifeChaptersScreen() {
  const { userId } = useSession();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>(null);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [observedAuth, setObservedAuth] = useState<{ userId: string | null } | null>(null);
  const ownerId = observedAuth && observedAuth.userId !== userId ? null : userId;
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => onAuthChange((nextUserId) => {
    generation.current++;
    activeRequest.current?.abort();
    setState(null);
    setExpanded(null);
    setObservedAuth({ userId: nextUserId });
    setReload((previous) => previous + 1);
  }), []);

  useFocusEffect(useCallback(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    setState(null);
    setExpanded(null);
    if (ownerId) {
      void getLifeChapters(controller.signal).then((result) => {
        if (generation.current === requestGeneration && !controller.signal.aborted) setState({ ownerId, result });
      });
    }
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [ownerId, reload]));

  const result = state?.ownerId === ownerId ? state.result : null;
  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.md }]} testID="life-chapters-screen">
      <View style={styles.heading}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back"><Text style={styles.link}>Back</Text></Pressable>
        <Text style={styles.title} accessibilityRole="header">Life Chapters</Text>
      </View>
      <Text style={styles.note}>Private to you. Chapters connect existing memories across trips and visits; they do not make copies.</Text>
      {!ownerId ? <Text style={styles.note}>Sign in to see your Life Chapters.</Text>
        : !result ? <ActivityIndicator accessibilityLabel="Loading Life Chapters" color={color.signal} />
          : !result.ok ? <View style={styles.message}>
            <Text style={styles.note}>{result.message}</Text>
            <Pressable onPress={() => setReload((previous) => previous + 1)} accessibilityRole="button" testID="chapters-retry"><Text style={styles.link}>Try again</Text></Pressable>
          </View>
            : <FlatList
              data={result.chapters}
              keyExtractor={(chapter) => chapter.id}
              contentContainerStyle={{ paddingBottom: insets.bottom + space.lg, gap: space.md }}
              ListHeaderComponent={result.recordedTimeCount > 0 ? <Text style={styles.note}>Some dates reflect when memories were recorded, not when they happened.</Text> : null}
              ListEmptyComponent={<Text style={styles.note}>No chapters yet. Recurring places and people will connect your memories here.</Text>}
              ListFooterComponent={result.truncated ? <Text style={styles.note}>Built from part of your history, not your complete lifetime.</Text> : null}
              renderItem={({ item, index }) => <View style={styles.card}>
                <Pressable onPress={() => setExpanded((current) => current === item.id ? null : item.id)} accessibilityRole="button" accessibilityState={{ expanded: expanded === item.id }} testID={`chapter-${index}`}>
                  <Text style={styles.title}>{item.kind === 'place' ? 'A place you return to' : 'A companion across visits'}</Text>
                  <Text style={styles.note}>{item.memoryIds.length} memories · {new Date(item.startedAt).getUTCFullYear()}–{new Date(item.endedAt).getUTCFullYear()}</Text>
                  <Text style={styles.link}>{expanded === item.id ? 'Hide memories' : 'Explore memories'}</Text>
                </Pressable>
                {expanded === item.id ? item.memoryIds.map((memoryId, memoryIndex) => <Pressable key={memoryId} style={styles.memory} accessibilityRole="button" onPress={() => router.push(`/memory/${memoryId}` as never)}>
                  <Text style={styles.link}>Open memory {memoryIndex + 1}</Text>
                </Pressable>) : null}
              </View>}
            />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.lg, gap: space.md, backgroundColor: color.paper },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  title: { ...(typography.bodyStrong as object), color: color.ink },
  note: { ...(typography.small as object), color: color.mute, marginVertical: space.xs },
  link: { ...(typography.bodyStrong as object), color: color.deep, paddingVertical: space.sm },
  message: { gap: space.sm },
  card: { padding: space.md, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, backgroundColor: color.paperRaised },
  memory: { borderTopWidth: 1, borderColor: color.haze },
});
