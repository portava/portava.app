/**
 * Archive screen — an expired Highlight or Story is ARCHIVED, not gone.
 *
 * Reached from Passport → owner menu → Content → Archive.
 *
 * Two lists, one per content type, because their terms differ:
 *   - Highlights re-post on a term the owner picks, including "Never".
 *   - Stories re-post for a fixed 24 hours; there is no term to offer, so the
 *     screen does not pretend there is one.
 *
 * Owner-only by construction: both endpoints read the caller's own rows.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable,
  StyleSheet, Text, View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Archive as ArchiveIcon, RotateCcw, X } from 'lucide-react-native';
import { color, radius, space, type as t } from '../src/theme/tokens';
import { DisplayMediaImage } from '../src/components/ui/DisplayMediaImage';
import {
  HighlightTermChips,
  DEFAULT_HIGHLIGHT_TERM_HOURS,
  describeHighlightTerm,
} from '../src/components/highlights/HighlightTermChips';
import { fetchArchivedHighlights, repostHighlight, type Highlight } from '../src/services/highlights';
import { getArchivedStories, repostStory, type Story } from '../src/services/stories';
import { useNavBarScrollHandler, NavBarFiller } from '../src/hooks/useNavBarCollapse';

const PAGE_LIMIT = 50;
const THUMB = 56;

type Tab = 'highlights' | 'stories';

/** Relative "expired N ago" line. `null` is permanent — it never expired at all. */
function expiredLabel(expiresAt: string | null): string {
  if (expiresAt === null) return 'Always on your profile';
  const ms = Date.now() - new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) return 'Expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expired ${days} ${days === 1 ? 'day' : 'days'} ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `Expired ${hrs}h ago`;
  return 'Expired just now';
}

export default function ArchiveScreen() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [tab, setTab] = useState<Tab>('highlights');

  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed archive read is NOT an empty archive — the server returns an
  // error rather than [] precisely so this screen can say so.
  const [error, setError] = useState<string | null>(null);

  /** Highlight awaiting a term choice before it is re-posted. */
  const [termFor, setTermFor] = useState<Highlight | null>(null);
  const [term, setTerm] = useState<number | null>(DEFAULT_HIGHLIGHT_TERM_HOURS);
  const [reposting, setReposting] = useState<string | null>(null);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    if (which === 'highlights') {
      const res = await fetchArchivedHighlights(PAGE_LIMIT);
      setLoading(false);
      if (res.ok && res.data) setHighlights(res.data);
      else setError(res.message ?? 'Could not open your Highlights archive.');
    } else {
      const res = await getArchivedStories(PAGE_LIMIT);
      setLoading(false);
      if (res.ok) setStories(res.stories);
      else setError(res.message ?? 'Could not open your Stories archive.');
    }
  }, []);

  useEffect(() => { load(tab); }, [load, tab]);

  function openTermPicker(h: Highlight) {
    setTerm(DEFAULT_HIGHLIGHT_TERM_HOURS);
    setTermFor(h);
  }

  async function confirmHighlightRepost() {
    const target = termFor;
    if (!target) return;
    setReposting(target.id);
    const res = await repostHighlight(target.id, term);
    setReposting(null);
    if (!res.ok) {
      Alert.alert('Could not re-post', res.message ?? 'Please try again.');
      return;
    }
    setTermFor(null);
    // It is live again, so it is no longer part of the archive.
    setHighlights((list) => list.filter((h) => h.id !== target.id));
    Alert.alert(
      'Back on your profile',
      res.data?.permanent
        ? 'This Highlight is permanent — it will not expire.'
        : 'This Highlight is live again.',
    );
  }

  function handleStoryRepost(story: Story) {
    Alert.alert(
      'Re-post this Story?',
      'It goes back on your profile for 24 hours.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Re-post',
          onPress: async () => {
            setReposting(story.id);
            const res = await repostStory(story.id);
            setReposting(null);
            if (!res.ok) {
              Alert.alert('Could not re-post', res.message ?? 'Please try again.');
              return;
            }
            setStories((list) => list.filter((x) => x.id !== story.id));
          },
        },
      ],
    );
  }

  const empty = tab === 'highlights' ? highlights.length === 0 : stories.length === 0;

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.headerRow}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Archive</Text>
      </View>

      <View style={s.hero}>
        <ArchiveIcon size={28} color={color.mute} />
        <Text style={s.heroSub}>
          Highlights and Stories that expired are kept here. Only you can see them,
          and you can put any of them back.
        </Text>
      </View>

      <View style={s.tabRow}>
        {(['highlights', 'stories'] as Tab[]).map((value) => (
          <Pressable
            key={value}
            style={[s.tab, tab === value && s.tabOn]}
            onPress={() => setTab(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === value }}
          >
            <Text style={[s.tabText, tab === value && s.tabTextOn]}>
              {value === 'highlights' ? 'Highlights' : 'Stories'}
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
          <Pressable style={s.retryBtn} onPress={() => load(tab)}>
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : empty ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>Nothing archived yet</Text>
          <Text style={s.emptySub}>
            {tab === 'highlights'
              ? 'Highlights move here when their term runs out. Permanent ones never do.'
              : 'Stories move here 24 hours after you post them.'}
          </Text>
        </View>
      ) : tab === 'highlights' ? (
        <FlatList
          data={highlights}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={s.row}>
              <DisplayMediaImage
                uri={item.mediaThumbnailUrl ?? item.mediaUrl}
                width={THUMB}
                height={THUMB}
                style={s.thumb}
                fallbackLabel=""
                alt={item.caption ?? 'Archived highlight'}
              />
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle} numberOfLines={1}>
                  {item.caption?.trim() || item.locationName || 'Highlight'}
                </Text>
                <Text style={s.rowMeta}>{expiredLabel(item.expiresAt)}</Text>
              </View>
              <Pressable
                style={[s.repostBtn, reposting === item.id && { opacity: 0.4 }]}
                onPress={() => openTermPicker(item)}
                disabled={reposting === item.id}
                accessibilityRole="button"
                accessibilityLabel={`Re-post highlight ${item.caption ?? ''}`.trim()}
              >
                <RotateCcw size={13} color="#fff" />
                <Text style={s.repostText}>Re-post</Text>
              </Pressable>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          contentContainerStyle={{ paddingHorizontal: space.md }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
        />
      ) : (
        <FlatList
          data={stories}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
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
                <Text style={s.rowTitle} numberOfLines={1}>
                  {item.caption?.trim() || 'Story'}
                </Text>
                <Text style={s.rowMeta}>{expiredLabel(item.expires_at)}</Text>
              </View>
              <Pressable
                style={[s.repostBtn, reposting === item.id && { opacity: 0.4 }]}
                onPress={() => handleStoryRepost(item)}
                disabled={reposting === item.id}
                accessibilityRole="button"
                accessibilityLabel="Re-post story for 24 hours"
              >
                <RotateCcw size={13} color="#fff" />
                <Text style={s.repostText}>Re-post</Text>
              </Pressable>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          contentContainerStyle={{ paddingHorizontal: space.md }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
        />
      )}

      {/* Term picker — highlights only. Stories have a fixed 24h term. */}
      <Modal
        visible={termFor !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setTermFor(null)}
      >
        <View style={s.sheetRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setTermFor(null)} />
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Put this Highlight back</Text>
              <Pressable onPress={() => setTermFor(null)} hitSlop={8} accessibilityLabel="Cancel">
                <X size={18} color={color.ink} />
              </Pressable>
            </View>
            <Text style={s.fieldLabel}>Expires in</Text>
            <HighlightTermChips
              value={term}
              onChange={setTerm}
              disabled={reposting !== null}
              testID="archive-repost-term-chips"
            />
            <Text style={s.sheetHint}>{describeHighlightTerm(term)}</Text>
            <Pressable
              style={[s.submitBtn, reposting !== null && { opacity: 0.4 }]}
              onPress={confirmHighlightRepost}
              disabled={reposting !== null}
            >
              {reposting !== null
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={s.submitText}>Re-post Highlight</Text>}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: 4 },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.lg },
  heroSub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18, maxWidth: 300 },
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
  repostBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.pill },
  repostText: { ...t.small, fontWeight: '700', color: color.onInk, fontSize: 12 },
  sep: { height: 1, backgroundColor: color.haze },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: space.sm },
  sheetTitle: { ...t.heading, color: color.ink },
  fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
  sheetHint: { ...t.small, color: color.faint, fontSize: 11 },
  submitBtn: { marginTop: space.sm, backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  submitText: { ...t.bodyStrong, color: color.onInk },
});
