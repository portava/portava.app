/**
 * Compass Preferences Screen
 *
 * Controls personalisation, visibility, notification preferences, and the
 * "Boost my visibility" toggle with granular sub-controls.
 *
 * Accessible from: Profile → Settings → Compass Preferences
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Switch,
  ActivityIndicator, Alert, SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Sparkles, Eye, EyeOff, Bell, Shield, Zap,
  ChevronDown, ChevronUp, Check, Globe, Users,
} from 'lucide-react-native';
import { color, space, radius, type as t, icon, dot} from '../src/theme/tokens';
import { useCompassPreferences } from '../src/hooks/compass/useCompassPreferences';
import {
  putCompassBoostVisibility,
  fetchCompassSenseSettings,
  putCompassSenseSettings,
  type CompassSenseSettings,
  type CompassSensePresence,
} from '../src/services/compass';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

// ── Option constants ──────────────────────────────────────────────────────────

const INTEREST_OPTIONS = [
  'nightlife', 'food', 'beach', 'luxury', 'culture', 'adventure',
  'wellness', 'photography', 'backpacking', 'shopping', 'business',
  'events', 'nature', 'sports', 'art', 'music',
];

const BUDGET_STYLES = ['budget', 'mid_range', 'luxury', 'any'];

const TRAVEL_STYLES = [
  'solo', 'couple', 'group', 'family', 'digital_nomad', 'backpacker',
];

const LANGUAGE_OPTIONS = [
  'en', 'es', 'fr', 'de', 'pt', 'it', 'ja', 'zh', 'ko', 'ar',
  'ru', 'hi', 'nl', 'pl', 'tr',
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
  pt: 'Português', it: 'Italiano', ja: '日本語', zh: '中文',
  ko: '한국어', ar: 'العربية', ru: 'Русский', hi: 'हिन्दी',
  nl: 'Nederlands', pl: 'Polski', tr: 'Türkçe',
};

const SAFETY_PREFERENCES = [
  { key: 'standard',    label: 'Standard'    },
  { key: 'cautious',    label: 'Cautious'    },
  { key: 'very_safe',   label: 'Very safe only' },
];

const LOCATION_MODES = [
  { key: 'full_sharing', label: 'Full sharing' },
  { key: 'city_only',    label: 'City only'    },
  { key: 'private',      label: 'Private'      },
];

const NOTIFICATION_KEYS: { key: string; label: string }[] = [
  { key: 'new_recommendation',  label: 'New personalized recommendations' },
  { key: 'nearby_traveler',     label: 'Travelers nearby with shared interests' },
  { key: 'trending_city',       label: 'Trending spots in your city' },
  { key: 'buddy_available',     label: 'Buddies available in your city' },
  { key: 'event_match',         label: 'Events that match your interests' },
];

const VISIBILITY_SUB: { key: string; label: string }[] = [
  { key: 'show_in_nearby',      label: 'Show me in Nearby Travelers' },
  { key: 'wider_post_reach',    label: 'Boost my posts to a wider audience' },
  { key: 'recommend_events',    label: 'Recommend my events to others' },
  { key: 'recommend_crew',      label: 'Recommend me for Trip Crew' },
  { key: 'boost_buddy_profile', label: 'Show my Buddy profile more often' },
];

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title, Icon, children,
}: {
  title: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
  children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Icon size={16} color={color.signal} />
        <Text style={s.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

// ── Toggle row ────────────────────────────────────────────────────────────────

function ToggleRow({
  label, value, onChange, sub,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void; sub?: string;
}) {
  return (
    <View style={s.toggleRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        {sub && <Text style={s.toggleSub}>{sub}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.haze, true: color.signal + '88' }}
        thumbColor={value ? color.signal : '#fff'}
      />
    </View>
  );
}

// ── Chip selector ─────────────────────────────────────────────────────────────

function ChipSelector({
  options, selected, onToggle, labelMap,
}: {
  options: string[];
  selected: string[];
  onToggle: (key: string) => void;
  labelMap?: Record<string, string>;
}) {
  return (
    <View style={s.chipWrap}>
      {options.map((opt) => {
        const active = selected.includes(opt);
        return (
          <Pressable
            key={opt}
            style={[s.chip, active && s.chipActive]}
            onPress={() => onToggle(opt)}
          >
            {active && <Check size={10} color={color.signal} />}
            <Text style={[s.chipLabel, active && s.chipLabelActive]}>
              {labelMap?.[opt] ?? opt.replace(/_/g, ' ')}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Compass Sense section ─────────────────────────────────────────────────────

const SENSE_PRESENCE_LEVELS: { key: CompassSensePresence; label: string; sub: string }[] = [
  { key: 'passive', label: 'Passive', sub: 'Compass Sense stays silent' },
  { key: 'aware',   label: 'Aware',   sub: 'Only time-critical nudges (timing, events, weather)' },
  { key: 'active',  label: 'Active',  sub: 'All helpful nudges, still capped per day' },
];

const SENSE_CATEGORY_ROWS: { key: string; label: string; sub: string }[] = [
  { key: 'timing',    label: 'Leave-earlier alerts',   sub: 'When travel time threatens a planned arrival' },
  { key: 'events',    label: 'Saved events',           sub: 'When an event you saved starts soon' },
  { key: 'weather',   label: 'Weather changes',        sub: 'When the forecast affects today\u2019s plans' },
  { key: 'circle',    label: 'Circle plan changes',    sub: 'When a meetup you joined changes' },
  { key: 'free_time', label: 'Free time suggestions',  sub: 'When a free block opens in your day' },
];

function SenseSection() {
  const [sense, setSense] = useState<CompassSenseSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const r = await fetchCompassSenseSettings();
      if (!mounted) return;
      if (r.ok && r.compassEnabled === false) { setEnabled(false); return; }
      if (r.ok && r.data) setSense(r.data);
    })();
    return () => { mounted = false; };
  }, []);

  const save = useCallback(async (patch: { presenceLevel?: CompassSensePresence; categories?: Record<string, boolean> }) => {
    if (busy) return;
    setBusy(true);
    const r = await putCompassSenseSettings(patch);
    if (r.ok && r.data) setSense(r.data);
    setBusy(false);
  }, [busy]);

  if (!enabled || !sense) return null;

  return (
    <Section title="Compass Sense" Icon={Bell}>
      <Text style={s.fieldSubLabel}>
        Proactive nudges that stay quiet unless something genuinely useful comes up.
        Everything is enforced server-side with daily caps and quiet hours.
      </Text>
      <Text style={[s.fieldLabel, { marginTop: space.sm }]}>Presence level</Text>
      {SENSE_PRESENCE_LEVELS.map((p) => (
        <Pressable
          key={p.key}
          style={s.radioRow}
          onPress={() => save({ presenceLevel: p.key })}
        >
          <View style={[s.radio, sense.presenceLevel === p.key && s.radioActive]}>
            {sense.presenceLevel === p.key && <View style={s.radioDot} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.radioLabel}>{p.label}</Text>
            <Text style={s.fieldSubLabel}>{p.sub}</Text>
          </View>
        </Pressable>
      ))}
      {sense.presenceLevel !== 'passive' && (
        <>
          <Text style={[s.fieldLabel, { marginTop: space.md }]}>Nudge categories</Text>
          {SENSE_CATEGORY_ROWS.map((c) => (
            <ToggleRow
              key={c.key}
              label={c.label}
              sub={c.sub}
              value={sense.categories[c.key] !== false}
              onChange={(v) => save({ categories: { [c.key]: v } })}
            />
          ))}
        </>
      )}
    </Section>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function CompassPreferencesScreen() {
  const insets = useSafeAreaInsets();
  const { prefs, loading, saving, update } = useCompassPreferences();
  const [boostExpanded, setBoostExpanded] = useState(false);
  const navBarScrollHandler = useNavBarScrollHandler();

  const toggle = useCallback(
    async (key: keyof import('../src/services/compass').CompassPreferences, value: unknown) => {
      await update({ [key]: value } as any);
    },
    [update],
  );

  const toggleInterest = useCallback(async (interest: string) => {
    const current = prefs?.interests ?? [];
    const next = current.includes(interest)
      ? current.filter((i) => i !== interest)
      : [...current, interest];
    await update({ interests: next });
  }, [prefs, update]);

  const toggleTravelStyle = useCallback(async (style: string) => {
    const current = prefs?.travel_styles ?? [];
    const next = current.includes(style)
      ? current.filter((s) => s !== style)
      : [...current, style];
    await update({ travel_styles: next });
  }, [prefs, update]);

  const toggleLanguage = useCallback(async (lang: string) => {
    const current = prefs?.preferred_languages ?? [];
    const next = current.includes(lang)
      ? current.filter((l) => l !== lang)
      : [...current, lang];
    await update({ preferred_languages: next });
  }, [prefs, update]);

  const toggleBudgetStyle = useCallback(async (style: string) => {
    const current = prefs?.exclude_budget_styles ?? [];
    const next = current.includes(style)
      ? current.filter((s) => s !== style)
      : [...current, style];
    await update({ exclude_budget_styles: next });
  }, [prefs, update]);

  const toggleNotification = useCallback(async (key: string, value: boolean) => {
    const current = prefs?.notification_preferences ?? {};
    await update({ notification_preferences: { ...current, [key]: value } });
  }, [prefs, update]);

  const toggleVisibilitySub = useCallback(async (key: string, value: boolean) => {
    const current = (prefs as any)?.visibility_sub_controls ?? {};
    await update({ visibility_sub_controls: { ...current, [key]: value } } as any);
  }, [prefs, update]);

  const handleBoostToggle = useCallback(async (enabled: boolean) => {
    await putCompassBoostVisibility(enabled);
    await update({ boost_visibility_enabled: enabled });
  }, [update]);

  if (loading) {
    return (
      <SafeAreaView style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>Compass Preferences</Text>
        </View>
        <View style={s.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </SafeAreaView>
    );
  }

  const interests            = prefs?.interests ?? [];
  const travelStyles         = prefs?.travel_styles ?? [];
  const preferredLanguages   = prefs?.preferred_languages ?? [];
  const hiddenCats           = prefs?.hidden_categories ?? [];
  const mutedHashtags        = prefs?.muted_hashtags ?? [];
  const excludeBudgetStyles  = prefs?.exclude_budget_styles ?? [];
  const notifPrefs           = prefs?.notification_preferences ?? {};
  const boostEnabled         = prefs?.boost_visibility_enabled ?? false;
  const locationMode         = prefs?.location_privacy_mode ?? 'city_only';
  const delayedDefault       = prefs?.delayed_post_default ?? false;
  const visibilitySubs       = (prefs as any)?.visibility_sub_controls ?? {};
  const safetyPref           = prefs?.safety_preference ?? 'standard';
  const buddyDiscoverable    = prefs?.rent_buddy_discoverable ?? true;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Compass Preferences</Text>
        {saving && <ActivityIndicator size="small" color={color.signal} style={{ marginLeft: 'auto' }} />}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 80 }}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >

        {/* ── Interests & Style ── */}
        <Section title="Interests & Style" Icon={Sparkles}>
          <Text style={s.fieldLabel}>Your interests</Text>
          <ChipSelector
            options={INTEREST_OPTIONS}
            selected={interests}
            onToggle={toggleInterest}
          />

          <Text style={[s.fieldLabel, { marginTop: space.lg }]}>How you travel</Text>
          <ChipSelector
            options={TRAVEL_STYLES}
            selected={travelStyles}
            onToggle={toggleTravelStyle}
          />

          <Text style={[s.fieldLabel, { marginTop: space.lg }]}>Budget styles to exclude from feed</Text>
          <ChipSelector
            options={BUDGET_STYLES}
            selected={excludeBudgetStyles}
            onToggle={toggleBudgetStyle}
          />

          <ToggleRow
            label="Use delayed posting by default"
            sub="Hold new posts until you've left a location"
            value={delayedDefault}
            onChange={(v) => toggle('delayed_post_default', v)}
          />
        </Section>

        {/* ── Language Preferences ── */}
        <Section title="Language Preferences" Icon={Globe}>
          <Text style={s.fieldLabel}>Preferred content languages</Text>
          <Text style={s.fieldSubLabel}>Compass will surface content in these languages first</Text>
          <ChipSelector
            options={LANGUAGE_OPTIONS}
            selected={preferredLanguages}
            onToggle={toggleLanguage}
            labelMap={LANGUAGE_LABELS}
          />
        </Section>

        {/* ── Safety & Visibility ── */}
        <Section title="Safety & Visibility" Icon={Shield}>
          <Text style={s.fieldLabel}>Safety preference</Text>
          {SAFETY_PREFERENCES.map((sp) => (
            <Pressable
              key={sp.key}
              style={s.radioRow}
              onPress={() => toggle('safety_preference', sp.key)}
            >
              <View style={[s.radio, safetyPref === sp.key && s.radioActive]}>
                {safetyPref === sp.key && <View style={s.radioDot} />}
              </View>
              <Text style={s.radioLabel}>{sp.label}</Text>
            </Pressable>
          ))}

          <Text style={[s.fieldLabel, { marginTop: space.md }]}>Location privacy mode</Text>
          {LOCATION_MODES.map((m) => (
            <Pressable
              key={m.key}
              style={s.radioRow}
              onPress={() => toggle('location_privacy_mode', m.key)}
            >
              <View style={[s.radio, locationMode === m.key && s.radioActive]}>
                {locationMode === m.key && <View style={s.radioDot} />}
              </View>
              <Text style={s.radioLabel}>{m.label}</Text>
            </Pressable>
          ))}
        </Section>

        {/* ── Hidden Content ── */}
        <Section title="Hidden Content" Icon={EyeOff}>
          {hiddenCats.length === 0 && mutedHashtags.length === 0 ? (
            <Text style={s.emptyHint}>
              You haven't hidden any categories or muted any topics yet.
              Use the ⋯ menu on any card to hide categories or mute topics.
            </Text>
          ) : (
            <>
              {hiddenCats.length > 0 && (
                <>
                  <Text style={s.fieldLabel}>Hidden categories</Text>
                  <ChipSelector
                    options={hiddenCats}
                    selected={[]}
                    onToggle={async (cat) => {
                      await update({ hidden_categories: hiddenCats.filter((c) => c !== cat) });
                    }}
                  />
                  <Text style={s.fieldSubLabel}>Tap a chip to unhide that category</Text>
                </>
              )}
              {mutedHashtags.length > 0 && (
                <>
                  <Text style={[s.fieldLabel, { marginTop: space.md }]}>Muted topics</Text>
                  <ChipSelector
                    options={mutedHashtags}
                    selected={[]}
                    onToggle={async (tag) => {
                      await update({ muted_hashtags: mutedHashtags.filter((tg) => tg !== tag) });
                    }}
                  />
                  <Text style={s.fieldSubLabel}>Tap a chip to unmute that topic</Text>
                </>
              )}
            </>
          )}
        </Section>

        {/* ── Rent a Buddy ── */}
        <Section title="Rent a Buddy" Icon={Users}>
          <ToggleRow
            label="Show my Buddy profile in recommendations"
            sub="Compass will suggest you as a Buddy to compatible travelers"
            value={buddyDiscoverable}
            onChange={(v) => toggle('rent_buddy_discoverable', v)}
          />
          <Pressable
            style={s.linkRow}
            onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard' as any)}
          >
            <Text style={s.linkLabel}>Edit Buddy profile & pricing →</Text>
          </Pressable>
        </Section>

        {/* ── Notification Preferences ── */}
        <Section title="Notification Preferences" Icon={Bell}>
          {NOTIFICATION_KEYS.map((n) => (
            <ToggleRow
              key={n.key}
              label={n.label}
              value={notifPrefs[n.key] !== false}
              onChange={(v) => toggleNotification(n.key, v)}
            />
          ))}
        </Section>

        {/* ── Compass Sense ── */}
        <SenseSection />

        {/* ── Visibility Rewards ── */}
        <Section title="Visibility Rewards" Icon={Zap}>
          <ToggleRow
            label="Boost my visibility when I'm active"
            sub="Compass will show your content to more travelers based on your activity"
            value={boostEnabled}
            onChange={handleBoostToggle}
          />

          {boostEnabled && (
            <>
              <Pressable
                style={s.expandRow}
                onPress={() => setBoostExpanded((p) => !p)}
              >
                <Text style={s.expandLabel}>Sub-controls</Text>
                {boostExpanded
                  ? <ChevronUp size={16} color={color.mute} />
                  : <ChevronDown size={16} color={color.mute} />}
              </Pressable>

              {boostExpanded && VISIBILITY_SUB.map((vs) => (
                <ToggleRow
                  key={vs.key}
                  label={vs.label}
                  value={visibilitySubs[vs.key] !== false}
                  onChange={(v) => toggleVisibilitySub(vs.key, v)}
                />
              ))}
            </>
          )}
        </Section>

        {/* ── Compass Remembers (Phase 6) ── */}
        <Section title="Memory" Icon={Sparkles}>
          <Pressable
            style={s.expandRow}
            testID="compass-remembers-link"
            onPress={() => router.push('/compass-memories')}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>Compass Remembers</Text>
              <Text style={{ ...t.small, color: color.mute }}>
                View, edit, or forget what Compass has learned — and teach it new preferences.
              </Text>
            </View>
            <ChevronDown size={16} color={color.mute} style={{ transform: [{ rotate: '-90deg' }] }} />
          </Pressable>
          <Pressable
            style={s.expandRow}
            testID="compass-memory-link"
            onPress={() => router.push('/compass-memory' as any)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>Memory Intelligence</Text>
              <Text style={{ ...t.small, color: color.mute }}>
                Review, correct, export, or reset the memory Compass derives from your activity.
              </Text>
            </View>
            <ChevronDown size={16} color={color.mute} style={{ transform: [{ rotate: '-90deg' }] }} />
          </Pressable>
        </Section>

        {/* ── Data & Privacy ── */}
        <Section title="Data & Privacy" Icon={Shield}>
          <Pressable
            style={s.expandRow}
            testID="compass-settings-link"
            onPress={() => router.push('/compass-settings' as any)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>Compass Settings</Text>
              <Text style={{ ...t.small, color: color.mute }}>
                Data and privacy controls — manage what Compass stores and how it uses it.
              </Text>
            </View>
            <ChevronDown size={16} color={color.mute} style={{ transform: [{ rotate: '-90deg' }] }} />
          </Pressable>
        </Section>

        <PlainBottomFiller />

      </ScrollView>
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
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginTop: space.lg,
    marginHorizontal: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.xs,
  },
  sectionTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  fieldLabel: {
    ...t.small,
    color: color.deep,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: space.xs,
  },
  fieldSubLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    marginTop: 2,
    fontStyle: 'italic',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  chipActive: {
    backgroundColor: color.signal + '12',
    borderColor: color.signal + '50',
  },
  chipLabel: {
    ...t.small,
    color: color.deep,
    fontSize: 12,
    textTransform: 'capitalize',
  },
  chipLabelActive: {
    color: color.signal,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  toggleLabel: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
  },
  toggleSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 15,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  radio: {
    width: icon.s20, height: icon.s20,
    borderRadius: icon.s20 / 2,
    borderWidth: 2,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: {
    borderColor: color.signal,
  },
  radioDot: {
    width: dot.s10,
    height: dot.s10,
    borderRadius: dot.s10 / 2,
    backgroundColor: color.signal,
  },
  radioLabel: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
    textTransform: 'capitalize',
  },
  emptyHint: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  expandLabel: {
    ...t.bodyStrong,
    color: color.deep,
    fontSize: 13,
  },
  linkRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  linkLabel: {
    ...t.body,
    color: color.signal,
    fontSize: 14,
  },
});
