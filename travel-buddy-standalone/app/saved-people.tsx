/**
 * Saved people — the profiles I have saved (Save profile on /u/[username]).
 * TM-social, PLAT-F16.
 *
 * Reads GET /api/me/saves. The server has already dropped anyone in a block
 * relation with me (either direction) and fails closed when it cannot read the
 * block list; the client filters its own blocks context too, so a block made a
 * moment ago disappears without waiting for a refetch.
 *
 * States are true ones (DV-83): loading, "couldn't load" with a retry (never an
 * empty list), a real empty state, and the list. Unsave is reported when it
 * fails and the row stays.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { Bookmark, BookmarkX } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { Avatar } from '../src/components/ui/Avatar';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import { useBlockedIds } from '../src/context/BlockedIdsContext';
import { getMySavedProfiles, unsaveProfile, type SavedProfile } from '../src/services/saves';
import { primaryIdentityText } from '../src/lib/displayIdentity';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useNavBarScrollHandler, NavBarFiller } from '../src/hooks/useNavBarCollapse';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ok'; people: SavedProfile[] };

export default function SavedPeopleScreen() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const { blockedIds, blockerIds } = useBlockedIds();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [removing, setRemoving] = useState<string | null>(null);

  const fetchPeople = useCallback(async () => {
    setLoad({ state: 'loading' });
    const res = await getMySavedProfiles();
    setLoad(res.ok && res.data ? { state: 'ok', people: res.data } : { state: 'error' });
  }, []);

  useFocusEffect(useCallback(() => { void fetchPeople(); }, [fetchPeople]));

  async function unsave(p: SavedProfile) {
    if (removing) return;
    setRemoving(p.id);
    const res = await unsaveProfile(p.id);
    setRemoving(null);
    if (res.ok) {
      setLoad((prev) => (prev.state === 'ok' ? { state: 'ok', people: prev.people.filter((x) => x.id !== p.id) } : prev));
    } else {
      Alert.alert('Could not remove', res.error ?? 'They are still in your saved people. Please try again.');
    }
  }

  const people = load.state === 'ok'
    ? load.people.filter((p) => !blockedIds.has(p.id) && !blockerIds.has(p.id))
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Saved people" onBack={router.back} />
      {load.state === 'loading' ? (
        <View style={s.center} testID="saved-people-loading"><ActivityIndicator color={color.signal} /></View>
      ) : load.state === 'error' ? (
        <ErrorState message="We couldn't load your saved people." onRetry={() => { void fetchPeople(); }} />
      ) : people.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="No saved people yet"
          description="Tap Save profile in the menu on someone's profile to keep them here."
        />
      ) : (
        <FlatList
          data={people}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
          renderItem={({ item }) => {
            const label = primaryIdentityText({ name: item.name, handle: item.handle });
            return (
              <View style={s.row} testID={`saved-person-${item.id}`}>
                <Pressable
                  style={s.who}
                  onPress={() => router.push(`/u/${encodeURIComponent(item.handle || item.id)}` as never)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${label}'s profile`}
                >
                  <Avatar uri={item.avatarUrl} name={label.replace(/^@/, '')} size={44} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.name} numberOfLines={1}>{label}</Text>
                    {item.handle && label !== `@${item.handle}` ? (
                      <Text style={s.handle} numberOfLines={1}>@{item.handle}</Text>
                    ) : null}
                  </View>
                </Pressable>
                <Pressable
                  style={s.unsaveBtn}
                  onPress={() => { void unsave(item); }}
                  disabled={removing !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${label} from saved people`}
                  testID={`saved-person-remove-${item.id}`}
                >
                  {removing === item.id
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : <BookmarkX size={16} color={color.signal} />}
                </Pressable>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, padding: space.md,
  },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute },
  unsaveBtn: {
    padding: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper,
  },
});
