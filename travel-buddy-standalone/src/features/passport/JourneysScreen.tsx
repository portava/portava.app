/**
 * JourneysScreen — the chronological travel-history Passport surface
 * (spec §14 + TABLE 3 / TABLE 26).
 *
 * Renders the server's privacy-safe Journeys projection
 * (`getPassportJourneys()` → `GET /api/passport/:userId/journeys`) as the
 * canonical hierarchy:
 *
 *     WORLD → year → country → city → Trip → places / memories / stamps
 *
 * and lifts the single Featured Journey (e.g. "30 Days in Vietnam") into a rich
 * highlight card carrying its route/timeline, places, memories, stamps and — when
 * the server attaches them — people context.
 *
 * PRIVACY (§23 / TABLE 25): every location shown here is COARSE — country, city
 * and (permitted) neighbourhood or named place only. The projection never
 * carries exact coordinates and this screen never renders any; deep, exact
 * location belongs to purpose-bound Presence systems, not Passport. Dates are
 * already coarsened server-side per the viewer's permission.
 *
 * This screen creates no Trip storage of its own (§34) and does not embed the
 * live Map — it is a pure projection view.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Route as RouteIcon,
  MapPin,
  CalendarDays,
  Images,
  Stamp,
  Users,
  Star,
  ShieldCheck,
  Compass,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  useJourneys,
  type UseJourneysResult,
} from './useJourneys.ts';
import { trackJourneyViewed } from './passportTelemetry.ts';
import type {
  JourneyProjection,
  JourneysProjection,
} from '../../services/passportProjection.ts';

// Deep-link to the main Map in passport mode — Journeys hands OFF to the Map for
// any geographic exploration; it never embeds one (mirrors MyWorldScreen).
const MAP_DEEPLINK = '/map?entityTypes=stamps&mode=passport&entry=passport';

function openMap(): void {
  router.push(MAP_DEEPLINK as never);
}

// ── Date / place helpers (coarse only) ───────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Coarse "Mon YYYY" label — deliberately month-level, never a precise day. */
function monthYear(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A coarse date range for a journey, or null when no permitted dates. */
function dateRange(j: JourneyProjection): string | null {
  const a = monthYear(j.startDate);
  const b = monthYear(j.endDate);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a ?? b ?? null;
}

/** Coarse "City, Country" label for a journey. */
function placeLabel(j: JourneyProjection): string | null {
  const parts = [j.city, j.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Distinct named places visited on a journey (memory titles + stamp names). */
function derivePlaces(j: JourneyProjection): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (label: string | null | undefined) => {
    const v = (label ?? '').trim();
    if (!v || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    out.push(v);
  };
  for (const m of j.memories) push(m.title ?? m.city);
  for (const st of j.stamps) push(st.name ?? st.city);
  return out.slice(0, 8);
}

/** Ordered city sequence (the "route") — distinct cities in visit order. */
function deriveRoute(j: JourneyProjection): string[] {
  const events = [
    ...j.memories.map((m) => ({ city: m.city, at: m.earnedAt })),
    ...j.stamps.map((st) => ({ city: st.city, at: st.earnedAt })),
  ]
    .filter((e) => !!e.city)
    .sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
  const seen = new Set<string>();
  const route: string[] = [];
  const first = j.city?.trim();
  if (first) { seen.add(first.toLowerCase()); route.push(first); }
  for (const e of events) {
    const c = (e.city ?? '').trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    route.push(c);
  }
  return route.slice(0, 8);
}

// ── Featured Journey card ────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return (
    <View style={s.chip}>
      <Text style={s.chipText} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function FeaturedJourney({ journey }: { journey: JourneyProjection }) {
  const range = dateRange(journey);
  const place = placeLabel(journey);
  const route = deriveRoute(journey);
  const places = derivePlaces(journey);
  const people = journey.people ?? [];

  return (
    <View style={s.featuredCard} accessibilityLabel={`Featured journey: ${journey.title}`}>
      <View style={s.featuredBadge}>
        <Star size={icon.s14} color={color.warn} />
        <Text style={s.featuredBadgeText}>Featured Journey</Text>
      </View>

      <Text style={s.featuredTitle}>{journey.title}</Text>

      <View style={s.featuredMetaRow}>
        {place ? (
          <View style={s.metaItem}>
            <MapPin size={icon.s14} color={color.deep} />
            <Text style={s.metaText}>{place}</Text>
          </View>
        ) : null}
        {journey.durationLabel ? (
          <View style={s.metaItem}>
            <CalendarDays size={icon.s14} color={color.deep} />
            <Text style={s.metaText}>{journey.durationLabel}</Text>
          </View>
        ) : null}
      </View>
      {range ? <Text style={s.featuredDates}>{range}</Text> : null}

      {/* Route / timeline — ordered coarse city sequence */}
      {route.length > 0 ? (
        <View style={s.section}>
          <View style={s.sectionHead}>
            <RouteIcon size={icon.s14} color={color.mute} />
            <Text style={s.sectionTitle}>Route</Text>
          </View>
          <View style={s.routeRow}>
            {route.map((city, i) => (
              <View key={`${city}-${i}`} style={s.routeStep}>
                <Text style={s.routeCity} numberOfLines={1}>{city}</Text>
                {i < route.length - 1 ? <Text style={s.routeArrow}>→</Text> : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* Counts */}
      <View style={s.countsRow}>
        <View style={s.countItem}>
          <MapPin size={icon.s14} color={color.faint} />
          <Text style={s.countText}>{places.length} {places.length === 1 ? 'place' : 'places'}</Text>
        </View>
        <View style={s.countItem}>
          <Images size={icon.s14} color={color.faint} />
          <Text style={s.countText}>{journey.memoryCount} {journey.memoryCount === 1 ? 'memory' : 'memories'}</Text>
        </View>
        <View style={s.countItem}>
          <Stamp size={icon.s14} color={color.faint} />
          <Text style={s.countText}>{journey.stampCount} {journey.stampCount === 1 ? 'stamp' : 'stamps'}</Text>
        </View>
      </View>

      {/* Places */}
      {places.length > 0 ? (
        <View style={s.section}>
          <View style={s.sectionHead}>
            <MapPin size={icon.s14} color={color.mute} />
            <Text style={s.sectionTitle}>Places</Text>
          </View>
          <View style={s.chipWrap}>
            {places.map((p, i) => <Chip key={`${p}-${i}`} label={p} />)}
          </View>
        </View>
      ) : null}

      {/* Memories */}
      {journey.memories.length > 0 ? (
        <View style={s.section}>
          <View style={s.sectionHead}>
            <Images size={icon.s14} color={color.mute} />
            <Text style={s.sectionTitle}>Memories</Text>
          </View>
          {journey.memories.slice(0, 6).map((m) => (
            <View key={m.id} style={s.lineItem}>
              <Text style={s.lineTitle} numberOfLines={1}>{m.title ?? 'Memory'}</Text>
              {m.city ? <Text style={s.lineMeta} numberOfLines={1}>{m.city}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* Stamps */}
      {journey.stamps.length > 0 ? (
        <View style={s.section}>
          <View style={s.sectionHead}>
            <Stamp size={icon.s14} color={color.mute} />
            <Text style={s.sectionTitle}>Stamps</Text>
          </View>
          <View style={s.chipWrap}>
            {journey.stamps.slice(0, 8).map((st, i) => (
              <View key={`${st.name}-${i}`} style={s.stampChip}>
                <ShieldCheck size={icon.s14} color={color.success} />
                <Text style={s.stampChipText} numberOfLines={1}>{st.name ?? st.city ?? 'Stamp'}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* People context (§14) — rendered when the server attaches companions. */}
      <View style={s.section}>
        <View style={s.sectionHead}>
          <Users size={icon.s14} color={color.mute} />
          <Text style={s.sectionTitle}>People</Text>
        </View>
        {people.length > 0 ? (
          <View style={s.chipWrap}>
            {people.map((p) => (
              <Chip key={p.id} label={p.name ?? (p.handle ? `@${p.handle}` : 'Traveler')} />
            ))}
          </View>
        ) : (
          <Text style={s.peopleEmpty}>
            Travel companions appear here when they are on Portava and you both
            have rights to the shared Trip.
          </Text>
        )}
      </View>
    </View>
  );
}

// ── Trip row (leaf of the hierarchy) ─────────────────────────────────────────

function TripRow({ journey }: { journey: JourneyProjection }) {
  const range = dateRange(journey);
  return (
    <View style={s.tripRow} accessibilityLabel={`Trip: ${journey.title}`}>
      <View style={s.tripMain}>
        <View style={s.tripTitleRow}>
          <Text style={s.tripTitle} numberOfLines={1}>{journey.title}</Text>
          {journey.featured ? (
            <View style={s.tripFeatured}>
              <Star size={icon.s14} color={color.warn} />
            </View>
          ) : null}
        </View>
        <Text style={s.tripMeta} numberOfLines={1}>
          {[journey.durationLabel, range].filter(Boolean).join(' · ') || 'Trip'}
        </Text>
      </View>
      <View style={s.tripCounts}>
        <View style={s.countItem}>
          <Images size={icon.s14} color={color.faint} />
          <Text style={s.countText}>{journey.memoryCount}</Text>
        </View>
        <View style={s.countItem}>
          <Stamp size={icon.s14} color={color.faint} />
          <Text style={s.countText}>{journey.stampCount}</Text>
        </View>
      </View>
    </View>
  );
}

// ── Hierarchy (year → country → city → Trip) ─────────────────────────────────

function Hierarchy({ journeys }: { journeys: JourneysProjection }) {
  return (
    <View style={s.hierarchy}>
      {journeys.years.map((year) => (
        <View key={String(year.year ?? 'unknown')} style={s.yearBlock}>
          <Text style={s.yearLabel}>{year.year ?? 'Undated'}</Text>
          {year.countries.map((country) => (
            <View key={country.country ?? 'unknown'} style={s.countryBlock}>
              <Text style={s.countryLabel} numberOfLines={1}>
                {country.country ?? 'Unmapped region'}
              </Text>
              {country.cities.map((city) => (
                <View key={city.city ?? 'unknown'} style={s.cityBlock}>
                  <View style={s.cityLabelRow}>
                    <MapPin size={icon.s14} color={color.deep} />
                    <Text style={s.cityLabel} numberOfLines={1}>
                      {city.city ?? 'Unknown city'}
                    </Text>
                  </View>
                  <View style={s.tripList}>
                    {city.journeys.map((j) => <TripRow key={j.tripId} journey={j} />)}
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Gathering your journeys…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <RouteIcon size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load your journeys</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

function EmptyView() {
  return (
    <View style={s.center}>
      <RouteIcon size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>No journeys yet</Text>
      <Text style={s.centerText}>
        As you complete Trips and root memories and stamps to them, your travel
        history — year by year, country by country — appears here.
      </Text>
      <Pressable style={s.mapBtn} onPress={openMap} accessibilityRole="button" accessibilityLabel="Explore the Map">
        <Compass size={icon.s16} color={color.paper} />
        <Text style={s.mapBtnText}>Explore the Map</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface JourneysScreenProps {
  /** Test seam: inject a prebuilt projection to bypass the data hook. */
  journeysOverride?: JourneysProjection;
  /** Test seam: force the restricted (blocked/unavailable) state. */
  restrictedOverride?: boolean;
}

export default function JourneysScreen({
  journeysOverride,
  restrictedOverride,
}: JourneysScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const hook: UseJourneysResult = useJourneys();

  const journeys = journeysOverride ?? hook.journeys;
  const restricted = restrictedOverride ?? hook.restricted;
  const loading = journeysOverride ? false : hook.loading;
  const error = journeysOverride ? null : hook.error;

  const featured = journeys?.featured ?? null;
  const isEmpty = useMemo(
    () => !journeys || (journeys.totalJourneys === 0 && journeys.years.length === 0),
    [journeys],
  );

  // §32 journey_viewed — fire once real journeys are shown (not restricted /
  // empty / loading). Counts + a boolean only, never a place or trip title.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    if (loading || error || restricted || isEmpty || !journeys) return;
    viewedRef.current = true;
    trackJourneyViewed({ journeyCount: journeys.totalJourneys, hasFeatured: featured != null });
  }, [loading, error, restricted, isEmpty, journeys, featured]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <RouteIcon size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>Journeys</Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>Your travel history, year by year</Text>

        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : restricted ? (
          <View style={s.center}>
            <RouteIcon size={icon.s26} color={color.faint} />
            <Text style={s.centerTitle}>Journeys are not available</Text>
            <Text style={s.centerText}>These journeys aren&apos;t viewable right now.</Text>
          </View>
        ) : isEmpty ? (
          <EmptyView />
        ) : (
          <>
            {/* Coarse-location assurance (§23 / TABLE 25) */}
            <View style={s.privacyNote}>
              <MapPin size={icon.s14} color={color.mute} />
              <Text style={s.privacyText}>
                Countries, cities and places only — your exact locations are never shown.
              </Text>
            </View>

            {featured ? <FeaturedJourney journey={featured} /> : null}

            {journeys ? <Hierarchy journeys={journeys} /> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  title: { ...t.title, fontSize: 17, color: color.ink },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Privacy note
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
  },
  privacyText: { ...t.small, color: color.mute, fontSize: 12, flexShrink: 1 },

  // Featured card
  featuredCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.sm,
  },
  featuredBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(200,133,26,0.12)',
  },
  featuredBadgeText: {
    ...t.small,
    color: color.warn,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  featuredTitle: { ...t.title, color: color.ink },
  featuredMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  metaText: { ...t.small, color: color.deep, fontSize: 13 },
  featuredDates: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 12 },

  section: { marginTop: space.sm, gap: space.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  sectionTitle: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
  },

  routeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  routeStep: { flexDirection: 'row', alignItems: 'center' },
  routeCity: { ...t.bodyStrong, color: color.deep, fontSize: 14 },
  routeArrow: { ...t.body, color: color.faint, marginHorizontal: space.xs },

  countsRow: {
    flexDirection: 'row',
    gap: space.lg,
    marginTop: space.xs,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  countItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  countText: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 12 },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipText: { ...t.small, color: color.ink, fontSize: 12 },
  stampChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(46,125,91,0.10)',
  },
  stampChipText: { ...t.small, color: color.success, fontSize: 12, fontWeight: '700' },

  lineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: 3,
  },
  lineTitle: { ...t.body, color: color.ink, fontSize: 14, flexShrink: 1 },
  lineMeta: { ...t.small, color: color.faint, fontSize: 12 },
  peopleEmpty: { ...t.small, color: color.faint, fontSize: 12 },

  // Hierarchy
  hierarchy: { marginTop: space.lg, paddingHorizontal: space.lg, gap: space.lg },
  yearBlock: { gap: space.sm },
  yearLabel: { ...t.heading, color: color.ink, fontSize: 20 },
  countryBlock: { gap: space.xs, marginTop: space.xs },
  countryLabel: { ...t.bodyStrong, color: color.deep, fontSize: 15 },
  cityBlock: {
    marginTop: space.xs,
    marginLeft: space.sm,
    gap: space.xs,
  },
  cityLabelRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cityLabel: { ...t.small, color: color.mute, fontSize: 13 },
  tripList: {
    gap: space.xs,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  tripRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  tripMain: { flex: 1, gap: 2 },
  tripTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  tripTitle: { ...t.body, color: color.ink, fontSize: 15, flexShrink: 1 },
  tripFeatured: {},
  tripMeta: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 12 },
  tripCounts: { flexDirection: 'row', gap: space.md },

  // Map deep-link button
  mapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  mapBtnText: { ...t.bodyStrong, color: color.paper, fontSize: 14 },

  // States
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  centerTitle: { ...t.bodyStrong, color: color.ink, marginTop: space.xs },
  centerText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
