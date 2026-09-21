/**
 * Telegraph §6.4 — the content drawer, and object-aware search.
 *
 *   MEDIA | PLACES | PORTAVA | VOICE | GIFS | LINKS | FILES
 *
 *   "The content drawer is a structured index over exchanged content, not a
 *    second storage copy. Object-aware search must respect current
 *    authorization and unsent/deleted state."
 *
 * THE ENTRY POINT USED TO BE DEAD CODE. `app/messages/[id].tsx` carried
 * `{false ? <Pressable … onPress={() => Alert.alert('Thread info', '… coming
 * soon.')}> : null}` — the affordance existed behind a literal `false`, with
 * no route and no service behind it. This sheet is what goes there.
 *
 * INDEX, NOT COPY: every row rendered here is a `messages.id` the thread
 * already has, fetched from `GET /threads/:id/drawer`, which stores nothing.
 * The server says so in its own response (`indexOnly: true`) and this sheet
 * shows the count it was given rather than keeping its own.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  DRAWER_TABS,
  fetchDrawer,
  searchThread,
  type DrawerItem,
  type DrawerResponse,
  type DrawerTab,
  type SearchResult,
} from '../kinds/kindsApi.ts';

export interface ContentDrawerSheetProps {
  visible: boolean;
  threadId: string;
  onClose: () => void;
  onOpenMessage?: (messageId: string) => void;
  /** Test seam: skip the fetch and render this. */
  initialDrawer?: DrawerResponse | null;
}

export function ContentDrawerSheet({
  visible,
  threadId,
  onClose,
  onOpenMessage,
  initialDrawer = null,
}: ContentDrawerSheetProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [tab, setTab] = useState<DrawerTab | null>(null);
  const [drawer, setDrawer] = useState<DrawerResponse | null>(initialDrawer);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(
    async (nextTab: DrawerTab | null) => {
      setLoading(true);
      const r = await fetchDrawer(threadId, nextTab);
      if (r.ok) {
        setDrawer(r.data);
        setFailed(false);
      } else {
        // "We could not read it" is not "there is nothing here".
        setFailed(true);
      }
      setLoading(false);
    },
    [threadId],
  );

  useEffect(() => {
    if (!visible || initialDrawer !== null) return;
    void load(tab);
  }, [visible, tab, load, initialDrawer]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const r = await searchThread(threadId, q, tab);
    setResults(r.ok ? r.data.results : []);
    setSearching(false);
  }, [query, tab, threadId]);

  const counts = drawer?.counts ?? null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="telegraph-content-drawer">
          <View style={styles.headerRow}>
            <Text style={styles.heading}>Shared in this conversation</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </View>

          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={runSearch}
            placeholder="Search this conversation"
            placeholderTextColor={palette.mute}
            style={styles.search}
            accessibilityLabel="Search this conversation"
            testID="telegraph-drawer-search-input"
            returnKeyType="search"
          />

          <View style={styles.tabRow}>
            <TabChip
              label="ALL"
              active={tab === null}
              count={null}
              onPress={() => { setTab(null); setResults(null); }}
              styles={styles}
            />
            {DRAWER_TABS.map((name) => (
              <TabChip
                key={name}
                label={name}
                active={tab === name}
                count={counts ? counts[name] : null}
                onPress={() => { setTab(name); setResults(null); }}
                styles={styles}
              />
            ))}
          </View>

          {loading || searching ? (
            <View style={styles.center} accessibilityLabel="Loading shared content">
              <ActivityIndicator size="small" color={palette.operational} />
            </View>
          ) : null}

          {failed ? (
            <Text style={styles.empty} testID="telegraph-drawer-failed">
              We could not read this conversation’s content. Try again.
            </Text>
          ) : null}

          {!failed && results !== null ? (
            <FlatList
              testID="telegraph-drawer-results"
              data={results}
              keyExtractor={(r) => r.id}
              ListEmptyComponent={<Text style={styles.empty}>No matches</Text>}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open message: ${item.snippet}`}
                  onPress={() => onOpenMessage?.(item.id)}
                  style={styles.row}
                >
                  <Text style={styles.rowTab}>{item.tab ?? 'TEXT'}</Text>
                  <Text style={styles.rowTitle} numberOfLines={2}>{item.snippet}</Text>
                </Pressable>
              )}
            />
          ) : null}

          {!failed && results === null ? (
            <FlatList
              testID="telegraph-drawer-items"
              data={drawer?.items ?? []}
              keyExtractor={(i: DrawerItem) => i.id}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {drawer ? 'Nothing shared here yet' : ''}
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.tab}: ${item.title ?? 'item'}`}
                  onPress={() => onOpenMessage?.(item.id)}
                  style={styles.row}
                >
                  <Text style={styles.rowTab}>{item.tab}</Text>
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {item.links.length > 0 ? item.links[0] : (item.title ?? item.msgType)}
                  </Text>
                </Pressable>
              )}
            />
          ) : null}

          {drawer?.truncated ? (
            <Text style={styles.empty} testID="telegraph-drawer-truncated">
              Showing the most recent {drawer.scanned} messages
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function TabChip({
  label,
  active,
  count,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  count: number | null;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count === null ? label : `${label}, ${count}`}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
      testID={`telegraph-drawer-tab-${label}`}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>
        {count === null ? label : `${label} ${count}`}
      </Text>
    </Pressable>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: p.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space.xl,
      maxHeight: '80%',
      gap: space.sm,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    heading: { ...t.body, color: p.recvText, fontWeight: '800' },
    close: { ...t.small, color: p.operational, fontWeight: '700' },
    search: {
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.hairline,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: 8,
      color: p.recvText,
    },
    tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: p.chipFill,
    },
    chipActive: { backgroundColor: p.operational },
    chipText: { ...t.small, color: p.mute },
    chipTextActive: { color: p.operationalOn, fontWeight: '700' },
    center: { paddingVertical: space.lg, alignItems: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.hairline,
    },
    rowTab: { ...t.small, color: p.mute, width: 72 },
    rowTitle: { ...t.small, color: p.recvText, flexShrink: 1 },
    empty: { ...t.small, color: p.mute, paddingVertical: space.md },
  });
}

export default ContentDrawerSheet;
