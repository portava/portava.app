/**
 * MediaSearchScreen — the §4 "Media Search" screen (spec §4 / §38 / §40;
 * census-media §19).
 *
 * The client of `GET /media/search`. It asks only through `mediaFilterStore`
 * (so a criteria-free state never becomes a request, and a trip scope with no
 * trip is not sent), and it renders all seven §38 result types — Media,
 * Places, Hidden Gems, Events, Trips, Experiences, People — each only when the
 * server returned it.
 *
 * Three honesty rules it keeps on the screen, not just in the payload:
 *   • a list the server could not READ (`undetermined`) is labelled "could not
 *     be checked", never shown as "no results";
 *   • what search cannot answer at all (`unsupported`, e.g. "find places that
 *     look like this") is stated under the results, not implied away;
 *   • "Where was this photo taken?" (a `mediaId` query) answers with the coarse
 *     place the disclosure choke point allows, and nothing finer.
 *
 * `initialScope: 'me'` makes this "Search my world" (§30): only the viewer's
 * own media, through the loader's owner path.
 *
 * The §38 example queries are askable as the server answers them: "Show my
 * Bangkok rooftop photos" is the term plus the separate city criterion under
 * `scope=me`; "Show festival media from my Vietnam Trip" is a Trip result
 * searched WITHIN (`scope=trip` + that trip's id, gated server-side).
 */
import React, { useCallback, useMemo, useReducer, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Search, MapPin, Calendar, Plane, Users } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { MediaProjection } from '../types/media.ts';
import type { MediaSearchResultsView, SearchCanonicalResult } from '../types/mediaSearchResults.ts';
import { fetchMediaSearch, isMediaSearchEmpty } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import {
  INITIAL_MEDIA_FILTERS,
  SEARCH_CATEGORIES,
  mediaFilterReducer,
  toSearchQueryString,
  type MediaSearchScope,
} from '../state/mediaFilterStore.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaSearchScreenProps {
  /** 'me' ⇒ Search my world (§30). 'trip' requires `tripId`. */
  initialScope?: MediaSearchScope;
  tripId?: string | null;
  /** The viewer's coarse city, offered as a "Near <city>" filter — never applied silently. */
  nearCity?: string | null;
  /** §38 "Where was this photo taken?" — resolve this media id to its coarse place. */
  mediaId?: string | null;
  initialQuery?: string;
  /** Hide the scope toggle (My World embeds a fixed `me` scope). */
  fixedScope?: boolean;
  onOpenMedia?: (media: MediaProjection) => void;
  onOpenPlace?: (placeId: string) => void;
  onOpenGem?: (gemId: string) => void;
  onOpenExperience?: (result: SearchCanonicalResult | { id: string; kind: 'event' | 'trip' | null }) => void;
  onOpenPerson?: (person: { id: string; username: string | null }) => void;
}

const UNDETERMINED_LABEL: Record<string, string> = {
  hiddenGems: 'Hidden gems could not be checked just now.',
  experiences: 'Experiences could not be checked just now.',
  events: 'Events could not be checked just now.',
  trips: 'Trips could not be checked just now.',
};

export function MediaSearchScreen({
  initialScope = 'all',
  tripId = null,
  nearCity = null,
  mediaId = null,
  initialQuery = '',
  fixedScope = false,
  onOpenMedia,
  onOpenPlace,
  onOpenGem,
  onOpenExperience,
  onOpenPerson,
}: MediaSearchScreenProps) {
  const [filters, dispatch] = useReducer(mediaFilterReducer, undefined, () =>
    mediaFilterReducer(
      mediaFilterReducer({ ...INITIAL_MEDIA_FILTERS, q: initialQuery, mediaId }, { type: 'set_scope', scope: initialScope, tripId }),
      { type: 'set_media', mediaId },
    ),
  );
  // The typed text is local until submitted, so a request is not fired per keystroke.
  const [draft, setDraft] = useState(initialQuery);
  // §38 "Show my Bangkok rooftop photos": the city is its own criterion, not a
  // word in the free text (the server matches the term as one phrase).
  const [cityDraft, setCityDraft] = useState('');
  // A trip the viewer chose to search WITHIN ("Show festival media from my
  // Vietnam Trip"): a route-given trip, or one picked from a Trip result.
  const [scopedTrip, setScopedTrip] = useState<{ id: string; title: string | null } | null>(
    tripId ? { id: tripId, title: null } : null,
  );
  const queryString = useMemo(() => toSearchQueryString(filters), [filters]);

  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => fetchMediaSearch(queryString, opts),
    [queryString],
  );
  const { state, reload } = useLensProjection<MediaSearchResultsView>(fetcher, isMediaSearchEmpty, [queryString]);
  const results = state.data;

  const submit = useCallback(() => {
    dispatch({ type: 'set_query', q: draft });
    if (cityDraft.trim()) dispatch({ type: 'set_city', city: cityDraft });
  }, [draft, cityDraft]);
  const scopes: { key: MediaSearchScope; label: string }[] = [
    { key: 'all', label: 'Everywhere' },
    { key: 'me', label: 'My world' },
    ...(scopedTrip ? [{ key: 'trip' as const, label: scopedTrip.title ? `In ${scopedTrip.title}` : 'This trip' }] : []),
  ];

  return (
    <View style={styles.wrap} testID="media-search-screen">
      <View style={styles.inputRow}>
        <Search size={18} color={color.onInkMute} strokeWidth={2} />
        <TextInput
          testID="media-search-input"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="search"
          placeholder={filters.scope === 'me' ? 'Search my world' : 'Places, moments, kinds of night…'}
          placeholderTextColor={color.faint}
          accessibilityLabel={filters.scope === 'me' ? 'Search my world' : 'Search media'}
          autoCorrect={false}
        />
      </View>
      <View style={[styles.inputRow, styles.cityRow]}>
        <TextInput
          testID="media-search-city"
          style={styles.cityInput}
          value={cityDraft}
          onChangeText={setCityDraft}
          onSubmitEditing={submit}
          returnKeyType="search"
          placeholder="In a city (optional)"
          placeholderTextColor={color.faint}
          accessibilityLabel="City to search in"
          autoCorrect={false}
        />
        {filters.city ? (
          <Pressable
            onPress={() => {
              setCityDraft('');
              dispatch({ type: 'set_city', city: null });
            }}
            accessibilityRole="button"
            accessibilityLabel={`Clear city ${filters.city}`}
            testID="media-search-city-clear"
          >
            <Text style={styles.clear}>{filters.city} ✕</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {!fixedScope
          ? scopes.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                active={filters.scope === s.key}
                testID={`media-search-scope-${s.key}`}
                onPress={() => dispatch({ type: 'set_scope', scope: s.key, tripId: scopedTrip?.id ?? null })}
              />
            ))
          : null}
        {nearCity ? (
          <Chip
            label={`Near ${nearCity}`}
            active={filters.city === nearCity}
            testID="media-search-near-city"
            onPress={() => dispatch({ type: 'set_city', city: filters.city === nearCity ? null : nearCity })}
          />
        ) : null}
        <Chip
          label="Right now"
          active={filters.freshOnly}
          testID="media-search-fresh"
          onPress={() => dispatch({ type: 'toggle_fresh' })}
        />
        {SEARCH_CATEGORIES.map((c) => (
          <Chip
            key={c.key}
            label={c.label}
            active={filters.category === c.key}
            testID={`media-search-category-${c.key}`}
            onPress={() => dispatch({ type: 'toggle_category', category: c.key })}
          />
        ))}
      </ScrollView>

      {queryString == null ? (
        <LensStateView
          status="empty"
          title={filters.scope === 'me' ? 'Search your own world' : 'Search the world by what it looks like'}
          message="Try a place, a kind of night, or a moment — “rooftop”, “festival”, “beach at sunset”."
        />
      ) : state.status !== 'ready' || !results ? (
        <LensStateView
          status={state.status === 'idle' ? 'loading' : state.status}
          title={state.status === 'error' ? 'Search could not run' : 'Nothing matched'}
          message={
            state.status === 'error'
              ? 'We could not reach search right now. That is not the same as there being nothing to find.'
              : 'Nothing you can see matched those words. Try fewer words, or another place.'
          }
          onRetry={reload}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.results} showsVerticalScrollIndicator={false} testID="media-search-results">
          {mediaId && results.places[0] ? (
            <Text style={styles.answer} testID="media-search-taken-at">
              Taken at {results.places[0].label ?? results.places[0].city ?? 'a place you can see'}
              {results.places[0].city && results.places[0].label ? ` · ${results.places[0].city}` : ''}
            </Text>
          ) : null}

          {results.places.length > 0 ? (
            <Section title="Places">
              {results.places.map((p) => (
                <Row
                  key={p.placeId}
                  testID={`media-search-place-${p.placeId}`}
                  icon={<MapPin size={16} color={color.onInkMute} strokeWidth={2} />}
                  title={p.label ?? p.neighborhood ?? p.city ?? 'A place'}
                  meta={`${p.perspectiveCount} ${p.perspectiveCount === 1 ? 'perspective' : 'perspectives'}${p.freshPerspectiveCount > 0 ? ` · ${p.freshPerspectiveCount} fresh` : ''}`}
                  onPress={onOpenPlace ? () => onOpenPlace(p.placeId) : undefined}
                />
              ))}
            </Section>
          ) : null}

          {results.hiddenGems.length > 0 ? (
            <Section title="Hidden gems">
              {results.hiddenGems.map((g) => (
                <Row
                  key={g.gemId}
                  testID={`media-search-gem-${g.gemId}`}
                  icon={<View style={styles.gemMark} />}
                  title={g.name ?? 'Hidden gem'}
                  meta="Protected discovery"
                  onPress={onOpenGem ? () => onOpenGem(g.gemId) : undefined}
                />
              ))}
            </Section>
          ) : null}

          {results.events.length > 0 ? (
            <Section title="Events">
              {results.events.map((e) => (
                <Row
                  key={e.id}
                  testID={`media-search-event-${e.id}`}
                  icon={<Calendar size={16} color={color.onInkMute} strokeWidth={2} />}
                  title={e.title ?? 'Event'}
                  meta={e.perspectiveCount > 0 ? `${e.perspectiveCount} perspectives` : 'No perspectives yet'}
                  onPress={onOpenExperience ? () => onOpenExperience(e) : undefined}
                />
              ))}
            </Section>
          ) : null}

          {results.trips.length > 0 ? (
            <Section title="Trips">
              {results.trips.map((t) => (
                <View key={t.id}>
                  <Row
                    testID={`media-search-trip-${t.id}`}
                    icon={<Plane size={16} color={color.onInkMute} strokeWidth={2} />}
                    title={t.title ?? 'Trip'}
                    meta={t.perspectiveCount > 0 ? `${t.perspectiveCount} perspectives` : 'No perspectives yet'}
                    onPress={onOpenExperience ? () => onOpenExperience(t) : undefined}
                  />
                  {!fixedScope ? (
                    <Pressable
                      style={styles.within}
                      testID={`media-search-within-trip-${t.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Search within ${t.title ?? 'this trip'}`}
                      onPress={() => {
                        setScopedTrip({ id: t.id, title: t.title });
                        dispatch({ type: 'set_scope', scope: 'trip', tripId: t.id });
                      }}
                    >
                      <Text style={styles.withinText}>Search within this trip</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </Section>
          ) : null}

          {results.experiences.length > 0 ? (
            <Section title="Experiences">
              {results.experiences.map((x) => (
                <Row
                  key={x.id}
                  testID={`media-search-experience-${x.id}`}
                  icon={<Calendar size={16} color={color.onInkMute} strokeWidth={2} />}
                  title={x.title}
                  meta={`${x.perspectiveCount} perspectives`}
                  onPress={onOpenExperience ? () => onOpenExperience({ id: x.id, kind: x.kind ?? null }) : undefined}
                />
              ))}
            </Section>
          ) : null}

          {results.people.length > 0 ? (
            <Section title="People">
              {results.people.map((p) => (
                <Row
                  key={p.id}
                  testID={`media-search-person-${p.id}`}
                  icon={<Users size={16} color={color.onInkMute} strokeWidth={2} />}
                  title={p.username ? `@${p.username}` : p.name ?? 'Contributor'}
                  meta={`${p.perspectiveCount} ${p.perspectiveCount === 1 ? 'perspective' : 'perspectives'} here`}
                  onPress={onOpenPerson ? () => onOpenPerson({ id: p.id, username: p.username }) : undefined}
                />
              ))}
            </Section>
          ) : null}

          {results.media.length > 0 ? (
            <Section title="Media">
              <PerspectiveMosaic media={results.media} onOpen={onOpenMedia} />
            </Section>
          ) : null}

          {results.undetermined.map((u) => (
            <Text key={u} style={styles.undetermined} testID={`media-search-undetermined-${u}`}>
              {UNDETERMINED_LABEL[u] ?? `${u} could not be checked just now.`}
            </Text>
          ))}
          {results.unsupported.length > 0 ? (
            <Text style={styles.unsupported} testID="media-search-unsupported">
              Search can't yet: {results.unsupported.join('; ')}.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Chip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  icon,
  title,
  meta,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <Pressable testID={testID} style={styles.row} onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      {icon}
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  input: { flex: 1, color: color.onInk, fontSize: 15, paddingVertical: space.md },
  cityRow: { marginTop: space.xs },
  cityInput: { flex: 1, color: color.onInk, fontSize: 13, paddingVertical: space.sm },
  clear: { color: color.onInkMute, fontSize: 12, fontWeight: '700' },
  within: { marginHorizontal: space.lg, marginTop: 2, paddingHorizontal: space.md, paddingVertical: 4, alignSelf: 'flex-start' },
  withinText: { color: color.onInkMute, fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  results: { gap: space.lg, paddingBottom: space.xxxl },
  answer: { color: color.onInk, fontSize: 18, fontWeight: '800', paddingHorizontal: space.lg },
  section: { gap: space.sm },
  sectionBody: { gap: space.xs },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.05)',
  },
  rowTitle: { flex: 1, color: color.onInk, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: color.onInkMute, fontSize: 12, fontWeight: '600' },
  gemMark: { width: 10, height: 10, transform: [{ rotate: '45deg' }], backgroundColor: '#10B981' },
  undetermined: { color: color.warn, fontSize: 12, lineHeight: 17, paddingHorizontal: space.lg },
  unsupported: { color: color.faint, fontSize: 11, lineHeight: 16, paddingHorizontal: space.lg },
});
