/**
 * Telegraph §21 — the search surface.
 *
 * §21's mockup is a bucket count followed by results:
 *     SEARCH "sky36"
 *     MESSAGES 3 / PLACES 1 / MEDIA 2 videos / PLANS 1 / MEMORIES 1
 * so the counts are the primary element, not a footnote: "there is one PLAN
 * about sky36" is the answer a traveller is usually looking for, and the list
 * underneath is how they get to it.
 *
 * census-telegraph T272: "There is no conversation search of any kind. The
 * inbox filter filters loaded threads client-side." This screen searches the
 * server, over conversations the server decides the caller may search.
 *
 * THREE EMPTY STATES, DELIBERATELY DISTINCT
 * =========================================
 * "Type at least two characters", "nothing matched", and "we could not search
 * everywhere" are three different facts and the screen says which. The third
 * is the one that matters: a degraded search that renders as "no results"
 * tells a person their own message does not exist. `degraded` comes straight
 * from the server and is rendered, not swallowed.
 *
 * A BOUNDED CONVERSATION IS EXPLAINED
 * ===================================
 * When some of the searched conversations carry a §14.3 history window, the
 * screen says so. Without that line, a member added to a trip chat last week
 * searches for something said last month, finds nothing, and concludes the
 * search is broken rather than that the window is working.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Search as SearchIcon, X } from 'lucide-react-native';

import { color, radius, space, typography } from '../../../theme/tokens.ts';
import { SEARCH_BUCKETS, type SearchBucket, type SearchHit, type SearchResult } from '../types/index.ts';
import { searchTelegraph, type TelegraphSearchError } from '../services/telegraphSearch.ts';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;

export interface TelegraphSearchScreenProps {
  /** Narrow to one conversation. Omit to search every authorized conversation. */
  conversationId?: string | null;
  /**
   * Prefill, for the inbox handoff: the inbox's own box filters threads that
   * are already loaded, and the row that opens this screen carries what the
   * person had typed so they do not type it twice.
   */
  initialQuery?: string;
  /** Tap handler for a result. */
  onOpenMessage?: (hit: SearchHit) => void;
  onClose?: () => void;
}

export function TelegraphSearchScreen({
  conversationId = null,
  initialQuery = '',
  onOpenMessage,
  onClose,
}: TelegraphSearchScreenProps) {
  const [query, setQuery] = useState(initialQuery);
  const [bucket, setBucket] = useState<SearchBucket | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<TelegraphSearchError | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const primed = useRef(false);

  const run = useCallback(
    async (q: string, b: SearchBucket | null) => {
      const mine = ++seq.current;
      setBusy(true);
      setError(null);
      const outcome = await searchTelegraph(q, {
        conversationId,
        buckets: b ? [b] : undefined,
      });
      // Out-of-order responses must not overwrite a newer one: a slow query for
      // "sk" landing after "sky36" would show the wrong results under the right
      // query, which is worse than showing none.
      if (mine !== seq.current) return;
      setBusy(false);
      if (!outcome.ok) { setResult(null); setError(outcome.error ?? 'server_error'); return; }
      setResult(outcome.result);
    },
    [conversationId],
  );

  const onChange = useCallback(
    (text: string) => {
      setQuery(text);
      if (timer.current) clearTimeout(timer.current);
      if (text.trim().length < MIN_QUERY) { setResult(null); setError(null); return; }
      timer.current = setTimeout(() => { void run(text, bucket); }, DEBOUNCE_MS);
    },
    [run, bucket],
  );

  const pickBucket = useCallback(
    (b: SearchBucket | null) => {
      setBucket(b);
      if (query.trim().length >= MIN_QUERY) void run(query, b);
    },
    [query, run],
  );

  // A prefilled query searches once on mount and never again from this effect,
  // so editing the box afterwards is governed by the debounce like any other
  // typing rather than by a second source of truth.
  React.useEffect(() => {
    if (primed.current) return;
    primed.current = true;
    if (initialQuery.trim().length >= MIN_QUERY) void run(initialQuery, null);
  }, [initialQuery, run]);

  const counts = result?.counts;
  const hits = result?.hits ?? [];

  const header = useMemo(() => {
    if (!counts) return null;
    return (
      <View testID="telegraph-search-counts" style={s.counts}>
        {SEARCH_BUCKETS.map((b) => (
          <Pressable
            key={b}
            testID={`telegraph-search-count-${b}`}
            accessibilityRole="button"
            onPress={() => pickBucket(bucket === b ? null : b)}
            style={[s.countChip, bucket === b && s.countChipActive]}
          >
            <Text style={[s.countLabel, bucket === b && s.countLabelActive]}>{b}</Text>
            <Text style={[s.countValue, bucket === b && s.countLabelActive]}>{counts[b] ?? 0}</Text>
          </Pressable>
        ))}
      </View>
    );
  }, [counts, bucket, pickBucket]);

  return (
    <View testID="telegraph-search-screen" style={s.root}>
      <View style={s.searchRow}>
        <SearchIcon size={16} color={color.mute} />
        <TextInput
          testID="telegraph-search-input"
          accessibilityLabel="Search conversations"
          value={query}
          onChangeText={onChange}
          placeholder={conversationId ? 'Search this conversation' : 'Search your conversations'}
          placeholderTextColor={color.faint}
          style={s.input}
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => { if (query.trim().length >= MIN_QUERY) void run(query, bucket); }}
        />
        {onClose && (
          <Pressable testID="telegraph-search-close" accessibilityLabel="Close search" onPress={onClose} hitSlop={10}>
            <X size={16} color={color.mute} />
          </Pressable>
        )}
      </View>

      {header}

      {busy && <ActivityIndicator testID="telegraph-search-busy" style={s.busy} color={color.signal} />}

      {/* Three distinct empty states — see the header. */}
      {!busy && query.trim().length < MIN_QUERY && (
        <Text testID="telegraph-search-hint" style={s.empty}>
          Type at least {MIN_QUERY} characters to search.
        </Text>
      )}

      {!busy && error !== null && (
        <Text testID="telegraph-search-error" style={s.empty}>
          {error === 'network_unreachable'
            ? "You're offline, so this searched nothing. Try again when you have a connection."
            : "Search isn't available right now."}
        </Text>
      )}

      {!busy && error === null && result !== null && result.degraded && (
        <Text testID="telegraph-search-degraded" style={s.degraded}>
          Some conversations couldn&apos;t be searched just now, so this list may be incomplete.
        </Text>
      )}

      {!busy && error === null && result !== null && !result.degraded && hits.length === 0 && (
        <Text testID="telegraph-search-no-results" style={s.empty}>
          Nothing matched &ldquo;{result.query}&rdquo;.
        </Text>
      )}

      {!busy && result !== null && result.conversationsBounded > 0 && (
        <Text testID="telegraph-search-bounded-note" style={s.note}>
          {result.conversationsBounded === 1
            ? 'One conversation only shows messages from after you joined.'
            : `${result.conversationsBounded} conversations only show messages from after you joined.`}
        </Text>
      )}

      <FlatList
        testID="telegraph-search-results"
        data={hits}
        keyExtractor={(h) => h.messageId}
        renderItem={({ item }) => (
          <Pressable
            testID={`telegraph-search-hit-${item.messageId}`}
            accessibilityRole="button"
            onPress={() => onOpenMessage?.(item)}
            style={s.hit}
          >
            <View style={s.hitHeader}>
              <Text style={s.hitBucket}>{item.bucket}</Text>
              <Text style={s.hitDate}>{new Date(item.createdAt).toLocaleDateString()}</Text>
            </View>
            {item.objectTitle && <Text style={s.hitTitle} numberOfLines={1}>{item.objectTitle}</Text>}
            <Text style={s.hitSnippet} numberOfLines={2}>{item.snippet}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper, paddingHorizontal: space.lg, paddingTop: space.md },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.paperRaised,
  },
  input: { flex: 1, ...(typography.caption as object), color: color.ink, paddingVertical: 2 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  countChip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: space.xs, backgroundColor: color.paperRaised,
  },
  countChipActive: { backgroundColor: color.ink, borderColor: color.ink },
  countLabel: { ...(typography.label as object), color: color.mute },
  countLabelActive: { color: color.onInk },
  countValue: { ...(typography.label as object), color: color.ink },
  busy: { marginTop: space.xl },
  empty: { ...(typography.caption as object), color: color.mute, marginTop: space.xl, textAlign: 'center' },
  degraded: { ...(typography.caption as object), color: color.warn, marginTop: space.md },
  note: { ...(typography.caption as object), color: color.faint, marginTop: space.sm },
  hit: {
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, gap: 2,
  },
  hitHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  hitBucket: { ...(typography.label as object), color: color.mute },
  hitDate: { ...(typography.caption as object), color: color.faint },
  hitTitle: { ...(typography.label as object), color: color.ink },
  hitSnippet: { ...(typography.caption as object), color: color.mute },
});

export default TelegraphSearchScreen;
