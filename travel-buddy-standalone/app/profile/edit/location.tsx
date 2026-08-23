/**
 * Location & Availability — Edit Profile & Settings sub-page.
 *
 * Absorbs the legacy app/settings/location.tsx (location mode, per-feature
 * visibility overrides, Safe Return, hotel/stay blur, trusted circle) AND
 * app/settings/find-your-circle.tsx (global toggle + consent sheet + per-type
 * defaults + pause). Both source screens save immediately (per-toggle), so we
 * preserve that behavior — there is no batched SaveBar here.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Pressable, Switch, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import {
  MapPin, Navigation, EyeOff, Users, ChevronRight, PauseCircle, PlayCircle, Eye,
} from 'lucide-react-native';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider, ToggleRow,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t, icon, dot} from '../../../src/theme/tokens';
import {
  getMyLocationPrivacy,
  updateMyLocationPrivacy,
  type LocationMode,
  type LocationVisibility,
  type LocationPrivacy,
  type LocationPrivacyPatch,
} from '../../../src/services/map';
import {
  getCircleSettings,
  patchCircleSettings,
  pauseAllCircleSharing,
  type CircleSettings,
  type ContextSharingDefault,
} from '../../../src/services/circle';
import { FindYourCircleConsentSheet } from '../../../src/components/FindYourCircleConsentSheet';
import { useSession } from '../../../src/context/SessionContext';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';

// ── Location constants (verbatim from settings/location.tsx) ────────────────

const MODE_INFO: Record<LocationMode, { label: string; description: string }> = {
  off: {
    label: 'Off',
    description: 'No location data shared. Discovery and Pulse show destination content only.',
  },
  city_only: {
    label: 'City only',
    description: 'Only your city is used. Great for discovery without sharing your neighborhood.',
  },
  nearby: {
    label: 'Nearby',
    description: 'Your neighborhood is used for nearby discovery and pulse. No exact location.',
  },
  live_during_activity: {
    label: 'Live during activity',
    description: 'Approximate location shared while plans or meetups are active.',
  },
  trusted_circle_live: {
    label: 'Trusted circle',
    description: 'Approximate location shared with your trusted circle. You control who sees it.',
  },
};

const VISIBILITY_LABELS: Record<LocationVisibility, string> = {
  city_only:    'City only',
  neighborhood: 'Neighborhood',
  venue_tagged: 'Venue tagged',
  exact_hidden: 'Exact hidden',
  no_location:  'No location',
};

const VISIBILITY_DESCRIPTIONS: Record<LocationVisibility, string> = {
  city_only:    'Only city name is shown on posts.',
  neighborhood: 'Neighborhood label shown (no exact address).',
  venue_tagged: 'Venue name shown if tagged.',
  exact_hidden: 'Location type shown but no specific area.',
  no_location:  'No location info on posts.',
};

const ORDERED_MODES: LocationMode[] = ['off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'];
const ORDERED_VISIBILITY: LocationVisibility[] = ['city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'];

// ── Find Your Circle constants (verbatim from settings/find-your-circle.tsx) ─

const CONTEXT_OPTIONS: Array<{ value: ContextSharingDefault; label: string; sub: string }> = [
  { value: 'off', label: 'Off', sub: 'You will not appear in circles for this type' },
  { value: 'status_only', label: 'Status only', sub: 'Co-travelers see your status (e.g. Active) — no location' },
  { value: 'approximate_area', label: 'Approximate area', sub: 'Co-travelers see a neighbourhood label you set' },
  { value: 'venue_checkin', label: 'Venue check-in', sub: 'Co-travelers see your venue name when you check in' },
];

// Mirrors the eligibility check in set_journey_observation_consent_v1
// (migration 2120): consent may only be granted while sharing is unpaused
// and the location mode is one of the two live-sharing modes.
function journeyEligible(prefs: LocationPrivacy): boolean {
  return !prefs.sharingPaused
    && (prefs.locationMode === 'live_during_activity' || prefs.locationMode === 'trusted_circle_live');
}

function journeyConsentSubtitle(prefs: LocationPrivacy): string {
  if (prefs.journeyObservationEnabled) {
    const granted = prefs.journeyConsentGrantedAt ? new Date(prefs.journeyConsentGrantedAt) : null;
    return granted && !isNaN(granted.getTime())
      ? `On — granted ${granted.toLocaleDateString()}`
      : 'On';
  }
  if (journeyEligible(prefs)) {
    return 'Off — turn on to allow Journey observation during this live-sharing window';
  }
  return 'Off — needs a live location mode and unpaused sharing';
}

// Mirrors the API's revokesJourneyConsent (journeySegmentRetention.ts): any
// patch that can grant OR revoke Journey observation consent server-side.
function touchesJourneyConsent(patch: LocationPrivacyPatch): boolean {
  return patch.journeyObservationEnabled !== undefined
    || patch.sharingPaused === true
    || (
      patch.locationMode !== undefined
      && patch.locationMode !== 'live_during_activity'
      && patch.locationMode !== 'trusted_circle_live'
    );
}

// ── Location prefs hook (verbatim save semantics from settings/location.tsx) ─

function useLocationPrefs() {
  const [prefs, setPrefs] = useState<LocationPrivacy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);

  useEffect(() => {
    let alive = true;
    getMyLocationPrivacy().then((p) => {
      if (alive) { setPrefs(p); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);

  const save = useCallback(async (patch: LocationPrivacyPatch) => {
    if (!prefs) return;
    if (saveLock.current) return;
    saveLock.current = true;
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    setSaving(true);
    try {
      const ok = await updateMyLocationPrivacy(patch);
      if (!ok) throw new Error('save_failed');
      // Journey consent grant/revocation is server-decided (versioned RPC,
      // server-stamped timestamps) and can also be revoked as a side effect of
      // this same patch (pausing sharing, or leaving a live location mode) —
      // see revokesJourneyConsent in the API. The optimistic merge above
      // cannot know any of that, so re-read authoritative state whenever the
      // patch could plausibly touch Journey consent rather than display a
      // guess.
      if (touchesJourneyConsent(patch)) {
        const fresh = await getMyLocationPrivacy();
        setPrefs(fresh);
      }
    } catch {
      setPrefs(previous);
      Alert.alert('Save failed', 'Could not save preferences. Please try again.');
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }, [prefs]);

  return { prefs, loading, saving, save };
}

// ── OptionSheet ─────────────────────────────────────────────────────────────

interface OptionItem { key: string; label: string; desc: string; selected: boolean; }

function OptionSheet({
  title, options, onSelect, onClose,
}: { title: string; options: OptionItem[]; onSelect: (k: string) => void; onClose: () => void }) {
  return (
    <Pressable style={sx.sheetOverlay} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button">
      <Pressable style={sx.sheet} onPress={(e) => e.stopPropagation()}>
        <Text style={sx.sheetTitle}>{title}</Text>
        {options.map((opt, i) => (
          <React.Fragment key={opt.key}>
            {i > 0 && <View style={sx.sheetDivider} />}
            <Pressable
              style={sx.sheetRow}
              onPress={() => onSelect(opt.key)}
              accessibilityRole="radio"
              accessibilityLabel={`${opt.label}: ${opt.desc}`}
              accessibilityState={{ checked: opt.selected }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[sx.sheetOptionLabel, opt.selected && sx.sheetOptionSelected]}>{opt.label}</Text>
                <Text style={sx.sheetOptionDesc}>{opt.desc}</Text>
              </View>
              {opt.selected && <View style={sx.checkDot} />}
            </Pressable>
          </React.Fragment>
        ))}
      </Pressable>
    </Pressable>
  );
}

// ── Circle default picker (chip-style radio, re-skinned) ─────────────────────

function DefaultPicker({
  value, onChange, disabled,
}: { value: ContextSharingDefault; onChange: (v: ContextSharingDefault) => void; disabled: boolean }) {
  return (
    <View style={{ gap: space.sm }}>
      {CONTEXT_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            style={[sx.radioRow, active && sx.radioRowActive]}
            onPress={() => onChange(opt.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={`${opt.label}: ${opt.sub}`}
            accessibilityState={{ checked: active }}
          >
            <View style={[sx.radio, active && sx.radioChecked]} />
            <View style={{ flex: 1 }}>
              <Text style={sx.radioLabel}>{opt.label}</Text>
              <Text style={sx.radioSub}>{opt.sub}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────

export default function LocationAvailabilityScreen() {
  return (
    <ScreenErrorBoundary>
      <LocationAvailabilityScreenInner />
    </ScreenErrorBoundary>
  );
}

function LocationAvailabilityScreenInner() {
  const { prefs, loading: locLoading, saving: locSaving, save } = useLocationPrefs();

  // Find Your Circle state (verbatim wiring from settings/find-your-circle.tsx)
  const { isAuthed, configured } = useSession();
  const live = configured && isAuthed;
  const [circleLoading, setCircleLoading] = useState(true);
  const [circleSaving, setCircleSaving] = useState(false);
  const [circleLoadError, setCircleLoadError] = useState(false);
  const [settings, setSettings] = useState<CircleSettings | null>(null);
  const [consentSheetVisible, setConsentSheetVisible] = useState(false);
  const [pendingEnable, setPendingEnable] = useState(false);

  const loadCircle = useCallback(async () => {
    if (!live) { setCircleLoading(false); return; }
    setCircleLoading(true);
    setCircleLoadError(false);
    const res = await getCircleSettings();
    setCircleLoading(false);
    if (res.ok) setSettings(res.data);
    else setCircleLoadError(true);
  }, [live]);

  useEffect(() => { loadCircle(); }, [loadCircle]);

  const [showModeSheet, setShowModeSheet] = useState(false);
  const [showPulseSheet, setShowPulseSheet] = useState(false);
  const [showDiscoverySheet, setShowDiscoverySheet] = useState(false);

  async function applyPatch(patch: Parameters<typeof patchCircleSettings>[0]) {
    setCircleSaving(true);
    const res = await patchCircleSettings(patch);
    setCircleSaving(false);
    if (res.ok) setSettings(res.data);
    else if (res.status === 409) loadCircle();
    else Alert.alert('Error', 'Could not save. Please try again.');
  }

  async function handleGlobalToggle(value: boolean) {
    if (!settings) return;
    if (value) {
      if (!settings.consentedAt) {
        setPendingEnable(true);
        setConsentSheetVisible(true);
        return;
      }
      await applyPatch({ globalEnabled: true });
    } else {
      await applyPatch({ globalEnabled: false });
    }
  }

  async function handleConsentAccept(consentVersion: string) {
    setConsentSheetVisible(false);
    setPendingEnable(false);
    await applyPatch({ globalEnabled: true, consentVersion });
  }

  function handleConsentDismiss() {
    setConsentSheetVisible(false);
    setPendingEnable(false);
  }

  async function handlePauseToggle(value: boolean) {
    if (!settings) return;
    if (value) {
      setCircleSaving(true);
      const res = await pauseAllCircleSharing();
      setCircleSaving(false);
      if (res.ok) setSettings(res.data);
      else Alert.alert('Error', 'Could not pause sharing. Try again.');
    } else {
      await applyPatch({ isPaused: false });
    }
  }

  const savingIndicator = (locSaving || circleSaving)
    ? <ActivityIndicator size="small" color={PP.ink} />
    : null;

  if (locLoading || circleLoading) {
    return (
      <SettingsScreen title="Location & Availability" subtitle="Location sharing, Find Your Circle">
        <View style={{ paddingVertical: space.xxxl, alignItems: 'center' }}>
          <ActivityIndicator color={PP.ink} />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen
      title="Location & Availability"
      subtitle="Location sharing, Find Your Circle"
      right={savingIndicator}
    >
      {prefs && (
        <>
          {/* Sharing pause */}
          <SettingsSection title="Sharing">
            <ToggleRow
              title="Pause sharing"
              subtitle="Temporarily stop all location sharing"
              value={prefs.sharingPaused}
              onValueChange={(v) => save({ sharingPaused: v })}
            />
          </SettingsSection>

          {/* Location mode */}
          <SettingsSection title="Location Mode">
            <SettingsRow
              icon={<ModeIcon mode={prefs.locationMode} />}
              title={MODE_INFO[prefs.locationMode].label}
              subtitle={MODE_INFO[prefs.locationMode].description}
              onPress={() => setShowModeSheet(true)}
            />
          </SettingsSection>

          {/* Journey Privacy — journey_observation_v1 consent. A distinct,
              versioned, server-managed purpose (see set_journey_observation_
              consent_v1 in migration 2120) from ordinary location sharing
              above: granting/revoking always goes through this explicit
              toggle, never inferred from location mode alone. */}
          <SettingsSection
            title="Journey Privacy"
            subtitle="Optional: let Portava observe your movement during a live-sharing window to build richer trip insights"
          >
            <ToggleRow
              title="Journey observation"
              subtitle={journeyConsentSubtitle(prefs)}
              value={prefs.journeyObservationEnabled}
              onValueChange={(v) => save({ journeyObservationEnabled: v })}
              disabled={!journeyEligible(prefs) && !prefs.journeyObservationEnabled}
            />
          </SettingsSection>
          {!journeyEligible(prefs) && !prefs.journeyObservationEnabled && (
            <Text style={sx.note}>
              Requires Location Mode set to "Live during activity" (or "Trusted circle") above, with sharing not paused.
            </Text>
          )}

          {/* Feature visibility overrides */}
          <SettingsSection
            title="Feature Visibility"
            subtitle="Override default visibility for specific features"
          >
            <SettingsRow
              title="Pulse posts"
              subtitle={prefs.pulseVisibility ? VISIBILITY_LABELS[prefs.pulseVisibility] : `Default (${VISIBILITY_LABELS['city_only']})`}
              onPress={() => setShowPulseSheet(true)}
            />
            <SettingsDivider />
            <SettingsRow
              title="Discovery"
              subtitle={prefs.discoveryVisibility ? VISIBILITY_LABELS[prefs.discoveryVisibility] : 'Default (City only)'}
              onPress={() => setShowDiscoverySheet(true)}
            />
          </SettingsSection>

          {/* Safety */}
          <SettingsSection title="Safety">
            <ToggleRow
              title="Safe Return"
              subtitle="Enable location-based safety sessions for meetups"
              value={prefs.safeReturnEnabled}
              onValueChange={(v) => save({ safeReturnEnabled: v })}
            />
            <SettingsDivider />
            <ToggleRow
              title="Privacy blur near stays"
              subtitle="Auto-cap posts near your accommodation to neighborhood only"
              value={prefs.hotelBlurEnabled}
              onValueChange={(v) => save({ hotelBlurEnabled: v })}
            />
          </SettingsSection>

          {/* Trusted circle */}
          <SettingsSection title="Trusted Circle">
            <ToggleRow
              title="Live share with trusted circle"
              subtitle="Share your approximate location with your trusted circle members"
              value={prefs.trustedCircleShare}
              onValueChange={(v) => save({ trustedCircleShare: v })}
            />
          </SettingsSection>
          {prefs.trustedCircleShare && (
            <Text style={sx.note}>Trusted circle management coming soon</Text>
          )}

          <Text style={sx.note}>
            Your exact GPS coordinates are never shared publicly. All public surfaces show only city,
            neighborhood, or approximate distance.
          </Text>
        </>
      )}

      {/* Find Your Circle */}
      {!live ? (
        <SettingsSection title="Find Your Circle">
          <View style={{ padding: space.lg }}>
            <Text style={sx.errorText}>Sign in to manage Find Your Circle.</Text>
          </View>
        </SettingsSection>
      ) : circleLoadError || !settings ? (
        <SettingsSection title="Find Your Circle">
          <View style={{ padding: space.lg, gap: space.md, alignItems: 'center' }}>
            <Text style={sx.errorText}>Failed to load settings.</Text>
            <Pressable style={sx.retryBtn} onPress={loadCircle}>
              <Text style={sx.retryText}>Try again</Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="Find Your Circle">
            <ToggleRow
              title="Find Your Circle"
              subtitle={
                settings.globalEnabled
                  ? (settings.isPaused
                    ? 'Paused — no one can see you right now'
                    : 'On — co-travelers in your trips and events can see you')
                  : 'Off — no one can see your status in any circle'
              }
              value={settings.globalEnabled}
              onValueChange={handleGlobalToggle}
              disabled={circleSaving || pendingEnable}
            />
          </SettingsSection>

          {settings.globalEnabled && (
            <>
              {settings.isPaused && (
                <View style={sx.pauseBanner}>
                  <PauseCircle size={16} color={PP.gold} />
                  <Text style={sx.pauseBannerText}>
                    All sharing paused. No co-traveler can see you right now.
                  </Text>
                </View>
              )}

              <SettingsSection title="Sharing Pause">
                <SettingsRow
                  icon={settings.isPaused
                    ? <PlayCircle size={18} color={PP.gold} />
                    : <PauseCircle size={18} color={PP.inkMuted} />}
                  title={settings.isPaused ? 'Resume sharing' : 'Pause all sharing'}
                  subtitle={settings.isPaused
                    ? 'Become visible again in all your circles'
                    : 'Instantly hide yourself from all circles'}
                  right={
                    <Switch
                      value={settings.isPaused}
                      onValueChange={handlePauseToggle}
                      trackColor={{ true: PP.gold, false: PP.paperShadow }}
                      thumbColor="#FFFFFF"
                      disabled={circleSaving}
                    />
                  }
                />
              </SettingsSection>

              <SettingsSection
                title="Trip Sharing Default"
                subtitle="Default level of detail shared in trip circles. Can be overridden per trip."
              >
                <View style={{ padding: space.md }}>
                  <DefaultPicker
                    value={settings.tripSharingDefault}
                    onChange={(v) => applyPatch({ tripSharingDefault: v })}
                    disabled={circleSaving}
                  />
                </View>
              </SettingsSection>

              <SettingsSection
                title="Event Sharing Default"
                subtitle="Default level of detail shared in event circles. Can be overridden per event."
              >
                <View style={{ padding: space.md }}>
                  <DefaultPicker
                    value={settings.eventSharingDefault}
                    onChange={(v) => applyPatch({ eventSharingDefault: v })}
                    disabled={circleSaving}
                  />
                </View>
              </SettingsSection>
            </>
          )}
        </>
      )}

      {/* Who Can See Me — screen stays */}
      <SettingsSection title="Visibility">
        <SettingsRow
          icon={<Users size={18} color={PP.ink} />}
          title="Who Can See Me"
          subtitle="See who in each trip and event can view your status"
          onPress={() => router.push('/profile/edit/who-can-see-me' as any)}
        />
      </SettingsSection>

      <Text style={sx.note}>
        Your Circle only includes people already in the same trip or event as you.
        Followers and other users cannot see your status. Your exact GPS coordinates are never shared.
      </Text>

      {/* Sheets */}
      {showModeSheet && (
        <OptionSheet
          title="Location Mode"
          options={ORDERED_MODES.map((m) => ({
            key: m,
            label: MODE_INFO[m].label,
            desc: MODE_INFO[m].description,
            selected: prefs?.locationMode === m,
          }))}
          onSelect={(k) => { save({ locationMode: k as LocationMode }); setShowModeSheet(false); }}
          onClose={() => setShowModeSheet(false)}
        />
      )}

      {showPulseSheet && (
        <OptionSheet
          title="Pulse Visibility"
          options={[
            { key: '__inherit__', label: 'Default (follow mode)', desc: 'Use your location mode default', selected: !prefs?.pulseVisibility },
            ...ORDERED_VISIBILITY.map((v) => ({
              key: v,
              label: VISIBILITY_LABELS[v],
              desc: VISIBILITY_DESCRIPTIONS[v],
              selected: prefs?.pulseVisibility === v,
            })),
          ]}
          onSelect={(k) => {
            save({ pulseVisibility: k === '__inherit__' ? null : (k as LocationVisibility) });
            setShowPulseSheet(false);
          }}
          onClose={() => setShowPulseSheet(false)}
        />
      )}

      {showDiscoverySheet && (
        <OptionSheet
          title="Discovery Visibility"
          options={[
            { key: '__inherit__', label: 'Default', desc: 'City only for discovery', selected: !prefs?.discoveryVisibility },
            ...ORDERED_VISIBILITY.slice(0, 3).map((v) => ({
              key: v,
              label: VISIBILITY_LABELS[v],
              desc: VISIBILITY_DESCRIPTIONS[v],
              selected: prefs?.discoveryVisibility === v,
            })),
          ]}
          onSelect={(k) => {
            save({ discoveryVisibility: k === '__inherit__' ? null : (k as LocationVisibility) });
            setShowDiscoverySheet(false);
          }}
          onClose={() => setShowDiscoverySheet(false)}
        />
      )}

      {settings && (
        <FindYourCircleConsentSheet
          visible={consentSheetVisible}
          consentVersion={settings.currentConsentVersion}
          onAccept={handleConsentAccept}
          onDismiss={handleConsentDismiss}
        />
      )}
    </SettingsScreen>
  );
}

function ModeIcon({ mode }: { mode: LocationMode }) {
  const c = mode === 'off' ? PP.inkMuted : PP.ink;
  if (mode === 'off') return <EyeOff size={18} color={c} />;
  if (mode === 'city_only') return <MapPin size={18} color={c} />;
  if (mode === 'trusted_circle_live') return <Users size={18} color={c} />;
  if (mode === 'live_during_activity' || mode === 'nearby') return <Navigation size={18} color={c} />;
  return <Eye size={18} color={c} />;
}

const sx = StyleSheet.create({
  note: {
    ...t.small, color: PP.inkMuted, fontSize: 11, lineHeight: 15,
    textAlign: 'center', paddingHorizontal: space.md,
  },
  errorText: { ...t.body, color: PP.inkMuted, textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: space.xl, paddingVertical: space.sm,
    backgroundColor: PP.ink, borderRadius: radius.pill,
  },
  retryText: { ...t.bodyStrong, color: PP.paper, fontSize: 14 },

  pauseBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: PP.goldLight, borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.gold + '40',
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  pauseBannerText: { ...t.small, color: PP.gold, flex: 1, lineHeight: 17 },

  radioRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    backgroundColor: '#FFFDF7', borderWidth: 1, borderColor: PP.borderLight,
    borderRadius: radius.md, padding: space.md,
  },
  radioRowActive: { borderColor: PP.ink, backgroundColor: PP.paperDeep },
  radio: {
    width: icon.s18, height: icon.s18, borderRadius: icon.s18 / 2, borderWidth: 2,
    borderColor: PP.border, marginTop: 2, flexShrink: 0,
  },
  radioChecked: { borderColor: PP.ink, backgroundColor: PP.ink },
  radioLabel: { ...t.bodyStrong, color: PP.ink, fontSize: 14 },
  radioSub: { ...t.small, color: PP.inkMuted, marginTop: 1, lineHeight: 17 },

  sheetOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: PP.paper,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingTop: space.lg, paddingBottom: space.xxxl, paddingHorizontal: space.lg,
  },
  sheetTitle: { ...t.bodyStrong, color: PP.ink, fontSize: 15, fontWeight: '700', marginBottom: space.md },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: PP.borderLight },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, gap: space.md },
  sheetOptionLabel: { ...t.body, color: PP.ink, fontSize: 14, fontWeight: '600' },
  sheetOptionSelected: { color: PP.inkLight },
  sheetOptionDesc: { ...t.small, color: PP.inkMuted, fontSize: 12, lineHeight: 16 },
  checkDot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: PP.inkLight },
});
