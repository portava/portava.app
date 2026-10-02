/**
 * Telegraph — Message settings (WP-08 / TEL-F23).
 *
 * WHICH STORE, AND WHY IT MATTERS
 * ===============================
 * Who may message a person is decided on the server by `canMessage`
 * (artifacts/api-server/src/lib/messagingPermissions.ts), which reads
 * `user_message_settings` through `GET/PATCH /api/me/message-settings`. The
 * Privacy screen's old "Who can message you" radios wrote a DIFFERENT column —
 * `profile_privacy_settings.allow_messages_from` — that `canMessage` never
 * reads, so a traveller who chose "Nobody" there was still reachable. This
 * screen edits the store the server enforces; the Privacy screen now links
 * here instead of offering the inert control (decision TM-TEL-D6).
 *
 * HONEST STATES
 * =============
 *   - loading: a spinner, no controls;
 *   - a failed read: an error with Try again, and NO editable controls — a
 *     screen that showed defaults after a failed read would invite the person to
 *     "change" settings from values that are not theirs (DV-83);
 *   - each change saves immediately; while it saves the controls are disabled,
 *     and a refused save puts the previous value back and says so.
 *
 * READ RECEIPTS ARE NOT A SWITCH HERE, ON PURPOSE
 * ===============================================
 * No stored read-receipt preference exists, and the Telegraph spec (§7.2–7.4)
 * makes "seen" load-bearing: it is what closes the unsend-before-seen window.
 * A hide-receipts switch would need a rule for how hidden reads interact with
 * unsend, which is a product/spec decision, not a settings row. So the screen
 * states the behaviour instead of offering a control that could not keep its
 * promise (decision TM-TEL-D7).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Switch } from 'react-native';
import {
  getMyMessageSettings,
  updateMyMessageSettings,
  type MessageSettings,
} from '../../../services/messaging.ts';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider,
} from '../../../components/settings/SettingsUI.tsx';
import { PP } from '../../../theme/passportTokens.ts';
import { space, type as t, icon } from '../../../theme/tokens.ts';

type Privacy = MessageSettings['message_privacy'];

/**
 * Labels follow what the server does, not what the enum names suggest:
 * `followers` admits people who follow YOU, `following` admits people YOU
 * follow (messagingPermissions.ts, the `case 'followers'` / `case 'following'`
 * branches).
 */
export const MESSAGE_PRIVACY_OPTIONS: ReadonlyArray<{ value: Privacy; label: string; sub: string }> = [
  { value: 'everyone', label: 'Everyone', sub: 'Anyone who has not blocked you, or been blocked, can message you.' },
  { value: 'followers', label: 'People who follow me', sub: 'Others can send you a message request.' },
  { value: 'following', label: 'People I follow', sub: 'Others can send you a message request.' },
  { value: 'friends', label: 'Friends only', sub: 'Others can send you a message request.' },
  { value: 'trip_members', label: 'People on my trips', sub: 'Needs “Trip members can message me” on.' },
  { value: 'no_one', label: 'No one', sub: 'Nobody can start a new conversation with you.' },
];

type BoolKey = 'allow_message_requests' | 'allow_trip_member_messages' | 'allow_circle_member_messages';

const TOGGLES: ReadonlyArray<{ key: BoolKey; label: string; sub: string }> = [
  { key: 'allow_message_requests', label: 'Allow message requests', sub: 'People your setting above does not cover can ask to message you. You accept or decline.' },
  { key: 'allow_trip_member_messages', label: 'Trip members can message me', sub: 'People on a trip with you can message you directly.' },
  { key: 'allow_circle_member_messages', label: 'Circle members can message me', sub: 'People in your circle can message you directly.' },
];

export function MessageSettingsScreen() {
  const [settings, setSettings] = useState<MessageSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lock = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const r = await getMyMessageSettings();
    // `ok` with no data is an unconfigured build answering nothing — still not
    // the person's settings, so it is an error here, not an empty form.
    if (r.ok && r.data) setSettings(r.data);
    else { setSettings(null); setLoadError(r.message ?? 'We could not load your message settings.'); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async (patch: Partial<Omit<MessageSettings, 'updated_at'>>) => {
    if (!settings || lock.current) return;
    lock.current = true;
    const previous = settings;
    setSaving(true);
    setSaveError(null);
    setSettings({ ...settings, ...patch });
    const r = await updateMyMessageSettings(patch);
    if (r.ok && r.data) setSettings(r.data);
    else {
      setSettings(previous);
      setSaveError(r.message ?? 'That change was not saved. Your previous setting is still in place.');
    }
    setSaving(false);
    lock.current = false;
  }, [settings]);

  if (loading) {
    return (
      <SettingsScreen title="Message settings">
        <View style={st.center} testID="message-settings-loading"><ActivityIndicator color={PP.inkLight} /></View>
      </SettingsScreen>
    );
  }

  if (!settings) {
    return (
      <SettingsScreen title="Message settings">
        <SettingsSection subtitle={loadError ?? 'We could not load your message settings.'}>
          <SettingsRow title="Try again" testID="message-settings-retry" onPress={() => { void load(); }} />
        </SettingsSection>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Message settings" subtitle={saving ? 'Saving…' : undefined}>
      {saveError ? (
        <Text style={st.error} testID="message-settings-save-error">{saveError}</Text>
      ) : null}

      <SettingsSection
        title="Who can message you"
        subtitle="Who can start a new Telegraph conversation with you. Blocked people never can."
      >
        {MESSAGE_PRIVACY_OPTIONS.map((opt, idx) => {
          const checked = settings.message_privacy === opt.value;
          return (
            <React.Fragment key={opt.value}>
              {idx > 0 && <SettingsDivider />}
              <SettingsRow
                title={opt.label}
                subtitle={opt.sub}
                testID={`message-privacy-${opt.value}`}
                disabled={saving}
                onPress={() => { if (!checked) void apply({ message_privacy: opt.value }); }}
                accessibilityRole="radio"
                accessibilityState={{ checked, disabled: saving }}
                right={<View style={[st.radio, checked && st.radioChecked]} />}
              />
            </React.Fragment>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Requests and groups">
        {TOGGLES.map((tg, idx) => (
          <React.Fragment key={tg.key}>
            {idx > 0 && <SettingsDivider />}
            <SettingsRow
              title={tg.label}
              subtitle={tg.sub}
              right={
                <Switch
                  testID={`message-setting-${tg.key}`}
                  accessibilityLabel={tg.label}
                  value={settings[tg.key]}
                  disabled={saving}
                  onValueChange={(v) => { void apply({ [tg.key]: v } as Partial<MessageSettings>); }}
                  trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
                  thumbColor="#FFFFFF"
                />
              }
            />
          </React.Fragment>
        ))}
      </SettingsSection>

      <SettingsSection title="Read receipts">
        <View style={st.info} testID="message-settings-receipts-note">
          <Text style={st.infoText}>
            Read receipts are always on. When someone opens your message you see “Seen”, and once a
            message has been seen it can no longer be unsent. There is no setting to hide them.
          </Text>
        </View>
      </SettingsSection>
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  center: { paddingVertical: space.xxl, alignItems: 'center', justifyContent: 'center' },
  radio: { width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2, borderWidth: 2, borderColor: PP.border },
  radioChecked: { borderColor: PP.inkLight, backgroundColor: PP.inkLight },
  error: { ...t.small, color: '#B42318', paddingHorizontal: space.lg, paddingTop: space.md },
  info: { backgroundColor: PP.paperDeep, paddingHorizontal: space.lg, paddingVertical: space.md },
  infoText: { ...t.small, color: PP.inkMuted },
});

export default MessageSettingsScreen;
