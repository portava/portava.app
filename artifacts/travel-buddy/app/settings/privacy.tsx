import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, Switch, ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ArrowLeft, ChevronRight } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getPrivacySettings,
  updatePrivacySettings,
  type PrivacySettings,
} from '../../src/services/profile';
import { applyPrivacyChange } from '../../src/services/privacySettingsLogic';
import { useSession } from '../../src/context/SessionContext';

export default function PrivacySettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const saveLock = useRef(false);

  const loadSettings = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getPrivacySettings()
      .then((res) => {
        if (res.ok && res.data) {
          setPrivacy(res.data);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!live) { setLoading(false); return; }
    loadSettings();
  }, [live, loadSettings]);

  const handleChange = useCallback(
    <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]) => {
      if (saveLock.current) return;
      saveLock.current = true;
      void applyPrivacyChange(privacy, key, value, {
        setPrivacy,
        setSaving,
        onError: (msg) => Alert.alert('Error', msg),
      }, updatePrivacySettings).finally(() => {
        saveLock.current = false;
      });
    },
    [privacy],
  );

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Privacy</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Privacy</Text>
        {saving && (
          <ActivityIndicator size="small" color={color.signal} style={{ marginLeft: 'auto' }} />
        )}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        {!privacy ? (
          live && loadError ? (
            <View style={styles.errorState}>
              <Text style={styles.errorText}>Failed to load settings.</Text>
              <Pressable style={styles.retryButton} onPress={loadSettings}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>Sign in to manage privacy settings.</Text>
            </View>
          )
        ) : (
          <>
            {/* Profile visibility */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>WHO CAN SEE YOUR PROFILE</Text>
              {([
                { value: 'public',          label: 'Public',          sub: 'Anyone can view your profile' },
                { value: 'followers_only',  label: 'Followers only',  sub: 'Only followers can view' },
                { value: 'private',         label: 'Private',         sub: 'Only you can view' },
              ] as const).map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.radioRow, privacy.profile_visibility === opt.value && styles.radioRowActive]}
                  onPress={() => handleChange('profile_visibility', opt.value)}
                >
                  <View style={[styles.radio, privacy.profile_visibility === opt.value && styles.radioChecked]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.radioLabel}>{opt.label}</Text>
                    <Text style={styles.radioSub}>{opt.sub}</Text>
                  </View>
                </Pressable>
              ))}
            </View>

            {/* Visibility toggles */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>VISIBILITY</Text>
              {([
                { key: 'show_stamps',            label: 'Show stamps',        sub: 'Others can see your collected stamps' },
                { key: 'show_current_city',      label: 'Show current city',  sub: 'Display your current city on your profile' },
                { key: 'show_upcoming_trips',    label: 'Show upcoming trips', sub: 'Others can see your travel plans' },
                { key: 'show_friends',           label: 'Show friends list',  sub: 'Others can see who you are friends with' },
              ] as Array<{ key: keyof PrivacySettings; label: string; sub: string }>).map((toggle) => (
                <React.Fragment key={String(toggle.key)}>
                  <View style={styles.toggleRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.toggleLabel}>{toggle.label}</Text>
                      <Text style={styles.toggleSub}>{toggle.sub}</Text>
                    </View>
                    <Switch
                      value={privacy[toggle.key] as boolean}
                      onValueChange={(v) => handleChange(toggle.key, v as any)}
                      trackColor={{ true: color.deep }}
                      thumbColor={color.onInk}
                    />
                  </View>
                  <View style={styles.divider} />
                </React.Fragment>
              ))}
            </View>

            {/* Interaction permissions */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>INTERACTIONS</Text>
              {([
                { key: 'allow_friend_requests',   label: 'Allow friend requests', sub: 'People can send you friend requests' },
                { key: 'allow_follow',            label: 'Allow follows',          sub: 'People can follow you' },
                { key: 'allow_tagging',           label: 'Allow tagging',          sub: 'Others can @mention you in posts' },
                { key: 'allow_profile_discovery', label: 'Discoverable',           sub: 'Appear in search and suggestions' },
              ] as Array<{ key: keyof PrivacySettings; label: string; sub: string }>).map((toggle, idx, arr) => (
                <React.Fragment key={String(toggle.key)}>
                  <View style={styles.toggleRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.toggleLabel}>{toggle.label}</Text>
                      <Text style={styles.toggleSub}>{toggle.sub}</Text>
                    </View>
                    <Switch
                      value={privacy[toggle.key] as boolean}
                      onValueChange={(v) => handleChange(toggle.key, v as any)}
                      trackColor={{ true: color.deep }}
                      thumbColor={color.onInk}
                    />
                  </View>
                  {idx < arr.length - 1 && <View style={styles.divider} />}
                </React.Fragment>
              ))}
            </View>

            {/* Who can message you */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>WHO CAN MESSAGE YOU</Text>
              {(['everyone', 'friends', 'followers', 'nobody'] as const).map((opt) => (
                <Pressable
                  key={opt}
                  style={[styles.radioRow, privacy.allow_messages_from === opt && styles.radioRowActive]}
                  onPress={() => handleChange('allow_messages_from', opt)}
                >
                  <View style={[styles.radio, privacy.allow_messages_from === opt && styles.radioChecked]} />
                  <Text style={styles.radioLabel}>
                    {opt === 'everyone'
                      ? 'Everyone'
                      : opt === 'friends'
                      ? 'Friends only'
                      : opt === 'followers'
                      ? 'Followers only'
                      : 'Nobody'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Close Friends */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>LISTS</Text>
              <Pressable
                style={styles.navRow}
                onPress={() => router.push('/close-friends' as any)}
              >
                <Text style={styles.navRowLabel}>Close Friends</Text>
                <ChevronRight size={16} color={color.faint} />
              </Pressable>
            </View>
          </>
        )}

        <Text style={styles.footerNote}>
          Your exact GPS coordinates are never shared publicly. All public surfaces show only city, neighborhood, or approximate distance.
        </Text>
      </ScrollView>
    </View>
  );
}

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
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  emptyText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  errorState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  section: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: color.faint,
    marginBottom: space.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  toggleLabel: {
    ...t.body,
    color: color.ink,
  },
  toggleSub: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    marginTop: 1,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  radioRowActive: {
    borderColor: color.deep,
    backgroundColor: '#EAF2F4',
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: color.haze,
  },
  radioChecked: {
    borderColor: color.deep,
    backgroundColor: color.deep,
  },
  radioLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
  },
  radioSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  navRowLabel: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  footerNote: {
    fontSize: 11,
    color: color.faint,
    lineHeight: 15,
    marginHorizontal: space.xl,
    marginTop: space.xl,
    textAlign: 'center',
  },
});
