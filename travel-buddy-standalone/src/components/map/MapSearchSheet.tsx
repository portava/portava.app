/**
 * MapSearchSheet — §27 Search.
 *
 * Spec §27 lists nine searchable things — Places, Events, Trips, Users,
 * Buddies, Hidden Gems, Areas, Hashtags, Saved items — and one behavioural
 * rule: "Geographic results should center or frame the relevant map object."
 *
 * That rule is the reason this is a map surface rather than a link list. Every
 * result renders, but only some can move the camera, and the difference is
 * shown rather than hidden: a result the map cannot place is marked, so tapping
 * it navigating instead of flying is expected rather than a bug.
 *
 * The sheet owns no decisions. Grouping and ordering come from
 * `mapSearchModel.groupResults` (group order is §27's own list, deliberately
 * NOT relevance-ranked, so the sections do not reshuffle on every keystroke),
 * translation comes from `searchAdapter`, and framing comes from `frameFor`.
 *
 * Dark-mode-first (§4) via the shared map-chrome palette.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, Search as SearchIcon, X as XIcon } from 'lucide-react-native';
import { mapChrome } from '../../theme/mapChrome.ts';
import { space, radius, type as t } from '../../theme/tokens.ts';
import { searchUnified } from '../../services/discovery.ts';
import { toMapSearchResults } from '../../features/map/search/searchAdapter.ts';
import {
  frameFor,
  groupResults,
  isGeographic,
  type MapCameraFrame,
  type MapSearchResult,
} from '../../features/map/search/mapSearchModel.ts';

/** How long after the last keystroke a query is issued. */
const DEBOUNCE_MS = 300;
/** Shorter than this and the result set is noise, not a search. */
const MIN_QUERY_LENGTH = 2;

export interface MapSearchSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Where to search around. Absent is fine — the server ranks without it. */
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  /**
   * A result was chosen. `frame` is `{ kind: 'none' }` when the result has no
   * geometry — the caller must NOT move the camera in that case.
   */
  onSelect: (result: MapSearchResult, frame: MapCameraFrame) => void;
}

export function MapSearchSheet({
  visible,
  onClose,
  lat,
  lng,
  city,
  onSelect,
}: MapSearchSheetProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MapSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow early query overwriting a fast later one.
  const seqRef = useRef(0);

  const run = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      if (q.trim().length < MIN_QUERY_LENGTH) {
        setResults([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const res = await searchUnified(q, 'all', null, {
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        city: city ?? undefined,
      }).catch(() => null);
      // A stale response must not replace a newer one.
      if (seq !== seqRef.current) return;
      setLoading(false);
      if (!res || !res.ok) {
        setError(res && !res.ok ? res.error : 'Search failed');
        setResults([]);
        return;
      }
      setError(null);
      setResults(toMapSearchResults(res.data.results));
    },
    [lat, lng, city],
  );

  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, visible, run]);

  // Reset on close so reopening is not haunted by the last search.
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [visible]);

  const groups = useMemo(
    // preferGeographic sinks results the map cannot place, so a search from a
    // MAP surface leads with what it can actually show. Group ORDER stays §27's
    // fixed list — only the order within a group moves.
    () => groupResults(results, { preferGeographic: true }),
    [results],
  );

  if (!visible) return null;

  return (
    <View style={[styles.sheet, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.searchRow}>
        <SearchIcon size={16} color={mapChrome.textOnDarkMute} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Places, events, people, areas, #tags"
          placeholderTextColor={mapChrome.textOnDarkFaint}
          autoFocus
          returnKeyType="search"
          onSubmitEditing={() => void run(query)}
          accessibilityLabel="Search the map"
        />
        {loading ? <ActivityIndicator size="small" color={mapChrome.textOnDarkMute} /> : null}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close search"
        >
          <XIcon size={18} color={mapChrome.textOnDarkMute} />
        </Pressable>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {error ? <Text style={styles.note}>{error}</Text> : null}

        {!error && !loading && query.trim().length >= MIN_QUERY_LENGTH && groups.length === 0 ? (
          <Text style={styles.note}>Nothing matched “{query.trim()}”.</Text>
        ) : null}

        {groups.map((group) => (
          <View key={group.type} style={styles.group}>
            <Text style={styles.groupLabel}>{group.label.toUpperCase()}</Text>
            {group.results.map((r) => {
              const geographic = isGeographic(r);
              return (
                <Pressable
                  key={`${r.type}:${r.id}`}
                  style={styles.row}
                  onPress={() => onSelect(r, frameFor(r))}
                  accessibilityRole="button"
                  accessibilityLabel={
                    geographic ? `${r.title}, show on map` : `${r.title}, open details`
                  }
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {r.title}
                    </Text>
                    {r.subtitle ? (
                      <Text style={styles.rowSubtitle} numberOfLines={1}>
                        {r.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  {/* The pin is the honest signal that this one can move the
                      camera. Its absence is not a missing icon — it means the
                      result has no geometry and tapping will navigate instead. */}
                  {geographic ? (
                    <MapPin size={14} color={mapChrome.textOnDarkMute} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: mapChrome.surface,
    paddingHorizontal: space.md,
    zIndex: 40,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: mapChrome.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairline,
  },
  input: {
    flex: 1,
    minHeight: 40,
    color: mapChrome.textOnDark,
    ...t.body,
  },
  list: { marginTop: space.md },
  group: { marginBottom: space.lg },
  groupLabel: {
    ...t.small,
    color: mapChrome.textOnDarkMute,
    letterSpacing: 0.8,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairlineFaint,
  },
  rowText: { flex: 1 },
  rowTitle: { ...t.body, color: mapChrome.textOnDark },
  rowSubtitle: { ...t.small, color: mapChrome.textOnDarkMute },
  note: { ...t.body, color: mapChrome.textOnDarkMute, marginTop: space.md },
});

export default MapSearchSheet;
