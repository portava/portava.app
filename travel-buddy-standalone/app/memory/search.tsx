/**
 * Memory Search — /memory/search
 *
 * Highlights/Memories Development Architecture Spec v1 §15 ("Memory Retrieval
 * and Search"). Census H110–H114.
 *
 * This is the MOUNT. All of the behaviour lives in
 * `src/features/memories/MemorySearchScreen.tsx`, which was complete and
 * tested and which nothing under `app/` referenced — so `POST
 * /api/memories/search` had a client and no person could reach it.
 *
 * THE INTENT IS NOT A NAMESPACE. This route always asks for `{ kind: 'mine' }`
 * and accepts no owner, namespace or projection id from its params. The server
 * derives all three from the authenticated viewer; a route that could name
 * somebody else's namespace would put one equality check on the server between
 * a stranger and a private timeline. `memorySearchApi.ts` states the same rule
 * at the request boundary and this screen does not weaken it.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, type as t } from '../../src/theme/tokens';
import { MemorySearchScreen } from '../../src/features/memories/MemorySearchScreen';

export default function MemorySearchRoute() {
  const insets = useSafeAreaInsets();

  return (
    <View style={s.screen}>
      <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Search memories</Text>
        {/* right spacer to balance the back arrow */}
        <View style={s.spacer} />
      </View>

      <MemorySearchScreen
        intent={{ kind: 'mine' }}
        onOpenMemory={(memoryId) => router.push(`/memory/${memoryId}` as never)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.md,
  },
  title: { ...t.bodyStrong, color: color.ink },
  spacer: { width: 22 },
});
