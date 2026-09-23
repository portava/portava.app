/**
 * Story archive — the owner's own expired stories, and the ones they deleted
 * recently enough to get back.
 *
 * Reached from Passport → owner menu → Content → Story Archive.
 *
 * Owner ruling 2026-09-22, decision 5: build the owner archive, with viewing,
 * deletion, the recovery flow and clear retention dates. This is that screen,
 * and there is only one of it.
 *
 * ── TWO TABS, BECAUSE THEY ARE TWO DIFFERENT STATES ──────────────────────────
 * "Archive" holds stories whose 24 hours ran out. They are the owner's to keep,
 * re-post or delete.
 *
 * "Recently deleted" holds stories the owner deleted and can still restore. It
 * is a separate tab rather than a section of the first, because decision 2 says
 * a deleted story leaves normal access IMMEDIATELY — mixing them would make
 * "deleted" a label on an archive row rather than a state the story is in.
 *
 * ── EVERY DATE COMES FROM THE SERVER ─────────────────────────────────────────
 * No retention arithmetic happens on this screen. The server sends each row's
 * dates alongside it, computed by the same function the hourly purge asks, so a
 * row cannot say "kept until March" while the job deletes it in January. This
 * screen only turns those dates into words.
 *
 * ── A FAILED READ IS NOT AN EMPTY ARCHIVE ────────────────────────────────────
 * The one thing this screen must never do is answer an outage with "nothing
 * here", which reads as "your stories are gone". Both endpoints return an error
 * rather than an empty list for exactly that reason, and both tabs render an
 * explicit unavailable state with a retry.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Archive as ArchiveIcon, RotateCcw, Trash2, Undo2 } from 'lucide-react-native';
import { color, radius, space, type as t } from '../src/theme/tokens.ts';
import { DisplayMediaImage } from '../src/components/ui/DisplayMediaImage.tsx';
import { useNavBarScrollHandler, NavBarFiller } from '../src/hooks/useNavBarCollapse.ts';
import { deleteStory } from '../src/services/stories.ts';
import {
  getStoryArchive,
  getRecoverableStories,
  recoverStory,
  repostStory,
  archiveRowRetentionLabel,
  recoveryRowLabel,
  type ArchivedStory,
} from '../src/services/storyArchive.ts';
import {
  fetchStoryRetentionPolicy,
  archiveRetentionLine,
  retentionUnavailableLine,
  recoveryImminentPurgeLine,
  type StoryRetentionResult,
} from '../src/services/storyRetentionPolicy.ts';

const PAGE_LIMIT = 50;
const THUMB = 56;

type Tab = 'archive' | 'deleted';

/** "Expired 3 days ago" — how long ago the audience stopped seeing it. */
function expiredLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Expired';
  const ms = Date.now() - Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 'Expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expired ${days} ${days === 1 ? 'day' : 'days'} ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `Expired ${hrs}h ago`;
  return 'Expired just now';
}

export default function StoryArchiveScreen() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [tab, setTab] = useState<Tab>('archive');
  const [rows, setRows] = useState<ArchivedStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The policy line at the top of the archive. Same rule as the composer: when
  // it cannot be read the screen says so rather than going quiet, because a
  // silent absence reads as "there is no retention" rather than "we could not
  // check".
  const [policy, setPolicy] = useState<StoryRetentionResult | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const loadPolicy = useCallback(() => {
    setPolicyLoading(true);
    void fetchStoryRetentionPolicy().then((r) => { setPolicy(r); setPolicyLoading(false); });
  }, []);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    const res = which === 'archive'
      ? await getStoryArchive(PAGE_LIMIT)
      : await getRecoverableStories(PAGE_LIMIT);
    setLoading(false);
    if (res.ok) { setRows(res.stories); return; }
    // The rows are cleared as well as the error set: leaving the previous tab's
    // rows on screen under an error banner shows content that may no longer be
    // there and invites acting on it.
    setRows([]);
    setError(res.message);
  }, []);

  useEffect(() => { load(tab); }, [load, tab]);
  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  function handleRepost(story: ArchivedStory) {
    Alert.alert(
      'Post this story again?',
      'It goes back up for 24 hours, and everyone who could see it the first time can see it again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Post again',
          onPress: async () => {
            setBusy(story.id);
            const res = await repostStory(story.id);
            setBusy(null);
            if (!res.ok) { Alert.alert('Could not post it again', res.message); return; }
            // It is live again, so it is no longer archive content.
            setRows((list) => list.filter((r) => r.id !== story.id));
          },
        },
      ],
    );
  }

  function handleDelete(story: ArchivedStory) {
    Alert.alert(
      'Delete this story?',
      'It leaves your archive now. You can restore it from Recently deleted for a limited time, after which it is permanently deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(story.id);
            const res = await deleteStory(story.id);
            setBusy(null);
            if (!res.ok) {
              // deleteStory reports the state it actually achieved. Removing the
              // row from the list on a failure would tell the owner a deletion
              // happened that did not.
              Alert.alert('Could not delete it', res.message ?? 'Please try again.');
              return;
            }
            setRows((list) => list.filter((r) => r.id !== story.id));
          },
        },
      ],
    );
  }

  async function handleRecover(story: ArchivedStory) {
    setBusy(story.id);
    const res = await recoverStory(story.id);
    setBusy(null);
    if (!res.ok) {
      if (res.windowClosed) {
        // Nothing to retry. The row goes, because it is no longer recoverable
        // and leaving the button there would offer the same refusal again.
        setRows((list) => list.filter((r) => r.id !== story.id));
        Alert.alert('Too late to restore', res.message);
        return;
      }
      Alert.alert('Could not restore it', res.message);
      return;
    }
    setRows((list) => list.filter((r) => r.id !== story.id));
    Alert.alert(
      'Restored',
      res.purgeImminent
        ? recoveryImminentPurgeLine()
        : 'It is back in your archive. Only you can see it — restoring a story does not post it again.',
    );
  }

  const policyLine =
    policy?.status === 'ok' ? archiveRetentionLine(policy.policy) : null;

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.headerRow}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Story Archive</Text>
      </View>

      <View style={s.hero}>
        <ArchiveIcon size={28} color={color.mute} />
        {policyLine ? (
          <Text style={s.heroSub}>{policyLine}</Text>
        ) : policy?.status === 'unavailable' ? (
          <View style={s.policyUnavailable}>
            <Text style={s.policyUnavailableText}>{retentionUnavailableLine(policy.reason)}</Text>
            <Pressable
              onPress={loadPolicy}
              disabled={policyLoading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry loading retention policy"
            >
              {policyLoading
                ? <ActivityIndicator size="small" color={color.signal} />
                : <Text style={s.policyRetryText}>Retry</Text>}
            </Pressable>
          </View>
        ) : (
          <Text style={s.heroSub}>Checking how long your stories are kept…</Text>
        )}
      </View>

      <View style={s.tabRow}>
        {(['archive', 'deleted'] as Tab[]).map((value) => (
          <Pressable
            key={value}
            style={[s.tab, tab === value && s.tabOn]}
            onPress={() => setTab(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === value }}
          >
            <Text style={[s.tabText, tab === value && s.tabTextOn]}>
              {value === 'archive' ? 'Archive' : 'Recently deleted'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={color.deep} style={{ flex: 1 }} />
      ) : error ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>Archive unavailable</Text>
          <Text style={s.emptySub}>{error}</Text>
          <Pressable style={s.retryBtn} onPress={() => load(tab)} accessibilityRole="button">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>
            {tab === 'archive' ? 'Nothing archived yet' : 'Nothing to restore'}
          </Text>
          <Text style={s.emptySub}>
            {tab === 'archive'
              ? 'Stories move here 24 hours after you post them. Only you can see them.'
              : 'Stories you delete appear here while you can still get them back.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const working = busy === item.id;
            const retentionLabel = tab === 'archive'
              ? archiveRowRetentionLabel(item.retention)
              : recoveryRowLabel(item.retention);
            return (
              <View style={s.row}>
                <DisplayMediaImage
                  uri={item.media_url}
                  width={THUMB}
                  height={THUMB}
                  style={s.thumb}
                  fallbackLabel=""
                  alt={item.caption ?? 'Archived story'}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{item.caption?.trim() || 'Story'}</Text>
                  <Text style={s.rowMeta}>{expiredLabel(item.expires_at)}</Text>
                  {/* Null means the server promised no purge date — a story whose
                      media belongs to a Highlight. The row stays silent rather
                      than inventing one. */}
                  {retentionLabel ? <Text style={s.rowRetention}>{retentionLabel}</Text> : null}
                </View>
                {tab === 'archive' ? (
                  <View style={s.actions}>
                    <Pressable
                      style={[s.iconBtn, working && s.dim]}
                      onPress={() => handleDelete(item)}
                      disabled={working}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Delete this story"
                    >
                      <Trash2 size={16} color={color.signal} />
                    </Pressable>
                    <Pressable
                      style={[s.primaryBtn, working && s.dim]}
                      onPress={() => handleRepost(item)}
                      disabled={working}
                      accessibilityRole="button"
                      accessibilityLabel="Post this story again for 24 hours"
                    >
                      {working
                        ? <ActivityIndicator size="small" color={color.onInk} />
                        : <><RotateCcw size={13} color={color.onInk} /><Text style={s.primaryText}>Post again</Text></>}
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    style={[s.primaryBtn, working && s.dim]}
                    onPress={() => handleRecover(item)}
                    disabled={working}
                    accessibilityRole="button"
                    accessibilityLabel="Restore this story to your archive"
                  >
                    {working
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <><Undo2 size={13} color={color.onInk} /><Text style={s.primaryText}>Restore</Text></>}
                  </Pressable>
                )}
              </View>
            );
          }}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          contentContainerStyle={{ paddingHorizontal: space.md }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: 4 },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.lg },
  heroSub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18, maxWidth: 320 },
  policyUnavailable: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: '#FFF0EE', borderRadius: radius.md, padding: space.md, maxWidth: 340 },
  policyUnavailableText: { flex: 1, ...t.small, color: color.signal, fontSize: 12 },
  policyRetryText: { ...t.small, color: color.signal, fontWeight: '700' },
  tabRow: { flexDirection: 'row', gap: 6, paddingHorizontal: space.md, paddingBottom: space.md },
  tab: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  tabOn: { backgroundColor: color.signal, borderColor: color.signal },
  tabText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  tabTextOn: { color: color.onInk },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl },
  emptyText: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: { marginTop: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  retryText: { ...t.small, fontWeight: '700', color: color.onInk },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm, backgroundColor: color.haze },
  rowTitle: { ...t.bodyStrong, color: color.ink },
  rowMeta: { ...t.small, color: color.mute },
  rowRetention: { ...t.small, color: color.faint, fontSize: 11, marginTop: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconBtn: { padding: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.pill, minWidth: 92, justifyContent: 'center' },
  primaryText: { ...t.small, fontWeight: '700', color: color.onInk, fontSize: 12 },
  dim: { opacity: 0.4 },
  sep: { height: 1, backgroundColor: color.haze },
});
