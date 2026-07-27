/**
 * PassportTravelInfoSection — "Before you go" block on the owner's passport.
 *
 * Accepts the already-loaded trips array, filters to upcoming/active trips,
 * and for each trip fetches entry requirements + country essentials in parallel.
 * Renders a compact card per trip showing visa status chip, key essentials
 * preview, and a "View trip →" row that navigates to the full trip detail.
 *
 * Returns null when:
 *   - no upcoming/active trips
 *   - all API calls return null/empty (feature flag off or API unavailable)
 *
 * SAFETY: the `disclaimer` text from the API is ALWAYS rendered verbatim
 * alongside any emergency numbers — it is a non-negotiable safety notice.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight, Zap, Car, Phone } from 'lucide-react-native';
import { router } from 'expo-router';
import type { TripRow } from '../../services/trips.ts';
import { fetchTripEntryRequirements } from '../../services/entryRequirements.ts';
import { getTripEssentials, type TripEssentialsItem, type CountryEssentials } from '../../services/countryEssentials.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';

// ── Inline StatusChip logic (mirrors TripEntrySection) ─────────────────────────

type StatusKey =
  | 'VISA-FREE'
  | 'VISA ON ARRIVAL'
  | 'EVISA'
  | 'VISA REQUIRED'
  | 'ADDITIONAL APPROVAL'
  | 'RESTRICTED'
  | 'UNKNOWN';

function normalizeStatus(raw: string): StatusKey {
  const up = raw.toUpperCase().trim();
  if (up === 'VISA_FREE' || up === 'VISA-FREE' || up === 'VISA FREE') return 'VISA-FREE';
  if (up === 'VISA_ON_ARRIVAL' || up === 'VISA ON ARRIVAL') return 'VISA ON ARRIVAL';
  if (up === 'EVISA' || up === 'E_VISA' || up === 'E-VISA') return 'EVISA';
  if (up === 'VISA_REQUIRED' || up === 'VISA REQUIRED') return 'VISA REQUIRED';
  if (up === 'ADDITIONAL_APPROVAL' || up === 'ADDITIONAL APPROVAL') return 'ADDITIONAL APPROVAL';
  if (up === 'RESTRICTED') return 'RESTRICTED';
  return 'UNKNOWN';
}

function chipColors(status: StatusKey): { bg: string; text: string } {
  switch (status) {
    case 'VISA-FREE':
      return { bg: color.success, text: color.onInk };
    case 'VISA ON ARRIVAL':
    case 'EVISA':
      return { bg: color.warn, text: color.onInk };
    case 'VISA REQUIRED':
    case 'ADDITIONAL APPROVAL':
    case 'RESTRICTED':
      return { bg: color.signal, text: color.onInk };
    default:
      return { bg: color.mute, text: color.onInk };
  }
}

function StatusChip({ rawStatus }: { rawStatus: string }) {
  const status = normalizeStatus(rawStatus);
  const { bg, text } = chipColors(status);
  return (
    <View style={[s.chip, { backgroundColor: bg }]}>
      <Text style={[s.chipLabel, { color: text }]}>{status}</Text>
    </View>
  );
}

// ── Trip data shape ────────────────────────────────────────────────────────────

interface TripInfo {
  trip: TripRow;
  entry: Awaited<ReturnType<typeof fetchTripEntryRequirements>>;
  essentials: TripEssentialsItem[] | null;
}

// ── Filter helper ──────────────────────────────────────────────────────────────

function isUpcomingOrActive(trip: TripRow): boolean {
  if (!['planning', 'active'].includes(trip.status)) return false;
  if (!trip.startDate) return true; // undated planning trip — include
  const start = new Date(trip.startDate);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
  return start >= cutoff;
}

// ── Trip card ──────────────────────────────────────────────────────────────────

function TripCard({ info }: { info: TripInfo }) {
  const { trip, entry, essentials } = info;

  const selfTraveler = entry?.travelers.find((tr) => tr.self);
  const visaStatus = selfTraveler?.status ?? null;

  const coveredItem = essentials?.find((i) => i.essentials != null);
  const e: CountryEssentials | null = coveredItem?.essentials ?? null;

  const hasEmergency = !!(e && (e.emergency.all || e.emergency.police || e.emergency.ambulance || e.emergency.fire));

  if (!visaStatus && !e) return null;

  return (
    <Pressable
      style={s.card}
      onPress={() => router.push(`/trip/${trip.id}` as any)}
      accessibilityLabel={`${trip.title} — view trip details`}
      accessibilityRole="button"
    >
      {/* Destination + visa chip */}
      <View style={s.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle} numberOfLines={1}>{trip.title}</Text>
          {trip.destinationCity ? (
            <Text style={s.cardSub} numberOfLines={1}>{trip.destinationCity}</Text>
          ) : null}
        </View>
        {visaStatus ? <StatusChip rawStatus={visaStatus} /> : null}
      </View>

      {/* Entry disclaimer — always shown when entry data is present */}
      {entry?.disclaimer ? (
        <Text style={s.disclaimer}>{entry.disclaimer}</Text>
      ) : null}

      {/* Key essentials preview */}
      {e ? (
        <View style={s.essentialsRow}>
          {e.driveSide ? (
            <View style={s.essItem}>
              <Car size={12} color={color.mute} />
              <Text style={s.essText}>
                {e.driveSide === 'left' ? 'Left-hand drive' : 'Right-hand drive'}
              </Text>
            </View>
          ) : null}
          {e.plugTypes.length > 0 ? (
            <View style={s.essItem}>
              <Zap size={12} color={color.mute} />
              <Text style={s.essText}>
                {`Type ${e.plugTypes.slice(0, 2).join(', ')}`}
              </Text>
            </View>
          ) : null}
          {(e.emergency.all || e.emergency.police) ? (
            <View style={s.essItem}>
              <Phone size={12} color="#EF4444" />
              <Text style={s.essText}>
                {e.emergency.all ?? e.emergency.police}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ALWAYS render disclaimer alongside emergency numbers — safety requirement */}
      {hasEmergency ? (
        <Text style={s.emergencyDisclaimer} accessibilityRole="text">
          {e!.disclaimer}
        </Text>
      ) : null}

      {/* View trip row */}
      <View style={s.viewRow}>
        <Text style={s.viewLabel}>View trip</Text>
        <ChevronRight size={14} color={color.mute} />
      </View>
    </Pressable>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  trips: TripRow[];
}

export function PassportTravelInfoSection({ trips }: Props) {
  const [infos, setInfos] = useState<TripInfo[] | null>(null);

  const tripKey = trips
    .filter(isUpcomingOrActive)
    .map((tr) => tr.id)
    .join(',');

  useEffect(() => {
    const upcoming = trips.filter(isUpcomingOrActive);
    if (upcoming.length === 0) {
      setInfos([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      upcoming.map(async (trip): Promise<TripInfo> => {
        const [entry, essentials] = await Promise.all([
          fetchTripEntryRequirements(trip.id),
          getTripEssentials(trip.id),
        ]);
        return { trip, entry, essentials };
      }),
    ).then((results) => {
      if (!cancelled) setInfos(results);
    }).catch(() => {
      if (!cancelled) setInfos([]);
    });
    return () => { cancelled = true; };
  }, [tripKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Still loading or no upcoming trips — render nothing
  if (infos === null || infos.length === 0) return null;

  // Only surface trips that have at least some displayable data
  const cards = infos.filter((info) => {
    const selfTraveler = info.entry?.travelers.find((tr) => tr.self);
    const hasCovered = info.essentials?.some((i) => i.essentials != null) ?? false;
    return !!(selfTraveler?.status) || hasCovered;
  });

  if (cards.length === 0) return null;

  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
        <Text style={s.sectionTitle}>BEFORE YOU GO</Text>
        <View style={s.sectionRule} />
      </View>
      {cards.map((info) => (
        <TripCard key={info.trip.id} info={info} />
      ))}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  section: {
    marginHorizontal: 16,
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: space.md,
  },
  sectionTitle: {
    ...PP_LABEL,
    fontSize: 10,
    color: PP.ink,
    letterSpacing: 2,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: PP.borderLight,
  },
  card: {
    backgroundColor: PP.paper,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PP.borderLight,
    padding: space.md,
    marginBottom: space.sm,
    gap: space.xs,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  cardTitle: {
    ...t.bodyStrong,
    color: PP.ink,
    fontSize: 14,
  },
  cardSub: {
    ...t.small,
    color: PP.inkMuted,
    marginTop: 1,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginTop: 1,
  },
  chipLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
    fontFamily: 'Courier',
  },
  disclaimer: {
    ...t.small,
    color: PP.inkMuted,
    fontStyle: 'italic',
    fontSize: 10,
  },
  essentialsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: 2,
  },
  essItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  essText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  emergencyDisclaimer: {
    ...t.small,
    color: PP.inkMuted,
    fontStyle: 'italic',
    fontSize: 10,
    marginTop: 2,
  },
  viewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: 2,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PP.borderLight,
  },
  viewLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
});
