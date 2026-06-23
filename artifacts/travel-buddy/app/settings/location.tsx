/**
 * Location Settings screen
 *
 * Accessible from profile/settings. Shows:
 * - Current location mode with description
 * - Pause-sharing toggle
 * - Per-feature visibility selectors (Pulse, Discovery)
 * - Safe Return toggle
 * - Trusted-circle live share management stub
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Switch, ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ArrowLeft, MapPin, Navigation, EyeOff, Shield, Users, ChevronRight } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
// ── Types ─────────────────────────────────────────────────────────────────────

type LocationMode = 'off' | 'city_only' | 'nearby' | 'live_during_activity' | 'trusted_circle_live';
type VisibilityOption = 'city_only' | 'neighborhood' | 'venue_tagged' | 'exact_hidden' | 'no_location';

interface LocationPrefs {
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: VisibilityOption | null;
  discoveryVisibility: VisibilityOption | null;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
}

const MODE_INFO: Record<LocationMode, { label: string; description: string; Icon: React.ComponentType<any> }> = {
  off: {
    label: 'Off',
    description: 'No location data shared. Discovery and Pulse show destination content only.',
    Icon: EyeOff,
  },
  city_only: {
    label: 'City only',
    description: 'Only your city is used. Great for discovery without sharing your neighborhood.',
    Icon: MapPin,
  },
  nearby: {
    label: 'Nearby',
    description: 'Your neighborhood is used for nearby discovery and pulse. No exact location.',
    Icon: Navigation,
  },
  live_during_activity: {
    label: 'Live during activity',
    description: 'Approximate location shared while plans or meetups are active.',
    Icon: Navigation,
  },
  trusted_circle_live: {
    label: 'Trusted circle',
    description: 'Approximate location shared with your trusted circle. You control who sees it.',
    Icon: Users,
  },
};

const VISIBILITY_LABELS: Record<VisibilityOption, string> = {
  city_only:    'City only',
  neighborhood: 'Neighborhood',
  venue_tagged: 'Venue tagged',
  exact_hidden: 'Exact hidden',
  no_location:  'No location',
};

const ORDERED_MODES: LocationMode[] = ['off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'];
const ORDERED_VISIBILITY: VisibilityOption[] = ['city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'];

// ── Hook: load/save preferences ───────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  try {
    const { supabase } = await import('../../src/lib/supabase');
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

function useLocationPrefs() {
  const [prefs, setPrefs] = useState<LocationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const apiBase = (process.env as any).EXPO_PUBLIC_API_BASE_URL ?? '';

  const defaultPrefs: LocationPrefs = {
    locationMode: 'city_only',
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    safeReturnEnabled: true,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await getToken();
      if (!token) { if (alive) { setPrefs(defaultPrefs); setLoading(false); } return; }
      try {
        const r = await fetch(`${apiBase}/api/me/location-preferences`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        if (alive) {
          setPrefs({
            locationMode:        d.locationMode ?? 'city_only',
            sharingPaused:       Boolean(d.sharingPaused),
            pulseVisibility:     d.pulseVisibility ?? null,
            discoveryVisibility: d.discoveryVisibility ?? null,
            safeReturnEnabled:   d.safeReturnEnabled !== false,
            trustedCircleShare:  Boolean(d.trustedCircleShare),
            hotelBlurEnabled:    d.hotelBlurEnabled !== false,
          });
        }
      } catch {
        if (alive) setPrefs(defaultPrefs);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async (patch: Partial<LocationPrefs>) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    setSaving(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('not_authed');
      await fetch(`${apiBase}/api/me/location-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
    } catch {
      setPrefs(previous);
      Alert.alert('Save failed', 'Could not save preferences. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [prefs, apiBase]);

  return { prefs, loading, saving, save };
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function LocationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { prefs, loading, saving, save } = useLocationPrefs();
  const [showModeSheet, setShowModeSheet] = useState(false);
  const [showPulseSheet, setShowPulseSheet] = useState(false);
  const [showDiscoverySheet, setShowDiscoverySheet] = useState(false);

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Location</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (!prefs) return null;

  const currentMode = MODE_INFO[prefs.locationMode];
  const ModeIcon = currentMode.Icon;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Location</Text>
        {saving && <ActivityIndicator size="small" color={color.signal} style={{ marginLeft: 'auto' }} />}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        {/* Pause sharing */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SHARING</Text>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Pause sharing</Text>
              <Text style={styles.rowDesc}>Temporarily stop all location sharing</Text>
            </View>
            <Switch
              value={prefs.sharingPaused}
              onValueChange={(v) => save({ sharingPaused: v })}
              trackColor={{ true: color.signal }}
            />
          </View>
        </View>

        {/* Location mode */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LOCATION MODE</Text>
          <Pressable
            style={styles.modeCard}
            onPress={() => setShowModeSheet(true)}
          >
            <View style={[styles.modeIconWrap, prefs.locationMode === 'off' && styles.modeIconOff]}>
              <ModeIcon size={18} color={prefs.locationMode === 'off' ? color.faint : color.signal} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.modeLabel}>{currentMode.label}</Text>
              <Text style={styles.modeDesc}>{currentMode.description}</Text>
            </View>
            <ChevronRight size={16} color={color.faint} />
          </Pressable>
        </View>

        {/* Per-feature overrides */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>FEATURE VISIBILITY</Text>
          <Text style={styles.sectionNote}>Override default visibility for specific features</Text>

          <Pressable style={styles.row} onPress={() => setShowPulseSheet(true)}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Pulse posts</Text>
              <Text style={styles.rowDesc}>
                {prefs.pulseVisibility ? VISIBILITY_LABELS[prefs.pulseVisibility] : `Default (${VISIBILITY_LABELS['city_only']})`}
              </Text>
            </View>
            <ChevronRight size={16} color={color.faint} />
          </Pressable>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={() => setShowDiscoverySheet(true)}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Discovery</Text>
              <Text style={styles.rowDesc}>
                {prefs.discoveryVisibility ? VISIBILITY_LABELS[prefs.discoveryVisibility] : 'Default (City only)'}
              </Text>
            </View>
            <ChevronRight size={16} color={color.faint} />
          </Pressable>
        </View>

        {/* Safety features */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SAFETY</Text>

          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Safe Return</Text>
              <Text style={styles.rowDesc}>Enable location-based safety sessions for meetups</Text>
            </View>
            <Switch
              value={prefs.safeReturnEnabled}
              onValueChange={(v) => save({ safeReturnEnabled: v })}
              trackColor={{ true: color.signal }}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Privacy blur near stays</Text>
              <Text style={styles.rowDesc}>Auto-cap posts near your accommodation to neighborhood only</Text>
            </View>
            <Switch
              value={prefs.hotelBlurEnabled}
              onValueChange={(v) => save({ hotelBlurEnabled: v })}
              trackColor={{ true: color.signal }}
            />
          </View>
        </View>

        {/* Trusted circle (stub) */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>TRUSTED CIRCLE</Text>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Live share with trusted circle</Text>
              <Text style={styles.rowDesc}>Share your approximate location with your trusted circle members</Text>
            </View>
            <Switch
              value={prefs.trustedCircleShare}
              onValueChange={(v) => save({ trustedCircleShare: v })}
              trackColor={{ true: color.signal }}
            />
          </View>
          {prefs.trustedCircleShare && (
            <Text style={styles.comingSoon}>Trusted circle management coming soon</Text>
          )}
        </View>

        <Text style={styles.privacyNote}>
          Your exact GPS coordinates are never shared publicly. All public surfaces show only city, neighborhood, or approximate distance.
        </Text>
      </ScrollView>

      {/* Mode sheet */}
      {showModeSheet && (
        <OptionSheet
          title="Location Mode"
          options={ORDERED_MODES.map((m) => ({
            key: m,
            label: MODE_INFO[m].label,
            desc: MODE_INFO[m].description,
            selected: prefs.locationMode === m,
          }))}
          onSelect={(k) => { save({ locationMode: k as LocationMode }); setShowModeSheet(false); }}
          onClose={() => setShowModeSheet(false)}
        />
      )}

      {/* Pulse visibility sheet */}
      {showPulseSheet && (
        <OptionSheet
          title="Pulse Visibility"
          options={[
            { key: '__inherit__', label: 'Default (follow mode)', desc: 'Use your location mode default', selected: !prefs.pulseVisibility },
            ...ORDERED_VISIBILITY.map((v) => ({
              key: v,
              label: VISIBILITY_LABELS[v],
              desc: VISIBILITY_DESCRIPTIONS[v],
              selected: prefs.pulseVisibility === v,
            })),
          ]}
          onSelect={(k) => {
            save({ pulseVisibility: k === '__inherit__' ? null : (k as VisibilityOption) });
            setShowPulseSheet(false);
          }}
          onClose={() => setShowPulseSheet(false)}
        />
      )}

      {/* Discovery visibility sheet */}
      {showDiscoverySheet && (
        <OptionSheet
          title="Discovery Visibility"
          options={[
            { key: '__inherit__', label: 'Default', desc: 'City only for discovery', selected: !prefs.discoveryVisibility },
            ...ORDERED_VISIBILITY.slice(0, 3).map((v) => ({
              key: v,
              label: VISIBILITY_LABELS[v],
              desc: VISIBILITY_DESCRIPTIONS[v],
              selected: prefs.discoveryVisibility === v,
            })),
          ]}
          onSelect={(k) => {
            save({ discoveryVisibility: k === '__inherit__' ? null : (k as VisibilityOption) });
            setShowDiscoverySheet(false);
          }}
          onClose={() => setShowDiscoverySheet(false)}
        />
      )}
    </View>
  );
}

// ── OptionSheet ───────────────────────────────────────────────────────────────

interface OptionItem { key: string; label: string; desc: string; selected: boolean; }

function OptionSheet({
  title,
  options,
  onSelect,
  onClose,
}: { title: string; options: OptionItem[]; onSelect: (k: string) => void; onClose: () => void }) {
  return (
    <Pressable style={styles.sheetOverlay} onPress={onClose}>
      <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {options.map((opt, i) => (
          <React.Fragment key={opt.key}>
            {i > 0 && <View style={styles.divider} />}
            <Pressable style={styles.sheetRow} onPress={() => onSelect(opt.key)}>
              <View style={styles.rowContent}>
                <Text style={[styles.sheetOptionLabel, opt.selected && styles.sheetOptionSelected]}>
                  {opt.label}
                </Text>
                <Text style={styles.rowDesc}>{opt.desc}</Text>
              </View>
              {opt.selected && (
                <View style={styles.checkDot} />
              )}
            </Pressable>
          </React.Fragment>
        ))}
      </Pressable>
    </Pressable>
  );
}

const VISIBILITY_DESCRIPTIONS: Record<VisibilityOption, string> = {
  city_only:    'Only city name is shown on posts.',
  neighborhood: 'Neighborhood label shown (no exact address).',
  venue_tagged: 'Venue name shown if tagged.',
  exact_hidden: 'Location type shown but no specific area.',
  no_location:  'No location info on posts.',
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  backBtn: {
    padding: space.xs,
    marginLeft: -space.xs,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: color.faint,
    marginBottom: space.sm,
  },
  sectionNote: {
    fontSize: 12,
    color: color.mute,
    marginBottom: space.md,
    marginTop: -space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
  },
  rowContent: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },
  rowDesc: {
    fontSize: 12,
    color: color.mute,
    lineHeight: 16,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginHorizontal: space.lg,
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.md,
  },
  modeIconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: color.signal + '14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeIconOff: {
    backgroundColor: color.haze,
  },
  modeLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: color.ink,
  },
  modeDesc: {
    fontSize: 12,
    color: color.mute,
    marginTop: 2,
    lineHeight: 16,
  },
  comingSoon: {
    fontSize: 11,
    color: color.faint,
    fontStyle: 'italic',
    marginTop: space.sm,
    paddingHorizontal: space.sm,
  },
  privacyNote: {
    fontSize: 11,
    color: color.faint,
    lineHeight: 15,
    marginHorizontal: space.xl,
    marginTop: space.xl,
    textAlign: 'center',
  },
  sheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
    paddingBottom: space.xxxl,
    paddingHorizontal: space.lg,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: color.ink,
    marginBottom: space.md,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    gap: space.md,
  },
  sheetOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: color.ink,
  },
  sheetOptionSelected: {
    color: color.signal,
  },
  checkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.signal,
  },
});
