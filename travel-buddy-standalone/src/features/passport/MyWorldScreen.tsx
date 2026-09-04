/**
 * MyWorldScreen — the personal geographic travel-history surface (spec §26/§28).
 *
 * "Main Map answers 'What is happening now?' My World answers
 *  'Where has my story happened?' They can deep-link but must not merge truth
 *  models." (spec §26)
 *
 * This screen is deliberately STANDALONE: it renders the WORLD → Country → City
 * hierarchy from the existing privacy-safe passport map payload
 * (`getPassportMap()` → `GET /me/passport/map`) and deep-links OUT to the main
 * Map — it never embeds or edits the live Map. Because the payload is
 * city/zone-level by server invariant, exact coordinates are never available
 * here and are never rendered (§23 / TABLE 25: coarse place only).
 */
import React, { useEffect, useRef } from 'react';
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
import { trackMyWorldOpened } from './passportTelemetry.ts';
import {
  ArrowLeft,
  Globe2,
  MapPin,
  ChevronRight,
  Map as MapIcon,
  ShieldCheck,
  Stamp,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  usePassportWorld,
  type PassportWorld,
  type WorldCountry,
  type WorldCity,
} from './usePassportWorld.ts';

// Deep-link target for the main Map in passport ("my stamps") mode. Mirrors the
// canonical passport→map link used elsewhere (src/components/MapTab.tsx). My
// World hands off to the Map; it does not render one.
const MAP_DEEPLINK = '/map?entityTypes=stamps&mode=passport';

function openMap(): void {
  router.push(MAP_DEEPLINK as never);
}

function openCountry(country: string): void {
  router.push({
    pathname: '/passport/country/[country]',
    params: { country },
  } as never);
}

function isVerified(level: string): boolean {
  return level.length > 0 && level !== 'unverified' && level !== 'none';
}

// ── Stat tile ──────────────────────────────────────────────────────────────────

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <View style={s.statTile}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

// ── City row (leaf) ─────────────────────────────────────────────────────────────

function CityRow({ city, onPress }: { city: WorldCity; onPress?: () => void }) {
  const verified = isVerified(city.verificationLevel);
  return (
    <Pressable
      style={s.cityRow}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${city.city}${city.country ? `, ${city.country}` : ''} — ${city.stampCount} ${city.stampCount === 1 ? 'stamp' : 'stamps'}`}
    >
      <MapPin size={icon.s16} color={color.deep} />
      <View style={s.cityText}>
        <Text style={s.cityName} numberOfLines={1}>
          {city.city}
        </Text>
        {city.neighborhood ? (
          <Text style={s.cityNeighborhood} numberOfLines={1}>
            {city.neighborhood}
          </Text>
        ) : null}
      </View>
      {verified ? (
        <View style={s.verifiedPill} accessibilityLabel="Verified place">
          <ShieldCheck size={icon.s14} color={color.success} />
          <Text style={s.verifiedText}>Verified</Text>
        </View>
      ) : null}
      <View style={s.cityStamps}>
        <Stamp size={icon.s14} color={color.faint} />
        <Text style={s.cityStampCount}>{city.stampCount}</Text>
      </View>
    </Pressable>
  );
}

// ── Country section ─────────────────────────────────────────────────────────────

function CountrySection({ country }: { country: WorldCountry }) {
  const open = country.isNamed ? () => openCountry(country.country) : undefined;
  return (
    <View style={s.countryCard}>
      <Pressable
        style={s.countryHeader}
        onPress={open}
        disabled={!open}
        accessibilityRole={open ? 'button' : 'text'}
        accessibilityLabel={`${country.country} — ${country.cityCount} ${country.cityCount === 1 ? 'city' : 'cities'}, ${country.stampCount} ${country.stampCount === 1 ? 'stamp' : 'stamps'}`}
      >
        <View style={s.countryTitleWrap}>
          <Text style={s.countryName} numberOfLines={1}>
            {country.country}
          </Text>
          <Text style={s.countryMeta}>
            {country.cityCount} {country.cityCount === 1 ? 'city' : 'cities'} ·{' '}
            {country.stampCount} {country.stampCount === 1 ? 'stamp' : 'stamps'}
          </Text>
        </View>
        {open ? <ChevronRight size={icon.s18} color={color.faint} /> : null}
      </Pressable>

      <View style={s.cityList}>
        {country.cities.map((c) => (
          <CityRow key={c.key} city={c} onPress={open} />
        ))}
      </View>
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Mapping your world…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <Globe2 size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load your world</Text>
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
      <Globe2 size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Your world map is empty</Text>
      <Text style={s.centerText}>
        As you earn stamps and log memories rooted to a place, the countries and
        cities of your story appear here.
      </Text>
      <Pressable style={s.mapBtn} onPress={openMap} accessibilityRole="button" accessibilityLabel="View on Map">
        <MapIcon size={icon.s16} color={color.paper} />
        <Text style={s.mapBtnText}>Explore the Map</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface MyWorldScreenProps {
  /** Test seam: inject a prebuilt world to bypass the data hook. */
  worldOverride?: PassportWorld;
}

export default function MyWorldScreen({ worldOverride }: MyWorldScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const hook = usePassportWorld();

  const world = worldOverride ?? hook.world;
  const loading = worldOverride ? false : hook.loading;
  const error = worldOverride ? null : hook.error;

  // §32 my_world_opened — fire once the world resolves. Counts only, never a
  // country or city name.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || !world) return;
    openedRef.current = true;
    trackMyWorldOpened({
      countryCount: world.totalCountries,
      cityCount: world.totalCities,
      stampCount: world.totalStamps,
    });
  }, [world]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <Globe2 size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>
            My World
          </Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>Where your story has happened</Text>

        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : !world || world.isEmpty ? (
          <EmptyView />
        ) : (
          <>
            {/* World stats */}
            <View style={s.statsRow}>
              <StatTile value={world.totalCountries} label="Countries" />
              <StatTile value={world.totalCities} label="Cities" />
              <StatTile value={world.totalStamps} label="Stamps" />
            </View>

            {/* Deep-link to the main Map (never embedded here) */}
            <Pressable
              style={s.mapBtn}
              onPress={openMap}
              accessibilityRole="button"
              accessibilityLabel="View on Map"
            >
              <MapIcon size={icon.s16} color={color.paper} />
              <Text style={s.mapBtnText}>View on Map</Text>
            </Pressable>

            {/* Coarse-location assurance (§23 / TABLE 25) */}
            <View style={s.privacyNote}>
              <MapPin size={icon.s14} color={color.mute} />
              <Text style={s.privacyText}>
                Cities and regions only — your exact locations are never shown.
              </Text>
            </View>

            {/* Country → City hierarchy */}
            <View style={s.countries}>
              {world.countries.map((c) => (
                <CountrySection key={c.key} country={c} />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
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
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Stats
  statsRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    marginTop: space.sm,
  },
  statTile: {
    flex: 1,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingVertical: space.md,
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    ...t.title,
    color: color.deep,
  },
  statLabel: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
  },

  // Map deep-link button
  mapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.md,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  mapBtnText: {
    ...t.bodyStrong,
    color: color.paper,
    fontSize: 14,
  },

  // Privacy note
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
  },
  privacyText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    flexShrink: 1,
  },

  // Country / city hierarchy
  countries: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  countryCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  countryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  countryTitleWrap: {
    flex: 1,
    gap: 2,
  },
  countryName: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  countryMeta: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
  },
  cityList: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  cityText: {
    flex: 1,
    gap: 1,
  },
  cityName: {
    ...t.body,
    color: color.ink,
    fontSize: 15,
  },
  cityNeighborhood: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(46,125,91,0.10)',
  },
  verifiedText: {
    ...t.small,
    color: color.success,
    fontSize: 11,
    fontWeight: '700',
  },
  cityStamps: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  cityStampCount: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    fontSize: 13,
  },

  // States
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  centerTitle: {
    ...t.bodyStrong,
    color: color.ink,
    marginTop: space.xs,
  },
  centerText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 14,
  },
});
