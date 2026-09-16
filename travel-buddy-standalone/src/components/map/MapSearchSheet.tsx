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

/**
 * A REFUSAL IS NOT AN EMPTY RESULT, and this sheet is where that distinction
 * either reaches a person or dies.
 *
 * `GET /discovery/search` answers an internal failure with HTTP **200** and a
 * `refusal` key naming what broke (`routes/discoverySearch.ts` sends
 * `transient_db`/`search_failed` and `transient_db`/`visibility_state_unreadable`
 * that way). `searchUnified` parses it and returns it on the SUCCESS arm —
 * correctly, because the request did succeed; the ANSWER is "we did not look".
 *
 * So `res.ok` is TRUE for a refused search, and branching on `res.ok` alone put
 * `results: []` through the empty state and told the person
 * *"Nothing matched …"* — a settled answer to a retryable failure, and the one
 * thing the owner ruling recorded at the top of `services/discovery.ts`
 * explicitly forbids ("A distinguishable response body alone is insufficient if
 * consumers still treat it as successful empty data").
 *
 * Three cases, kept apart because they have different right answers:
 *
 *   coverage "nothing"  nothing was searched. Suppress the empty state — there
 *                       is no "no results" fact to report — and say so.
 *   coverage "partial"  some of it WAS searched and those hits are real. Keep
 *                       them; discarding them is the opposite defect. Say the
 *                       answer is incomplete.
 *   saved lane only     §27's ninth heading is fetched separately and is
 *                       viewer-scoped. "We could not read your saves" and "none
 *                       of your saves matched" are different facts; the sheet
 *                       used to show only the second. The other eight headings
 *                       still answer — that part is the owner decision recorded
 *                       in `run` below and is not reversed here.
 */
interface SearchNotice {
  text: string;
  /** True when NOTHING was served, so "Nothing matched" would be a fabrication. */
  nothingServed: boolean;
}

const NOTICE_ALL_REFUSED =
  'Search couldn’t be run just now. This is not an empty result — try again in a moment.';
const NOTICE_PARTIAL = 'These results are incomplete — part of the search couldn’t be run.';
const NOTICE_SAVED_REFUSED =
  'Your saved items couldn’t be read, so they are missing from these results.';
/**
 * The saved shelf answered, but not from everything it is made of.
 *
 * Saves land in TWO tables — the wishlist and the Discovery bookmark — written
 * by two paths that never write each other's, so one can fail while the other
 * answers. The server used to serve the survivor's rows with no `refusal` at
 * all, and this sheet showed them under "Saved items" as if that were the whole
 * shelf. A person looking at their OWN saves and not finding one they made is
 * not looking at a search result; they are looking at a wrong answer they have
 * no way to identify. Distinct from NOTICE_SAVED_REFUSED because the facts are
 * different: there, none of the shelf was read; here, some of it was, and what
 * is on screen is real.
 */
const NOTICE_SAVED_PARTIAL =
  'Some of your saved items couldn’t be loaded, so this list may be missing a few.';

/** Join the lane notices into one line, dropping the absent ones. */
function noticeFor(
  allRefusedEverything: boolean,
  allPartial: boolean,
  savedFailed: boolean,
  savedPartial: boolean,
): SearchNotice | null {
  const parts = [
    allRefusedEverything ? NOTICE_ALL_REFUSED : allPartial ? NOTICE_PARTIAL : null,
    // `savedFailed` wins when both are somehow set: "none of it was read" is the
    // stronger and more urgent statement, and stacking both would say two
    // different things about one shelf in one line.
    savedFailed ? NOTICE_SAVED_REFUSED : savedPartial ? NOTICE_SAVED_PARTIAL : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return { text: parts.join(' '), nothingServed: allRefusedEverything };
}

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
  /** Set when the server REFUSED rather than failed. See `SearchNotice`. */
  const [notice, setNotice] = useState<SearchNotice | null>(null);

  // Guards against a slow early query overwriting a fast later one.
  const seqRef = useRef(0);

  const run = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      if (q.trim().length < MIN_QUERY_LENGTH) {
        setResults([]);
        setError(null);
        setNotice(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const opts = {
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        city: city ?? undefined,
      };
      // TWO REQUESTS, ON PURPOSE. §27's ninth heading is "Saved items", and it
      // is the only viewer-scoped type the search has: a person's own saves,
      // not a public corpus. It is deliberately absent from the server's `all`
      // fan-out, because that fan-out also feeds the app's one global search
      // and folding a private always-matching bucket into "All" everywhere is
      // an owner's call, not a side effect of lighting up a Map heading. So the
      // MAP asks for it, for the map's own sheet.
      const [res, savedRes] = await Promise.all([
        searchUnified(q, 'all', null, opts).catch(() => null),
        searchUnified(q, 'saved', null, opts).catch(() => null),
      ]);
      // A stale response must not replace a newer one.
      if (seq !== seqRef.current) return;
      setLoading(false);
      if (!res || !res.ok) {
        setError(res && !res.ok ? res.error : 'Search failed');
        setResults([]);
        setNotice(null);
        return;
      }
      setError(null);

      // A 200 CAN STILL BE A REFUSAL — see the SearchNotice block above. These
      // two booleans are the whole difference between "nothing matched" and
      // "nothing was searched", and they must be read off `data.refusal`
      // because `res.ok` is true in both cases.
      const allRefusal = res.data.refusal;
      const allRefusedEverything = allRefusal?.coverage === 'nothing';
      const allPartial = allRefusal?.coverage === 'partial';

      // The saved lane failing is NOT a search failure — the rest of §27 is
      // still a usable answer, and an error banner over eight good headings
      // because the ninth was unreachable would be the worse outcome. What it
      // IS, since 2026-09-14, is a fact the person has to be told: without the
      // notice below, an unreadable save set and an empty one are the same
      // screen.
      const savedFailed =
        !savedRes || !savedRes.ok || savedRes.data.refusal?.coverage === 'nothing';
      // The saved shelf can now be INCOMPLETE as well as absent: one of its two
      // source tables unreadable while the other answers. Its rows are real and
      // are kept — discarding them would be the opposite defect, the same one
      // the `all` lane's `partial` handling above exists to avoid — but the
      // person is told the list may be short. Before the server grew this
      // channel a single-table outage reached here as a plain 200 and was
      // indistinguishable from a complete shelf.
      const savedPartial =
        !savedFailed && savedRes !== null && savedRes.ok &&
        savedRes.data.refusal?.coverage === 'partial';
      const savedResults =
        savedRes && savedRes.ok && savedRes.data.refusal?.coverage !== 'nothing'
          ? savedRes.data.results
          : [];

      setNotice(noticeFor(allRefusedEverything, allPartial, savedFailed, savedPartial));
      // A `coverage: "nothing"` body carries no served results, so there is
      // nothing to keep; `partial` does, and they are kept.
      setResults(
        allRefusedEverything ? [] : toMapSearchResults([...res.data.results, ...savedResults]),
      );
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
      setNotice(null);
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

        {!error && notice ? (
          <Text style={styles.note} accessibilityLabel={notice.text}>
            {notice.text}
          </Text>
        ) : null}

        {/* `notice.nothingServed` is the guard that matters: with it absent,
            a refused search falls through to "Nothing matched", which claims a
            result set the server never produced. */}
        {!error &&
        !loading &&
        !notice?.nothingServed &&
        query.trim().length >= MIN_QUERY_LENGTH &&
        groups.length === 0 ? (
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
