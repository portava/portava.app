/**
 * Notification Settings screen
 *
 * Sections:
 *   1. Global toggles: push, email, safety explanation
 *   2. Per-category toggles: in-app / push / digest per category
 *   3. Behavior: quiet hours, message previews, location-sensitive previews
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, Pressable, StyleSheet, ActivityIndicator, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Shield } from 'lucide-react-native';
import { color, space, type as t, radius } from '../../src/theme/tokens';
import { useNotificationPreferences } from '../../src/hooks/useNotifications';
import type { NotificationCategory } from '../../src/services/notifications';

const CATEGORY_LABELS: Record<NotificationCategory, { label: string; icon: string; description: string }> = {
  plans:       { label: 'Plans',          icon: '📋', description: 'Plan items, approvals, check-ins' },
  trips:       { label: 'Trips',          icon: '✈️', description: 'Invites, membership changes, reminders' },
  telegraph:   { label: 'Telegraph',      icon: '💬', description: 'Messages and message requests' },
  safe_return: { label: 'Safe Return',    icon: '🛡️', description: 'Safety check-ins and alerts' },
  location:    { label: 'Location',       icon: '📍', description: 'Arrivals, nearby travelers, live share' },
  trip_crew:   { label: 'Trip Crew',      icon: '👥', description: 'Friend requests, circle invites, nudges' },
  compass:     { label: 'Compass AI',     icon: '🧭', description: 'Recommendations, warnings, daily briefs' },
  pulse:       { label: 'City Pulse',     icon: '🌍', description: 'Posts, likes, comments, highlights' },
  passport:    { label: 'Passport',       icon: '📘', description: 'Stamps, milestones, profile views' },
  hidden_gems: { label: 'Hidden Gems',    icon: '💎', description: 'Place saves, approvals, nearby gems' },
  trust:       { label: 'Trust',          icon: '⭐', description: 'Reliability score changes, reports' },
  airport:     { label: 'Airport Mode',   icon: '🏔️', description: 'Layover tips, nearby travelers' },
  admin:       { label: 'Admin',          icon: '⚠️', description: 'Account notices and moderation actions' },
};

const CATEGORIES: NotificationCategory[] = [
  'plans','trips','telegraph','safe_return','location','trip_crew',
  'compass','pulse','passport','hidden_gems','trust','airport','admin',
];

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function ToggleRow({
  label,
  subtitle,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, disabled && { color: color.faint }]}>{label}</Text>
        {subtitle && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: color.haze, true: color.deep }}
        thumbColor={color.paperRaised}
      />
    </Row>
  );
}

// ── QuietTimePicker ────────────────────────────────────────────────────────────

function QuietTimePicker({
  visible,
  label,
  value,
  onClose,
  onSave,
}: {
  visible: boolean;
  label: string;
  value: string;
  onClose: () => void;
  onSave: (time: string) => void;
}) {
  const [hh, setHh] = useState(value.split(':')[0] ?? '22');
  const [mm, setMm] = useState(value.split(':')[1] ?? '00');

  const handleSave = useCallback(() => {
    const h = Math.min(23, Math.max(0, parseInt(hh, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(mm, 10) || 0));
    onSave(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    onClose();
  }, [hh, mm, onSave, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={pickerStyles.overlay} onPress={onClose}>
          <Pressable style={pickerStyles.sheet} onPress={() => {}}>
            <Text style={pickerStyles.label}>{label}</Text>
            <View style={pickerStyles.inputs}>
              <TextInput
                style={pickerStyles.input}
                value={hh}
                onChangeText={setHh}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="22"
                placeholderTextColor={color.faint}
              />
              <Text style={pickerStyles.colon}>:</Text>
              <TextInput
                style={pickerStyles.input}
                value={mm}
                onChangeText={setMm}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="00"
                placeholderTextColor={color.faint}
              />
            </View>
            <View style={pickerStyles.actions}>
              <Pressable onPress={onClose} style={pickerStyles.cancelBtn}>
                <Text style={pickerStyles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleSave} style={pickerStyles.saveBtn}>
                <Text style={pickerStyles.saveText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const pickerStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  sheet: { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.xl, width: 260, gap: space.lg },
  label: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  inputs: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  input: {
    ...t.heading,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    width: 64,
    textAlign: 'center',
    paddingVertical: space.sm,
    backgroundColor: color.paper,
  },
  colon: { ...t.heading, color: color.ink },
  actions: { flexDirection: 'row', gap: space.md, justifyContent: 'center' },
  cancelBtn: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  cancelText: { ...t.body, color: color.mute },
  saveBtn: { backgroundColor: color.signal, borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.lg },
  saveText: { ...t.bodyStrong, color: '#fff' },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function NotificationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { preferences, categoryPreferences, loading, saving, reload, save } = useNotificationPreferences();
  const [expandedCategory, setExpandedCategory] = useState<NotificationCategory | null>(null);
  const [editingTime, setEditingTime] = useState<'start' | 'end' | null>(null);

  const getCatPref = useCallback((cat: NotificationCategory) =>
    categoryPreferences.find((c) => c.category === cat), [categoryPreferences]);

  const handleGlobalToggle = useCallback(async (key: string, value: boolean) => {
    await save({ [key]: value });
  }, [save]);

  const handleQuietTimeSave = useCallback(async (field: 'start' | 'end', time: string) => {
    await save(field === 'start' ? { quietStart: time } : { quietEnd: time });
  }, [save]);

  const handleCategoryToggle = useCallback(async (
    cat: NotificationCategory,
    key: string,
    value: boolean,
  ) => {
    const current = getCatPref(cat);
    await save({
      categoryPreferences: [{
        category: cat,
        inAppEnabled:  current?.inAppEnabled  ?? true,
        pushEnabled:   current?.pushEnabled   ?? true,
        emailEnabled:  current?.emailEnabled  ?? false,
        digestEnabled: current?.digestEnabled ?? false,
        [key]: value,
      }],
    });
  }, [getCatPref, save]);

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </View>
    );
  }

  const prefs = preferences;
  if (!prefs) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ChevronLeft size={24} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Notifications</Text>
        {saving && <ActivityIndicator size="small" color={color.mute} style={{ marginLeft: space.md }} />}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Global toggles ── */}
        <SectionHeader title="Delivery" />
        <View style={styles.card}>
          <ToggleRow
            label="Push notifications"
            subtitle="Receive alerts on your device"
            value={prefs.pushEnabled}
            onValueChange={(v) => handleGlobalToggle('pushEnabled', v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Email notifications"
            subtitle="Receive alerts via email"
            value={prefs.emailEnabled}
            onValueChange={(v) => handleGlobalToggle('emailEnabled', v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="In-app notifications"
            subtitle="Show in the Activity Center"
            value={prefs.inAppEnabled}
            onValueChange={(v) => handleGlobalToggle('inAppEnabled', v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Daily digests"
            subtitle="A once-daily summary instead of individual alerts"
            value={prefs.digestsEnabled}
            onValueChange={(v) => handleGlobalToggle('digestsEnabled', v)}
          />
        </View>

        {/* ── Safety override explanation ── */}
        <View style={styles.safetyCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Shield size={16} color={color.deep} />
            <Text style={styles.safetyTitle}>Safety override</Text>
          </View>
          <Text style={styles.safetyBody}>
            Urgent notifications — like Safe Return alerts and account notices — are always delivered,
            even when push is off. This keeps you reachable in situations that matter.
          </Text>
          <View style={[styles.divider, { marginVertical: space.md }]} />
          <ToggleRow
            label="Safety override enabled"
            value={prefs.safetyOverride}
            onValueChange={(v) => handleGlobalToggle('safetyOverride', v)}
          />
        </View>

        {/* ── Quiet hours ── */}
        <SectionHeader title="Quiet Hours" />
        <View style={styles.card}>
          <ToggleRow
            label="Enable quiet hours"
            subtitle="Suppress push during your quiet window"
            value={prefs.quietHoursEnabled}
            onValueChange={(v) => handleGlobalToggle('quietHoursEnabled', v)}
          />
          {prefs.quietHoursEnabled && (
            <>
              <View style={styles.divider} />
              <Pressable onPress={() => setEditingTime('start')}>
                <Row>
                  <Text style={styles.rowLabel}>Start</Text>
                  <View style={styles.quietTimeBtn}>
                    <Text style={styles.quietTimeDisplay}>{prefs.quietStart}</Text>
                    <Text style={styles.quietTimeEdit}>Edit</Text>
                  </View>
                </Row>
              </Pressable>
              <View style={styles.divider} />
              <Pressable onPress={() => setEditingTime('end')}>
                <Row>
                  <Text style={styles.rowLabel}>End</Text>
                  <View style={styles.quietTimeBtn}>
                    <Text style={styles.quietTimeDisplay}>{prefs.quietEnd}</Text>
                    <Text style={styles.quietTimeEdit}>Edit</Text>
                  </View>
                </Row>
              </Pressable>
            </>
          )}
        </View>

        {/* ── Previews ── */}
        <SectionHeader title="Previews" />
        <View style={styles.card}>
          <ToggleRow
            label="Message previews"
            subtitle="Show sender name and preview text in push"
            value={prefs.messagePreviews}
            onValueChange={(v) => handleGlobalToggle('messagePreviews', v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Location-sensitive previews"
            subtitle="Include location context in notifications"
            value={prefs.locationPreviews}
            onValueChange={(v) => handleGlobalToggle('locationPreviews', v)}
          />
        </View>

        {/* ── Per-category ── */}
        <SectionHeader title="Categories" />
        <View style={styles.card}>
          {CATEGORIES.map((cat, idx) => {
            const info = CATEGORY_LABELS[cat];
            const catPref = getCatPref(cat);
            const isExpanded = expandedCategory === cat;

            return (
              <React.Fragment key={cat}>
                {idx > 0 && <View style={styles.divider} />}
                <Pressable
                  style={styles.categoryRow}
                  onPress={() => setExpandedCategory(isExpanded ? null : cat)}
                >
                  <Text style={styles.categoryIcon}>{info.icon}</Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.categoryLabel}>{info.label}</Text>
                    <Text style={styles.categoryDesc}>{info.description}</Text>
                  </View>
                  <Text style={styles.expandChevron}>{isExpanded ? '▲' : '▼'}</Text>
                </Pressable>

                {isExpanded && (
                  <View style={styles.categoryToggles}>
                    <View style={styles.miniToggleRow}>
                      <Text style={styles.miniToggleLabel}>In-app</Text>
                      <Switch
                        value={catPref?.inAppEnabled ?? true}
                        onValueChange={(v) => handleCategoryToggle(cat, 'inAppEnabled', v)}
                        trackColor={{ false: color.haze, true: color.deep }}
                        thumbColor={color.paperRaised}
                      />
                    </View>
                    <View style={styles.miniToggleRow}>
                      <Text style={styles.miniToggleLabel}>Push</Text>
                      <Switch
                        value={catPref?.pushEnabled ?? true}
                        onValueChange={(v) => handleCategoryToggle(cat, 'pushEnabled', v)}
                        trackColor={{ false: color.haze, true: color.deep }}
                        thumbColor={color.paperRaised}
                        disabled={!prefs.pushEnabled}
                      />
                    </View>
                    <View style={styles.miniToggleRow}>
                      <Text style={styles.miniToggleLabel}>Digest</Text>
                      <Switch
                        value={catPref?.digestEnabled ?? false}
                        onValueChange={(v) => handleCategoryToggle(cat, 'digestEnabled', v)}
                        trackColor={{ false: color.haze, true: color.deep }}
                        thumbColor={color.paperRaised}
                        disabled={!prefs.digestsEnabled}
                      />
                    </View>
                  </View>
                )}
              </React.Fragment>
            );
          })}
        </View>
      </ScrollView>

      {/* Quiet-hours time pickers */}
      <QuietTimePicker
        visible={editingTime === 'start'}
        label="Quiet hours start"
        value={prefs.quietStart}
        onClose={() => setEditingTime(null)}
        onSave={(t) => handleQuietTimeSave('start', t)}
      />
      <QuietTimePicker
        visible={editingTime === 'end'}
        label="Quiet hours end"
        value={prefs.quietEnd}
        onClose={() => setEditingTime(null)}
        onSave={(t) => handleQuietTimeSave('end', t)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  backBtn: {
    marginRight: space.md,
    padding: space.xs,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  scroll: {
    padding: space.lg,
    gap: space.md,
  },
  sectionHeader: {
    ...t.stamp,
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: space.xs,
    marginTop: space.md,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  safetyCard: {
    backgroundColor: '#F0F9FF',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    padding: space.lg,
    marginBottom: space.md,
  },
  safetyTitle: {
    ...t.bodyStrong,
    color: color.deep,
  },
  safetyBody: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
    marginTop: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  rowLabel: {
    ...t.body,
    color: color.ink,
    fontWeight: '500',
  },
  rowSubtitle: {
    ...t.small,
    color: color.mute,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginLeft: space.lg,
  },
  quietTimeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  quietTimeDisplay: {
    ...t.bodyStrong,
    color: color.deep,
    fontFamily: 'Courier',
  },
  quietTimeEdit: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  categoryIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  categoryLabel: {
    ...t.body,
    color: color.ink,
    fontWeight: '600',
  },
  categoryDesc: {
    ...t.small,
    color: color.mute,
  },
  expandChevron: {
    ...t.stamp,
    color: color.faint,
  },
  categoryToggles: {
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.xs,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  miniToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.xs,
  },
  miniToggleLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '500',
  },
});
