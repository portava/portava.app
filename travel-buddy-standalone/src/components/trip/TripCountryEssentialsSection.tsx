/**
 * TripCountryEssentialsSection — "Good to know" card per destination country.
 *
 * Renders plug types, voltage/frequency, drive side, and emergency numbers
 * for each destination country that has coverage. Countries without coverage
 * are silently skipped.
 *
 * Returns null when:
 *   - the service returns null (feature flag off)
 *   - no destination has coverage
 *
 * SAFETY: the `disclaimer` field is ALWAYS rendered alongside emergency
 * numbers — it is a non-negotiable safety notice.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Info, Zap, Car, Phone } from 'lucide-react-native';
import { getTripEssentials, type TripEssentialsItem, type CountryEssentials } from '../../services/countryEssentials.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  tripId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function plugHint(plugTypes: string[]): string {
  if (!plugTypes.length) return '';
  const list = plugTypes.join(', ');
  // Simple adapter hint: if any non-universal type is present, recommend an adapter.
  return `Type ${list} — bring a universal adapter`;
}

function driveLabel(side: string | null): string {
  if (!side) return '';
  return side === 'left' ? 'Drives on the left' : 'Drives on the right';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EssentialsCard({ item }: { item: TripEssentialsItem }) {
  const { country, essentials } = item;
  if (!essentials) return null;
  const e: CountryEssentials = essentials;

  return (
    <View style={styles.card} accessibilityLabel={`Good to know — ${country}`}>
      <View style={styles.cardHeader}>
        <Info size={14} color={color.deep} />
        <Text style={styles.cardTitle}>{country}</Text>
      </View>

      {/* Plug / power */}
      {(e.plugTypes.length > 0 || e.voltage != null || e.frequency != null) && (
        <View style={styles.row}>
          <Zap size={13} color={color.mute} />
          <View style={styles.rowText}>
            {e.plugTypes.length > 0 && (
              <Text style={styles.rowPrimary}>{plugHint(e.plugTypes)}</Text>
            )}
            {(e.voltage != null || e.frequency != null) && (
              <Text style={styles.rowSecondary}>
                {[
                  e.voltage != null ? `${e.voltage}V` : null,
                  e.frequency != null ? `${e.frequency}Hz` : null,
                ].filter(Boolean).join(' / ')}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Drive side */}
      {e.driveSide && (
        <View style={styles.row}>
          <Car size={13} color={color.mute} />
          <Text style={[styles.rowPrimary, { marginLeft: space.xs }]}>
            {driveLabel(e.driveSide)}
          </Text>
        </View>
      )}

      {/* Emergency numbers */}
      {(e.emergency.all || e.emergency.police || e.emergency.ambulance || e.emergency.fire) && (
        <View style={styles.emergencyBlock}>
          <View style={styles.row}>
            <Phone size={13} color="#EF4444" />
            <Text style={[styles.rowPrimary, { marginLeft: space.xs, color: color.ink }]}>
              Emergency numbers
            </Text>
          </View>
          <View style={styles.emergencyNumbers}>
            {e.emergency.all && (
              <Text style={styles.emergencyNum}>All: <Text style={styles.emergencyNumBold}>{e.emergency.all}</Text></Text>
            )}
            {e.emergency.police && (
              <Text style={styles.emergencyNum}>Police: <Text style={styles.emergencyNumBold}>{e.emergency.police}</Text></Text>
            )}
            {e.emergency.ambulance && (
              <Text style={styles.emergencyNum}>Ambulance: <Text style={styles.emergencyNumBold}>{e.emergency.ambulance}</Text></Text>
            )}
            {e.emergency.fire && (
              <Text style={styles.emergencyNum}>Fire: <Text style={styles.emergencyNumBold}>{e.emergency.fire}</Text></Text>
            )}
          </View>
          {/* ALWAYS render disclaimer for emergency sections — safety requirement */}
          <Text style={styles.disclaimer} accessibilityRole="text">
            {e.disclaimer}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TripCountryEssentialsSection({ tripId }: Props) {
  const [items, setItems] = useState<TripEssentialsItem[] | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getTripEssentials(tripId).then((res) => {
      if (!cancelled) setItems(res);
    });
    return () => { cancelled = true; };
  }, [tripId]);

  // Loading or flag off
  if (items == null) return null;

  // Filter to countries with coverage
  const covered = items.filter((i) => i.essentials != null);
  if (covered.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Good to know</Text>
      {covered.map((item) => (
        <EssentialsCard key={item.country} item={item} />
      ))}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    marginBottom: space.md,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
    marginBottom: space.md,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    marginBottom: space.sm,
    gap: space.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginBottom: space.xs,
  },
  cardTitle: {
    ...t.bodyStrong,
    color: color.deep,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowPrimary: {
    ...t.body,
    color: color.ink,
    fontSize: 13,
  },
  rowSecondary: {
    ...t.small,
    color: color.mute,
  },
  emergencyBlock: {
    gap: space.xs,
    marginTop: space.xs,
  },
  emergencyNumbers: {
    paddingLeft: 21,
    gap: 2,
  },
  emergencyNum: {
    ...t.small,
    color: color.mute,
  },
  emergencyNumBold: {
    fontWeight: '700',
    color: color.ink,
  },
  disclaimer: {
    ...t.small,
    color: color.faint,
    fontStyle: 'italic',
    marginTop: space.xs,
    paddingLeft: 21,
  },
});
