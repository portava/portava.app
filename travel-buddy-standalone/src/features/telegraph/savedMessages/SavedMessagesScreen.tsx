/**
 * Telegraph — Saved messages (WP-08 / TEL-F08).
 *
 * The READ half of "Save message". `saved_messages` had a writer on both chat
 * screens and a reader route (`GET /api/me/saved-messages`) that nothing
 * called, so a save went into a hole the person could never look into.
 *
 * WHAT IS SHOWN IS RE-AUTHORIZED, NOT REMEMBERED
 * ==============================================
 * The server applies, at read time, the same rules as reading the thread:
 * active membership, not deleted/unsent, and the §14.3 window. A save in a
 * conversation the person has since left, or of a message the sender unsent,
 * is withheld — the list is what they may see NOW, not what they once kept.
 * This screen adds no rule of its own and caches nothing.
 *
 * HONEST STATES (DV-83)
 * =====================
 *   loading — a spinner;
 *   error   — the reason and Try again. `getSavedMessages` reports every
 *             failure (including an unconfigured build) as `ok: false`, so a
 *             failed read can never render as "no saved messages";
 *   empty   — the read succeeded and returned nothing;
 *   list    — newest save first. Remove calls DELETE /api/me/saved-messages/:id,
 *             which is idempotent (`not_saved` is success) and never
 *             re-authorized, so a save you can no longer read can still be
 *             removed. A failed remove keeps the row and says so.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Bookmark } from 'lucide-react-native';
import { AppHeader } from '../../../components/ui/AppHeader.tsx';
import { NavBarFiller, useNavBarScrollHandler } from '../../../hooks/useNavBarCollapse.ts';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { getSavedMessages, unsaveSavedMessage, type SavedMessageItem } from '../../../services/messaging.ts';

type Phase = 'loading' | 'error' | 'ready';

/** What the row says instead of the text, when there is no plain text to show. */
export function savedPreview(item: SavedMessageItem): string {
  if (item.body && item.body.trim()) {
    const b = item.body.trim();
    // Structured envelopes (voice, places, plans) are JSON in `body`; never
    // print the raw envelope — it can carry a private storage key.
    if (b.startsWith('{') && b.includes('"kind"')) return 'Shared item';
    return b;
  }
  if (item.mediaType?.startsWith('image')) return 'Photo';
  if (item.mediaType?.startsWith('video')) return 'Video';
  if (item.mediaType?.startsWith('audio')) return 'Voice message';
  if (item.body === null && !item.mediaUrl) return 'Encrypted message — open the conversation to read it';
  return 'Message';
}

export function savedErrorCopy(code: string | undefined): string {
  if (code === 'network_unreachable') return 'You appear to be offline. Your saved messages were not loaded.';
  if (code === 'unauthenticated') return 'Please sign in again to see your saved messages.';
  return 'We could not load your saved messages right now.';
}

export function SavedMessagesScreen() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<SavedMessageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const r = await getSavedMessages();
    if (r.ok && r.data) {
      setItems(r.data.saved);
      setPhase('ready');
    } else {
      setItems([]);
      setError(savedErrorCopy(r.code));
      setPhase('error');
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const remove = useCallback(async (item: SavedMessageItem) => {
    setRemoving(item.messageId);
    const r = await unsaveSavedMessage(item.messageId);
    setRemoving(null);
    if (r.ok) setItems((prev) => prev.filter((m) => m.messageId !== item.messageId));
    else Alert.alert('Not removed', r.message ?? 'We could not remove that saved message. It is still saved.');
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Saved messages" onBack={router.back} />

      {phase === 'loading' ? (
        <View style={s.center} testID="saved-messages-loading">
          <ActivityIndicator color={color.signal} />
        </View>
      ) : phase === 'error' ? (
        <View style={s.center} testID="saved-messages-error">
          <Text style={s.empty}>{error}</Text>
          <Pressable style={s.btn} onPress={() => { void load(); }} accessibilityRole="button" testID="saved-messages-retry">
            <Text style={s.btnText}>Try again</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={s.center} testID="saved-messages-empty">
          <Bookmark size={32} color={color.haze} />
          <Text style={s.empty}>No saved messages</Text>
          <Text style={s.emptySub}>
            Long-press a message and choose Save message. Only you can see what you save.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(m) => m.messageId}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
          testID="saved-messages-list"
          renderItem={({ item }) => (
            <View style={s.row}>
              <Pressable
                style={s.info}
                onPress={() => router.push(`/messages/${item.threadId}` as never)}
                accessibilityRole="button"
                accessibilityLabel="Open the conversation"
                testID={`saved-message-${item.messageId}`}
              >
                <Text style={s.body} numberOfLines={3}>{savedPreview(item)}</Text>
                <Text style={s.meta}>Saved {new Date(item.savedAt).toLocaleDateString()}</Text>
              </Pressable>
              <Pressable
                style={s.removeBtn}
                onPress={() => { void remove(item); }}
                disabled={removing === item.messageId}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Remove from saved"
                testID={`saved-message-remove-${item.messageId}`}
              >
                {removing === item.messageId
                  ? <ActivityIndicator size="small" color={color.mute} />
                  : <Text style={s.removeText}>Remove</Text>}
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, paddingHorizontal: space.xl },
  empty: { ...t.bodyStrong, fontSize: 16, color: color.ink, textAlign: 'center' },
  emptySub: { fontSize: 13, color: color.mute, textAlign: 'center' },
  btn: { paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: color.signal },
  btnText: { ...t.bodyStrong, color: color.onInk },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  info: { flex: 1, gap: 4 },
  body: { ...t.body, color: color.ink },
  meta: { fontSize: 11, color: color.faint },
  removeBtn: {
    paddingHorizontal: space.md, paddingVertical: 7,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, minWidth: 72, alignItems: 'center',
  },
  removeText: { ...t.bodyStrong, fontSize: 13, color: color.mute },
});

export default SavedMessagesScreen;
