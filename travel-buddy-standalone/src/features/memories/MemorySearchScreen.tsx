/**
 * MemorySearchScreen — §15 retrieval, from a person's side.
 *
 * Highlights/Memories Development Architecture Spec v1 §15 ("Memory Retrieval
 * and Search"), §18 (derivatives are registered and revocable), §28.11 (never
 * swallow a failure into plausible-looking empty history).
 * Census H110–H114.
 *
 * ── WHAT THIS SCREEN IS CAREFUL ABOUT ──────────────────────────────────────
 *
 * 1. IT NEVER SAYS "NOTHING FOUND" FOR SOMETHING THAT IS NOT NOTHING. The
 *    three answers that are not an empty result — revoked, refused, and could
 *    not search — each render as themselves. §28.11 exists because a failure
 *    served as an empty page is indistinguishable from the truth, and on a
 *    person's own history that is the worst possible lie to tell.
 *
 * 2. IT SHOWS WHY A RESULT RANKED WHERE IT DID. The server sends §15's seven
 *    ranking dimensions per hit; the top contributor is rendered on the row.
 *    A list with no derivation is a list, not a ranking.
 *
 * 3. IT DOES NOT IMPLY AN UNDERSTANDING THE ENGINE DOES NOT HAVE. The server
 *    reports `semanticIndex: 'none'` — the scorer is deterministic token
 *    overlap and no model is called (census H111) — and the screen says so
 *    rather than presenting a box that looks like it understands sentences.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, Pressable, TextInput, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { Search, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  searchMemories as searchMemoriesApi,
  hitTitle, hitPlace, topDimension,
  type MemorySearchResult, type MemorySearchIntent, type MemorySearchPage,
} from './memorySearchApi.ts';

interface Props {
  /**
   * Whose memories. `mine` is the viewer's own; `public` is somebody else's
   * public derivative. The SERVER decides what each means — this is an intent,
   * not a namespace.
   */
  intent?: MemorySearchIntent;
  /** Injectable for tests; defaults to the real client. */
  search?: typeof searchMemoriesApi;
  onOpenMemory?: (memoryId: string) => void;
}

const DIMENSION_LABELS: Record<string, string> = {
  semantic_relevance: 'matches your words',
  temporal_relevance: 'close in time',
  spatial_relevance: 'near that place',
  person_relevance: 'the people in it',
  explicit_significance: 'you marked it',
  confidence: 'well recorded',
  privacy_eligibility: 'shareable',
};

export function MemorySearchScreen({ intent = { kind: 'mine' }, search = searchMemoriesApi, onOpenMemory }: Props) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<MemorySearchResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    const r = await search({ intent, query: text.trim() || null, limit: 50 });
    setResult(r);
    setBusy(false);
  }, [search, intent, text]);

  const page: MemorySearchPage | null = result?.state === 'ok' ? result.page : null;

  return (
    <View style={s.wrap} testID="memory-search-screen">
      <View style={s.searchRow}>
        <Search size={16} color={color.mute} />
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => void run()}
          placeholder="Search your memories"
          placeholderTextColor={color.faint}
          style={s.input}
          testID="memory-search-input"
          accessibilityLabel="Search your memories"
          returnKeyType="search"
        />
        <Pressable onPress={() => void run()} style={s.go} testID="memory-search-submit" accessibilityRole="button">
          <Text style={s.goText}>Search</Text>
        </Pressable>
      </View>

      {busy && <View style={s.pad} testID="memory-search-loading"><ActivityIndicator size="small" color={color.signal} /></View>}

      {!busy && result?.state === 'revoked' && (
        // §18 / H114. Not "no results" — these were removed from search by a
        // privacy decision or a deletion, and they are not coming back. A retry
        // button here would be a lie.
        <View style={s.notice} testID="memory-search-revoked">
          <AlertTriangle size={14} color={color.mute} />
          <Text style={s.noticeText}>{result.detail}</Text>
        </View>
      )}

      {!busy && result?.state === 'refused' && (
        <View style={s.notice} testID="memory-search-refused">
          <AlertTriangle size={14} color={color.mute} />
          <Text style={s.noticeText}>{result.detail}</Text>
        </View>
      )}

      {!busy && result?.state === 'unavailable' && (
        <View style={s.notice} testID="memory-search-unavailable">
          <AlertTriangle size={14} color={color.mute} />
          <Text style={s.noticeText}>We couldn’t search right now. {result.detail}</Text>
          <Pressable onPress={() => void run()} style={s.retry} accessibilityRole="button" testID="memory-search-retry">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {!busy && page && (
        <ScrollView contentContainerStyle={s.list} testID="memory-search-results">
          <Text style={s.meta} testID="memory-search-meta">
            {page.deterministicMatchCount} matched
            {page.semanticRerankApplied ? ' · reordered by your words' : ''}
          </Text>
          {page.capabilities?.semanticIndex === 'none' && (
            // H111, said out loud rather than implied away.
            <Text style={s.metaFaint} testID="memory-search-engine-note">
              Matching is by exact words and filters — there’s no AI reading your memories.
            </Text>
          )}

          {page.hits.length === 0 ? (
            <Text style={s.empty} testID="memory-search-empty">Nothing matched that search.</Text>
          ) : (
            page.hits.map((h) => {
              const top = topDimension(h, page.capabilities?.rankingWeights);
              const place = hitPlace(h);
              return (
                <Pressable
                  key={h.memoryId}
                  onPress={() => onOpenMemory?.(h.memoryId)}
                  style={s.row}
                  testID={`memory-search-hit-${h.memoryId}`}
                  accessibilityRole="button"
                >
                  <Text style={s.rowTitle}>{hitTitle(h)}</Text>
                  {place && <Text style={s.rowSub}>{place}</Text>}
                  {top && (
                    <Text style={s.rowWhy} testID={`memory-search-why-${h.memoryId}`}>
                      {DIMENSION_LABELS[top.name] ?? top.name}
                    </Text>
                  )}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  input: { flex: 1, ...t.body, color: color.ink, paddingVertical: space.xs },
  go: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: color.signal },
  goText: { ...t.bodyStrong, color: color.paper, fontSize: 13 },
  pad: { padding: space.xl, alignItems: 'center' },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap',
    marginHorizontal: space.lg, padding: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
  },
  noticeText: { ...t.small, color: color.mute, flexShrink: 1 },
  retry: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  retryText: { ...t.bodyStrong, color: color.ink, fontSize: 12 },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.sm },
  meta: { ...t.small, color: color.mute },
  metaFaint: { ...t.small, color: color.faint, fontSize: 11, marginBottom: space.xs },
  empty: { ...t.body, color: color.mute, paddingVertical: space.lg },
  row: { paddingVertical: space.sm, gap: 2 },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  rowSub: { ...t.small, color: color.mute, fontSize: 12 },
  rowWhy: { ...t.small, color: color.faint, fontSize: 11 },
});
