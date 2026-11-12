import React, { useCallback, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ChevronLeft, FolderPlus } from 'lucide-react-native';
import { getMySavedGems, type SavedGem } from '../services/collections.ts';
import { usePrivateSurfaceKey } from '../hooks/usePrivateSurfaceKey.ts';
import { color, space, type as t } from '../theme/tokens.ts';

type Props = { onBack: () => void; onOrganize?: (gemId: string) => void; revision?: number };
export function SavedGemsList(props: Props) {
  const scope = usePrivateSurfaceKey();
  return <SavedGemsForViewer key={scope} {...props} />;
}
function SavedGemsForViewer({ onBack, onOrganize, revision = 0 }: Props) {
  const [gems, setGems] = useState<SavedGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const load = useCallback(async (before?: string) => {
    if (busy.current && before) return;
    const request = ++generation.current;
    busy.current = true; setLoading(true); setError(false);
    if (!before) { setGems([]); setCursor(null); }
    const result = await getMySavedGems(before);
    if (request !== generation.current) return;
    busy.current = false; setLoading(false);
    if (!result.ok) { setError(true); return; }
    setCursor(result.nextCursor);
    setGems(old => before ? [...new Map([...old, ...result.gems].map(g => [g.id, g])).values()] : result.gems);
  }, []);
  useFocusEffect(useCallback(() => {
    void load();
    return () => { generation.current += 1; busy.current = false; };
  }, [load, revision]));
  return <View style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg }}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back"><ChevronLeft color={color.ink} /></Pressable>
      <Text style={t.heading}>Saved gems</Text>
    </View>
    <FlatList data={gems} keyExtractor={g => g.id} contentContainerStyle={{ padding: space.lg, gap: space.md }}
      renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Pressable disabled={!item.title} onPress={() => router.push(`/gems/${item.id}` as any)}
          accessibilityRole="button" style={{ flex: 1, paddingVertical: space.md }}>
          <Text style={t.bodyStrong}>{item.title ?? 'Gem unavailable'}</Text>
          {!item.title ? <Text style={t.small}>Deleted or no longer visible to you</Text> : null}
        </Pressable>
        {onOrganize ? <Pressable onPress={() => onOrganize(item.id)} accessibilityRole="button" accessibilityLabel={`Manage ${item.title ?? 'gem'} collections`} hitSlop={10}>
          <FolderPlus color={color.deep} size={22} />
        </Pressable> : null}
      </View>}
      ListEmptyComponent={!loading && !error ? <Text style={t.body}>No saved gems yet. Bookmark a gem to keep it here.</Text> : null}
      ListFooterComponent={loading ? <ActivityIndicator color={color.signal} /> : error
        ? <Pressable accessibilityRole="button" onPress={() => { void load(gems.length ? cursor ?? undefined : undefined); }}><Text style={t.bodyStrong}>Couldn't load saved gems. Tap to retry.</Text></Pressable>
        : cursor ? <Pressable accessibilityRole="button" onPress={() => { void load(cursor); }}><Text style={t.bodyStrong}>Load more gems</Text></Pressable> : null} />
  </View>;
}
