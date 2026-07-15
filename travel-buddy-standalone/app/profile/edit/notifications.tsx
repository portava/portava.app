/**
 * Notifications — Edit Profile & Settings hub sub-page.
 *
 * Absorbs app/settings/notifications.tsx: same useNotificationPreferences
 * hook (load / toggle / quiet-hours wiring), immediate-save semantics.
 * Re-skinned with SettingsSection / ToggleRow. Per-category toggles are
 * grouped under plain-language headings.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Switch,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import { useNotificationPreferences } from '../../../src/hooks/useNotifications';
import type { NotificationCategory } from '../../../src/services/notifications';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider, ToggleRow,
} from '../../../src/components/settings/SettingsUI';

const CATEGORY_LABELS: Record<NotificationCategory, { label: string; description: string }> = {
  plans:       { label: 'Plans',        description: 'Plan items, approvals, check-ins' },
  trips:       { label: 'Trips',        description: 'Invites, membership changes, reminders' },
  telegraph:   { label: 'Telegraph',    description: 'Messages and message requests' },
  safe_return: { label: 'Safe Return',  description: 'Safety check-ins and alerts' },
  location:    { label: 'Location',     description: 'Arrivals, nearby travelers, live share' },
  trip_crew:   { label: 'Trip Crew',    description: 'Friend requests, circle invites, nudges' },
  compass:     { label: 'Compass AI',   description: 'Recommendations, warnings, daily briefs' },
  pulse:       { label: 'City Pulse',   description: 'Posts, likes, comments, highlights' },
  passport:    { label: 'Passport',     description: 'Stamps, milestones, profile views' },
  hidden_gems: { label: 'Hidden Gems',  description: 'Place saves, approvals, nearby gems' },
  trust:       { label: 'Trust',        description: 'Reliability score changes, reports' },
  airport:     { label: 'Airport Mode', description: 'Layover tips, nearby travelers' },
  admin:       { label: 'Admin',        description: 'Account notices and moderation actions' },
};

/**
 * Plain-language groupings of the existing notification categories. Every
 * category from the legacy screen is mapped into exactly one group; none are
 * dropped and no new categories are invented.
 */
const CATEGORY_GROUPS: { title: string; categories: NotificationCategory[] }[] = [
  { title: 'Social activity',      categories: ['pulse', 'trip_crew', 'passport'] },
  { title: 'Telegraph & messages', categories: ['telegraph'] },
  { title: 'Trips & Events',       categories: ['trips', 'plans'] },
  { title: 'Safety alerts',        categories: ['safe_return', 'trust', 'admin'] },
  { title: 'Reminders',            categories: ['location', 'airport'] },
  { title: 'Marketing',            categories: ['compass', 'hidden_gems'] },
];

// ── QuietTimePicker (preserved from legacy) ─────────────────────────────────

function QuietTimePicker({
  visible, label, value, onClose, onSave,
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
        <Pressable style={pk.overlay} onPress={onClose}>
          <Pressable style={pk.sheet} onPress={() => {}}>
            <Text style={pk.label}>{label}</Text>
            <View style={pk.inputs}>
              <TextInput
                style={pk.input}
                value={hh}
                onChangeText={setHh}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="22"
                placeholderTextColor={PP.inkMuted}
              />
              <Text style={pk.colon}>:</Text>
              <TextInput
                style={pk.input}
                value={mm}
                onChangeText={setMm}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="00"
                placeholderTextColor={PP.inkMuted}
              />
            </View>
            <View style={pk.actions}>
              <Pressable onPress={onClose} style={pk.cancelBtn}>
                <Text style={pk.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleSave} style={pk.saveBtn}>
                <Text style={pk.saveText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const pk = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  sheet: { backgroundColor: '#FFFDF7', borderRadius: radius.md, padding: space.xl, width: 260, gap: space.lg },
  label: { ...t.bodyStrong, color: PP.ink, textAlign: 'center' },
  inputs: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  input: {
    ...t.heading, color: PP.ink,
    borderWidth: 1, borderColor: PP.border, borderRadius: radius.sm,
    width: 64, textAlign: 'center', paddingVertical: space.sm, backgroundColor: PP.paper,
  },
  colon: { ...t.heading, color: PP.ink },
  actions: { flexDirection: 'row', gap: space.md, justifyContent: 'center' },
  cancelBtn: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  cancelText: { ...t.body, color: PP.inkMuted },
  saveBtn: { backgroundColor: PP.ink, borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.lg },
  saveText: { ...t.bodyStrong, color: PP.paper },
});

// ── CategoryRow (expandable per-category channel toggles) ───────────────────

function CategoryRow({
  cat, catPref, expanded, onToggleExpand, onChannelToggle, pushEnabled, digestsEnabled,
}: {
  cat: NotificationCategory;
  catPref?: { inAppEnabled: boolean; pushEnabled: boolean; digestEnabled: boolean };
  expanded: boolean;
  onToggleExpand: () => void;
  onChannelToggle: (key: string, value: boolean) => void;
  pushEnabled: boolean;
  digestsEnabled: boolean;
}) {
  const info = CATEGORY_LABELS[cat];
  return (
    <>
      <SettingsRow
        title={info.label}
        subtitle={info.description}
        onPress={onToggleExpand}
        right={<Text style={st.chev}>{expanded ? '▲' : '▼'}</Text>}
      />
      {expanded && (
        <View style={st.channels}>
          <View style={st.channelRow}>
            <Text style={st.channelLabel}>In-app</Text>
            <Switch
              value={catPref?.inAppEnabled ?? true}
              onValueChange={(v) => onChannelToggle('inAppEnabled', v)}
              trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
              thumbColor="#FFFFFF"
            />
          </View>
          <View style={st.channelRow}>
            <Text style={st.channelLabel}>Push</Text>
            <Switch
              value={catPref?.pushEnabled ?? true}
              onValueChange={(v) => onChannelToggle('pushEnabled', v)}
              trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
              thumbColor="#FFFFFF"
              disabled={!pushEnabled}
            />
          </View>
          <View style={st.channelRow}>
            <Text style={st.channelLabel}>Digest</Text>
            <Switch
              value={catPref?.digestEnabled ?? false}
              onValueChange={(v) => onChannelToggle('digestEnabled', v)}
              trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
              thumbColor="#FFFFFF"
              disabled={!digestsEnabled}
            />
          </View>
        </View>
      )}
    </>
  );
}

// ── Main screen ─────────────────────────────────────────────────────────────

export default function NotificationsScreen() {
  const { preferences, categoryPreferences, loading, saving, save } = useNotificationPreferences();
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
      <SettingsScreen title="Notifications">
        <View style={st.center}>
          <ActivityIndicator size="large" color={PP.inkLight} />
        </View>
      </SettingsScreen>
    );
  }

  const prefs = preferences;
  if (!prefs) return <SettingsScreen title="Notifications"><View /></SettingsScreen>;

  return (
    <SettingsScreen
      title="Notifications"
      right={saving ? <ActivityIndicator size="small" color={PP.inkLight} /> : undefined}
    >
      {/* Delivery */}
      <SettingsSection title="Delivery" subtitle="Where notifications reach you.">
        <ToggleRow
          title="Push notifications"
          subtitle="Receive alerts on your device"
          value={prefs.pushEnabled}
          onValueChange={(v) => handleGlobalToggle('pushEnabled', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="Email notifications"
          subtitle="Receive alerts via email"
          value={prefs.emailEnabled}
          onValueChange={(v) => handleGlobalToggle('emailEnabled', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="In-app notifications"
          subtitle="Show in the Activity Center"
          value={prefs.inAppEnabled}
          onValueChange={(v) => handleGlobalToggle('inAppEnabled', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="Daily digests"
          subtitle="A once-daily summary instead of individual alerts"
          value={prefs.digestsEnabled}
          onValueChange={(v) => handleGlobalToggle('digestsEnabled', v)}
        />
      </SettingsSection>

      {/* Safety override */}
      <SettingsSection
        title="Safety override"
        subtitle="Urgent notifications — like Safe Return alerts and account notices — are always delivered, even when push is off. This keeps you reachable in situations that matter."
      >
        <ToggleRow
          title="Safety override enabled"
          value={prefs.safetyOverride}
          onValueChange={(v) => handleGlobalToggle('safetyOverride', v)}
        />
      </SettingsSection>

      {/* Quiet hours */}
      <SettingsSection title="Quiet hours" subtitle="Suppress push during your quiet window.">
        <ToggleRow
          title="Enable quiet hours"
          subtitle="Suppress push during your quiet window"
          value={prefs.quietHoursEnabled}
          onValueChange={(v) => handleGlobalToggle('quietHoursEnabled', v)}
        />
        {prefs.quietHoursEnabled && (
          <>
            <SettingsDivider />
            <SettingsRow
              title="Start"
              onPress={() => setEditingTime('start')}
              right={
                <View style={st.timeBtn}>
                  <Text style={st.timeDisplay}>{prefs.quietStart}</Text>
                  <Text style={st.timeEdit}>Edit</Text>
                </View>
              }
            />
            <SettingsDivider />
            <SettingsRow
              title="End"
              onPress={() => setEditingTime('end')}
              right={
                <View style={st.timeBtn}>
                  <Text style={st.timeDisplay}>{prefs.quietEnd}</Text>
                  <Text style={st.timeEdit}>Edit</Text>
                </View>
              }
            />
          </>
        )}
      </SettingsSection>

      {/* Previews */}
      <SettingsSection title="Previews" subtitle="What shows inside notification banners.">
        <ToggleRow
          title="Message previews"
          subtitle="Show sender name and preview text in push"
          value={prefs.messagePreviews}
          onValueChange={(v) => handleGlobalToggle('messagePreviews', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="Location-sensitive previews"
          subtitle="Include location context in notifications"
          value={prefs.locationPreviews}
          onValueChange={(v) => handleGlobalToggle('locationPreviews', v)}
        />
      </SettingsSection>

      {/* Per-category, grouped */}
      {CATEGORY_GROUPS.map((group) => (
        <SettingsSection key={group.title} title={group.title}>
          {group.categories.map((cat, idx) => (
            <React.Fragment key={cat}>
              {idx > 0 && <SettingsDivider />}
              <CategoryRow
                cat={cat}
                catPref={getCatPref(cat)}
                expanded={expandedCategory === cat}
                onToggleExpand={() => setExpandedCategory(expandedCategory === cat ? null : cat)}
                onChannelToggle={(key, value) => handleCategoryToggle(cat, key, value)}
                pushEnabled={prefs.pushEnabled}
                digestsEnabled={prefs.digestsEnabled}
              />
            </React.Fragment>
          ))}
        </SettingsSection>
      ))}

      {/* Quiet-hours time pickers */}
      <QuietTimePicker
        visible={editingTime === 'start'}
        label="Quiet hours start"
        value={prefs.quietStart}
        onClose={() => setEditingTime(null)}
        onSave={(tm) => handleQuietTimeSave('start', tm)}
      />
      <QuietTimePicker
        visible={editingTime === 'end'}
        label="Quiet hours end"
        value={prefs.quietEnd}
        onClose={() => setEditingTime(null)}
        onSave={(tm) => handleQuietTimeSave('end', tm)}
      />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  center: { paddingVertical: space.xxl, alignItems: 'center', justifyContent: 'center' },
  chev: { ...t.small, color: PP.inkMuted, fontSize: 11 },
  channels: {
    backgroundColor: PP.paper,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PP.borderLight,
  },
  channelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: space.xs, minHeight: 44,
  },
  channelLabel: { ...t.small, color: PP.inkMuted, fontWeight: '500' },
  timeBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  timeDisplay: { ...t.bodyStrong, color: PP.inkLight, fontFamily: 'Courier' },
  timeEdit: { ...t.small, color: PP.inkLight, fontWeight: '600' },
});
