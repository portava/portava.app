/**
 * app/passport/country/[country].tsx
 *
 * Shows the current user's stamps for a single country, entered from the
 * passport country pin on the full-screen map.  The back button returns
 * the user to wherever they came from (the map).
 *
 * Below the stamp grid a "Good to know" section shows country essentials
 * (plug types, voltage, drive side, emergency numbers) when available.
 * The disclaimer is always rendered alongside emergency numbers.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Stamp, Info, Zap, Car, Phone } from 'lucide-react-native';
import { getMyPassportStamps } from '../../../src/services/passportStamps.ts';
import type { PassportStampNew } from '../../../src/services/passportStamps.ts';
import { StampGrid } from '../../../src/components/stamps/StampGrid.tsx';
import { StampDetailModal } from '../../../src/components/stamps/StampDetailModal.tsx';
import { getCountryEssentials, type CountryEssentials } from '../../../src/services/countryEssentials.ts';
import { color, space, radius, type as t, avatar } from '../../../src/theme/tokens.ts';

// ── Country essentials card ────────────────────────────────────────────────────

function plugHint(plugTypes: string[]): string {
  if (!plugTypes.length) return '';
  return `Type ${plugTypes.join(', ')} — bring a universal adapter`;
}

function driveLabel(side: string | null): string {
  if (!side) return '';
  return side === 'left' ? 'Drives on the left' : 'Drives on the right';
}

function CountryEssentialsCard({ essentials }: { essentials: CountryEssentials }) {
  const e = essentials;
  const hasEmergency = !!(e.emergency.all || e.emergency.police || e.emergency.ambulance || e.emergency.fire);

  return (
    <View style={es.card} accessibilityLabel="Good to know">
      <View style={es.cardHeader}>
        <Info size={14} color={color.deep} />
        <Text style={es.cardTitle}>Good to know</Text>
      </View>

      {/* Plug / power */}
      {(e.plugTypes.length > 0 || e.voltage != null || e.frequency != null) && (
        <View style={es.row}>
          <Zap size={13} color={color.mute} />
          <View style={es.rowText}>
            {e.plugTypes.length > 0 && (
              <Text style={es.rowPrimary}>{plugHint(e.plugTypes)}</Text>
            )}
            {(e.voltage != null || e.frequency != null) && (
              <Text style={es.rowSecondary}>
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
        <View style={es.row}>
          <Car size={13} color={color.mute} />
          <Text style={[es.rowPrimary, { marginLeft: space.xs }]}>
            {driveLabel(e.driveSide)}
          </Text>
        </View>
      )}

      {/* Emergency numbers */}
      {hasEmergency && (
        <View style={es.emergencyBlock}>
          <View style={es.row}>
            <Phone size={13} color="#EF4444" />
            <Text style={[es.rowPrimary, { marginLeft: space.xs, color: color.ink }]}>
              Emergency numbers
            </Text>
          </View>
          <View style={es.emergencyNumbers}>
            {e.emergency.all && (
              <Text style={es.emergencyNum}>All: <Text style={es.emergencyNumBold}>{e.emergency.all}</Text></Text>
            )}
            {e.emergency.police && (
              <Text style={es.emergencyNum}>Police: <Text style={es.emergencyNumBold}>{e.emergency.police}</Text></Text>
            )}
            {e.emergency.ambulance && (
              <Text style={es.emergencyNum}>Ambulance: <Text style={es.emergencyNumBold}>{e.emergency.ambulance}</Text></Text>
            )}
            {e.emergency.fire && (
              <Text style={es.emergencyNum}>Fire: <Text style={es.emergencyNumBold}>{e.emergency.fire}</Text></Text>
            )}
          </View>
          {/* ALWAYS render disclaimer for emergency sections — safety requirement */}
          <Text style={es.disclaimer} accessibilityRole="text">
            {e.disclaimer}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function CountryStampsScreen() {
  const { country: rawCountry } = useLocalSearchParams<{ country: string }>();
  const country = Array.isArray(rawCountry) ? rawCountry[0] : (rawCountry ?? '');
  const insets = useSafeAreaInsets();

  const [stamps, setStamps] = useState<PassportStampNew[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PassportStampNew | null>(null);

  const [essentials, setEssentials] = useState<CountryEssentials | null | undefined>(undefined);

  const load = useCallback(async () => {
    if (!country) return;
    setLoading(true);
    setError(null);
    const res = await getMyPassportStamps({ country });
    setLoading(false);
    if (res.ok) {
      setStamps(res.data);
    } else {
      setError(res.message ?? 'Could not load stamps');
    }
  }, [country]);

  useEffect(() => { load(); }, [load]);

  // Load country essentials (fail-soft: null = unavailable, skip section)
  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    getCountryEssentials(country).then((result) => {
      if (!cancelled) setEssentials(result);
    }).catch(() => {
      if (!cancelled) setEssentials(null);
    });
    return () => { cancelled = true; };
  }, [country]);

  const handleStampUpdated = useCallback((updated: PassportStampNew) => {
    setStamps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setSelected((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <Stamp size={16} color={color.signal} />
          <Text style={s.title} numberOfLines={1}>{country}</Text>
        </View>
        {/* Spacer to balance the back button */}
        <View style={s.backBtn} />
      </View>

      {/* Subtitle */}
      {!loading && !error && (
        <Text style={s.subtitle}>
          {stamps.length} {stamps.length === 1 ? 'stamp' : 'stamps'} earned
        </Text>
      )}

      {/* Content */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && stamps.length === 0 ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <StampGrid
            stamps={stamps}
            loading={loading}
            error={error}
            isOwner
            onRetry={load}
            onStampPress={setSelected}
            emptyTitle="No stamps for this country"
            emptySub="Stamps you earn here will appear once you travel to this country."
          />
        )}

        {/* "Good to know" — country essentials block */}
        {essentials != null && (
          <View style={s.essentialsWrapper}>
            <CountryEssentialsCard essentials={essentials} />
          </View>
        )}
      </ScrollView>

      <StampDetailModal
        stamp={selected}
        isOwner
        visible={selected !== null}
        onClose={() => setSelected(null)}
        onStampUpdated={handleStampUpdated}
        username={null}
      />
    </View>
  );
}

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
    width: avatar.s36, height: avatar.s36,
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  essentialsWrapper: {
    marginTop: space.xl,
    marginHorizontal: space.md,
    marginBottom: space.md,
  },
});

// ── Essentials card styles ─────────────────────────────────────────────────────

const es = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
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
