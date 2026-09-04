/**
 * AvailabilityScreen — the Passport Availability editor (spec §6/§7/§8,
 * TABLE 7/8/9/10).
 *
 * Availability is a first-class Passport domain (§6): it determines whether a
 * real-world social opportunity is actionable. This screen lets the OWNER set:
 *
 *   • Open to Plans — do I want social invitations right now? (§8)
 *   • A current one-time window ("Available Tonight · 8 PM–1 AM") with temporary
 *     INTENT chips (Food / Drinks / Nightlife / Explore / Events / Meet
 *     Travelers), a Group Preference, and a Travel Distance (§8 / TABLE 9).
 *   • A WEEKLY recurring grid of free time blocks (§6 / TABLE 9).
 *   • A Social Availability level (TABLE 10) — "Available does not mean open to
 *     strangers" (§6).
 *
 * Load-bearing rules (also enforced in the hook + server):
 *   §7  Only an EXPLICIT answer becomes public/shared. Pressing "Set
 *       Availability" IS that explicit answer (source='explicit'). An inferred
 *       value is never shown as a public status; it can only surface as a
 *       PRIVATE "Free tonight?" prompt.
 *   §31 An expired window is never rendered as the current status.
 *
 * Palette: the light "paper" passport look (mirrors MyWorldScreen). Teal
 * (color.deep) carries availability / social context per §27; color never the
 * only status signal — every selected state also carries text + a check glyph.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  CalendarClock,
  Users,
  MapPin,
  Compass,
  Check,
  Clock,
  Sparkles,
  ShieldCheck,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  useAvailabilityEditor,
  type UseAvailabilityEditorResult,
} from './useAvailabilityEditor.ts';
import { trackAvailabilitySet, trackOpenToPlansEnabled } from './passportTelemetry.ts';
import type {
  IntentType,
  GroupPreference,
  SocialAvailability,
  Weekday,
  TimeBlock,
} from '../../services/availability.ts';

// ── Option tables (§8 / TABLE 9 / TABLE 10) ────────────────────────────────────

const INTENT_OPTIONS: { value: IntentType; label: string }[] = [
  { value: 'Food', label: 'Food' },
  { value: 'Drinks', label: 'Drinks' },
  { value: 'Nightlife', label: 'Nightlife' },
  { value: 'Explore', label: 'Explore' },
  { value: 'Events', label: 'Events' },
  { value: 'MeetTravelers', label: 'Meet Travelers' },
];

const GROUP_OPTIONS: { value: GroupPreference; label: string }[] = [
  { value: 'solo', label: 'Solo' },
  { value: 'one_on_one', label: 'One-on-one' },
  { value: 'small_group', label: 'Small group' },
  { value: 'crew_only', label: 'Crew only' },
  { value: 'large_group', label: 'Large group' },
  { value: 'any', label: 'Any' },
];

const TRAVEL_OPTIONS: { value: number | null; label: string }[] = [
  { value: 10, label: '10 min' },
  { value: 20, label: '20 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hr' },
  { value: null, label: 'Any distance' },
];

const SOCIAL_OPTIONS: { value: SocialAvailability; label: string; desc: string }[] = [
  { value: 'open', label: 'Open', desc: 'Anyone can reach out' },
  { value: 'maybe', label: 'Maybe', desc: 'Open to the right plan' },
  { value: 'crew_only', label: 'Crew only', desc: 'Just my crew' },
  { value: 'following_only', label: 'Following only', desc: 'People I follow' },
  { value: 'not_open', label: 'Not open', desc: 'Not looking right now' },
];

const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
];

const BLOCKS: { value: TimeBlock; label: string }[] = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'late', label: 'Late' },
];

// ── Time formatting ────────────────────────────────────────────────────────────

/** 12-hour clock label, e.g. "8 PM" or "8:30 PM". Deterministic (no Intl). */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** "8 PM – 1 AM" for a window's start/end. */
function formatWindowRange(startAt: string, endAt: string): string {
  const s = formatClock(startAt);
  const e = formatClock(endAt);
  if (!s || !e) return 'Custom window';
  return `${s} – ${e}`;
}

// ── Selectable chip ─────────────────────────────────────────────────────────────

function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      style={[s.chip, selected && s.chipSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {selected ? <Check size={icon.s14} color={color.paper} /> : null}
      <Text style={[s.chipText, selected && s.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────────

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
  children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        {Icon ? <Icon size={icon.s16} color={color.deep} /> : null}
        <Text style={s.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Loading your availability…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <CalendarClock size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load your availability</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper: owns the data hook and hands its result to the presentational
 * view. Kept separate from AvailabilityView so the view can be rendered in
 * tests with a fabricated editor — no async load, no hook — which keeps the
 * component tests deterministic.
 */
export default function AvailabilityScreen() {
  const editor = useAvailabilityEditor();
  return <AvailabilityView editor={editor} />;
}

export interface AvailabilityViewProps {
  editor: UseAvailabilityEditorResult;
}

export function AvailabilityView({ editor }: AvailabilityViewProps) {
  const insets = useSafeAreaInsets();

  const [savedNote, setSavedNote] = useState<string | null>(null);

  const {
    loading,
    error,
    saving,
    windowsEnabled,
    currentWindow,
    inferredPrompt,
    draft,
    weeklyDays,
    setOpenToPlans,
    toggleIntent,
    setGroupPreference,
    setMaxTravelMinutes,
    setSocialAvailability,
    toggleWeeklyBlock,
    save,
    reload,
  } = editor;

  async function onSave() {
    setSavedNote(null);
    // Capture the pre-save persisted Open-to-Plans state so we only emit the
    // §32 open_to_plans_enabled event on an actual off→on transition.
    const wasOpenToPlans = currentWindow?.openToPlans === true;
    const res = await save();
    if (!res.ok) {
      setSavedNote(res.message ?? 'Could not save — try again');
      return;
    }
    // §32 telemetry — the EXPLICIT answer was persisted (§7). Ids/enums/counts
    // only: the flag, an intent count, and whether a live window exists — never
    // the window times or the intent labels.
    trackAvailabilitySet({
      openToPlans: draft.openToPlans,
      intentCount: draft.intents.length,
      hasWindow: res.enabled,
    });
    if (draft.openToPlans && !wasOpenToPlans) {
      trackOpenToPlansEnabled(draft.intents.length);
    }
    if (!res.enabled) {
      setSavedNote('Weekly availability saved. Open to Plans is rolling out soon.');
    } else {
      setSavedNote('Availability set');
    }
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <CalendarClock size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>
            My Availability
          </Text>
        </View>
        <View style={s.backBtn} />
      </View>

      {loading ? (
        <LoadingView />
      ) : error ? (
        <ErrorView message={error} onRetry={reload} />
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxxl }]}
          showsVerticalScrollIndicator={false}
        >
          {/* §7 assurance — only what you set here is ever shared. */}
          <View style={s.privacyNote}>
            <ShieldCheck size={icon.s14} color={color.success} />
            <Text style={s.privacyText}>
              Only what you set here is shared. Portava never turns a guess into a
              public status.
            </Text>
          </View>

          {/* §7 inferred prompt — PRIVATE, never a public status. */}
          {inferredPrompt ? (
            <View style={s.promptCard} accessibilityLabel="Private availability prompt">
              <Sparkles size={icon.s16} color={color.deep} />
              <Text style={s.promptText}>
                Free tonight? Set it below to let people plan with you.
              </Text>
            </View>
          ) : null}

          {/* ── Open to Plans ──────────────────────────────────────────── */}
          <Section title="Open to Plans" icon={Compass}>
            <View style={s.toggleRow}>
              <View style={s.toggleTextWrap}>
                <Text style={s.toggleLabel}>
                  {draft.openToPlans ? 'On' : 'Off'}
                </Text>
                <Text style={s.toggleHint}>
                  Do you want social invitations right now?
                </Text>
              </View>
              <Switch
                value={draft.openToPlans}
                onValueChange={setOpenToPlans}
                trackColor={{ true: color.deep, false: color.haze }}
                thumbColor={color.paper}
                accessibilityRole="switch"
                accessibilityLabel="Open to Plans"
              />
            </View>

            {/* Current one-time window (§8 / TABLE 9). */}
            <View style={s.windowRow}>
              <Clock size={icon.s16} color={color.deep} />
              <Text style={s.windowLabel}>
                Available Tonight · {formatWindowRange(draft.startAt, draft.endAt)}
              </Text>
            </View>
            {currentWindow ? (
              <Text style={s.windowMeta}>
                Live now — expires when this window ends.
              </Text>
            ) : (
              <Text style={s.windowMeta}>Not set yet — press Set Availability.</Text>
            )}
          </Section>

          {/* ── Interested In (temporary intent, §8) ──────────────────── */}
          <Section title="Interested In" icon={Sparkles}>
            <Text style={s.sectionHint}>
              Temporary intent for this window — weighted over your long-term
              interests.
            </Text>
            <View style={s.chipWrap}>
              {INTENT_OPTIONS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  selected={draft.intents.includes(o.value)}
                  onPress={() => toggleIntent(o.value)}
                />
              ))}
            </View>
          </Section>

          {/* ── Group Preference (§8 / TABLE 9) ───────────────────────── */}
          <Section title="Group Preference" icon={Users}>
            <View style={s.chipWrap}>
              {GROUP_OPTIONS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  selected={draft.groupPreference === o.value}
                  onPress={() =>
                    setGroupPreference(draft.groupPreference === o.value ? null : o.value)
                  }
                />
              ))}
            </View>
          </Section>

          {/* ── Travel Distance (maxTravelMinutes, §8 / TABLE 9) ──────── */}
          <Section title="Travel Distance" icon={MapPin}>
            <View style={s.chipWrap}>
              {TRAVEL_OPTIONS.map((o) => (
                <Chip
                  key={String(o.value)}
                  label={o.label}
                  selected={draft.maxTravelMinutes === o.value}
                  onPress={() => setMaxTravelMinutes(o.value)}
                />
              ))}
            </View>
          </Section>

          {/* ── Weekly recurring grid (§6 / TABLE 9) ──────────────────── */}
          <Section title="Weekly" icon={CalendarClock}>
            <Text style={s.sectionHint}>
              Your recurring free time. Tap the blocks you&apos;re usually free.
            </Text>
            <View style={s.weekly}>
              {WEEKDAYS.map((day) => {
                const active = weeklyDays[day.value] ?? [];
                return (
                  <View key={day.value} style={s.weekdayRow}>
                    <Text style={s.weekdayLabel}>{day.label}</Text>
                    <View style={s.weekdayBlocks}>
                      {BLOCKS.map((b) => {
                        const on = active.includes(b.value);
                        return (
                          <Pressable
                            key={b.value}
                            style={[s.blockChip, on && s.blockChipOn]}
                            onPress={() => toggleWeeklyBlock(day.value, b.value)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={`${day.label} ${b.label}`}
                          >
                            <Text style={[s.blockText, on && s.blockTextOn]}>
                              {b.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </View>
          </Section>

          {/* ── Social Availability (TABLE 10) ────────────────────────── */}
          <Section title="Who can reach out" icon={Users}>
            <Text style={s.sectionHint}>
              Available doesn&apos;t mean open to strangers.
            </Text>
            <View style={s.socialList}>
              {SOCIAL_OPTIONS.map((o) => {
                const on = draft.socialAvailability === o.value;
                return (
                  <Pressable
                    key={o.value}
                    style={[s.socialRow, on && s.socialRowOn]}
                    onPress={() => setSocialAvailability(o.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={o.label}
                  >
                    <View style={s.socialTextWrap}>
                      <Text style={[s.socialLabel, on && s.socialLabelOn]}>
                        {o.label}
                      </Text>
                      <Text style={s.socialDesc}>{o.desc}</Text>
                    </View>
                    {on ? <Check size={icon.s18} color={color.deep} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </Section>

          {/* Rollout note when the §8 window feature is flag-off server-side. */}
          {!windowsEnabled ? (
            <Text style={s.flagNote}>
              Open to Plans windows are rolling out. Your weekly availability still
              saves now.
            </Text>
          ) : null}

          {savedNote ? (
            <Text style={s.savedNote} accessibilityLiveRegion="polite">
              {savedNote}
            </Text>
          ) : null}

          {/* Primary CTA — the EXPLICIT answer (§7). */}
          <Pressable
            style={[s.saveBtn, saving && s.saveBtnDisabled]}
            onPress={onSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Set Availability"
          >
            {saving ? (
              <ActivityIndicator color={color.paper} />
            ) : (
              <>
                <Check size={icon.s16} color={color.paper} />
                <Text style={s.saveBtnText}>Set Availability</Text>
              </>
            )}
          </Pressable>
        </ScrollView>
      )}
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

  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Privacy / prompt
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(46,125,91,0.08)',
  },
  privacyText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    flexShrink: 1,
  },
  promptCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  promptText: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
    flexShrink: 1,
  },

  // Section
  section: {
    marginHorizontal: space.lg,
    marginTop: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginBottom: space.sm,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 16,
  },
  sectionHint: {
    ...t.small,
    color: color.mute,
    marginBottom: space.sm,
  },

  // Open to Plans toggle
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  toggleTextWrap: { flex: 1, gap: 2 },
  toggleLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  toggleHint: {
    ...t.small,
    color: color.mute,
  },
  windowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.md,
  },
  windowLabel: {
    ...t.bodyStrong,
    color: color.deep,
    fontSize: 15,
    flexShrink: 1,
  },
  windowMeta: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    marginTop: 2,
  },

  // Chips
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  chipSelected: {
    backgroundColor: color.deep,
    borderColor: color.deep,
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: color.paper,
  },

  // Weekly grid
  weekly: { gap: space.sm },
  weekdayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  weekdayLabel: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    width: 40,
    textTransform: 'uppercase',
  },
  weekdayBlocks: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  blockChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  blockChipOn: {
    backgroundColor: color.deep,
    borderColor: color.deep,
  },
  blockText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  blockTextOn: {
    color: color.paper,
    fontWeight: '700',
  },

  // Social availability
  socialList: { gap: space.xs },
  socialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  socialRowOn: {
    borderColor: color.deep,
    backgroundColor: 'rgba(10,61,74,0.06)',
  },
  socialTextWrap: { flex: 1, gap: 1 },
  socialLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  socialLabelOn: {
    color: color.deep,
  },
  socialDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },

  // Notes + CTA
  flagNote: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
    textAlign: 'center',
    marginHorizontal: space.lg,
    marginTop: space.md,
  },
  savedNote: {
    ...t.small,
    color: color.success,
    textAlign: 'center',
    marginHorizontal: space.lg,
    marginTop: space.md,
    fontWeight: '700',
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: {
    ...t.bodyStrong,
    color: color.paper,
    fontSize: 15,
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
