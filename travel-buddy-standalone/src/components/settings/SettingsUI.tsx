/**
 * SettingsUI — shared primitives for the Edit Profile & Settings hub.
 *
 * Visual language: warm ivory surfaces (PP.paper #F8F3E8), dark-green ink
 * (PP.ink #1A3A2A), grouped-list rows — matches the Passport aesthetic.
 *
 * Exports:
 *   SettingsScreen   — page scaffold: ivory bg, header, keyboard-avoiding scroll, NavBarFiller
 *   SettingsHeader   — sticky back + title + optional right-side save control
 *   SettingsSection  — group wrapper with uppercase Courier heading
 *   SettingsRow      — icon + title + subtitle + chevron/right control (min 44px)
 *   SettingsDivider  — hairline divider between rows in a group
 *   SaveButton       — idle / saving / saved / error states
 *   useUnsavedGuard  — beforeRemove navigation-block hook for dirty forms
 *   FieldLabel / FieldHint / TextField — form field helpers
 *   ChipGrid         — multi/single select chips
 *   ToggleRow        — label + Switch row
 */
import React, { useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, Platform,
  ActivityIndicator, Switch,
  type StyleProp, type ViewStyle, type TextInputProps,
} from 'react-native';
import { KeyboardSafeView } from '../ui/KeyboardSafeView.tsx';
import { useNavigation, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ChevronRight, Check, AlertCircle, RotateCcw } from 'lucide-react-native';
import { PP } from '../../theme/passportTokens.ts';
import { space, radius, type as t } from '../../theme/tokens.ts';
import { PlainBottomFiller } from '../../hooks/useBottomInset.ts';

// ── Post-save success flow ──────────────────────────────────────────────────

/**
 * Universal post-save behavior: flash the SaveBar's 'saved' checkmark, then
 * automatically return the user to the previous screen — no manual Back press
 * after a successful save. Falls back to resetting to 'idle' when there is no
 * history to go back to. The pending timer is cleared on unmount so a user who
 * leaves early is never popped twice.
 */
export function useSavedThenBack(setSaveState: (s: SaveState) => void, delayMs = 900) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback(() => {
    setSaveState('saved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (router.canGoBack()) router.back();
      else setSaveState('idle');
    }, delayMs);
  }, [setSaveState, delayMs]);
}

// ── Unsaved-change guard ────────────────────────────────────────────────────

export function useUnsavedGuard(dirty: boolean) {
  const navigation = useNavigation();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const unsub = (navigation as any).addListener('beforeRemove', (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      const proceed = () => (navigation as any).dispatch(e.data.action);
      // RN's Alert.alert is a silent no-op on web — calling it here after an
      // unconditional preventDefault() would block every future back/tab-nav
      // attempt with no dialog and no way out short of a full reload. Use the
      // browser's native confirm() there instead.
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.confirm(
          'You have unsaved changes. Are you sure you want to leave?',
        )) {
          proceed();
        }
        return;
      }
      Alert.alert(
        'Discard changes?',
        'You have unsaved changes. Are you sure you want to leave?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: proceed },
        ],
      );
    });
    return unsub;
  }, [navigation]);
}

// ── Header ──────────────────────────────────────────────────────────────────

export function SettingsHeader({
  title, subtitle, right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Floor guards against the dynamic-island cutout on iPhone 14/15 Pro
  // models — some presentation contexts (modal stacks, re-mounted routes)
  // report a stale/zero insets.top before the safe-area frame settles,
  // which otherwise renders the title directly behind the notch.
  return (
    <View style={[st.header, { paddingTop: Math.max(insets.top + space.sm, 54) }]}>
      <Pressable
        style={st.headerBtn}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/passport' as any))}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <ArrowLeft size={22} color={PP.ink} />
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text style={st.headerTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={st.headerSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={st.headerRight}>{right ?? null}</View>
    </View>
  );
}

// ── Screen scaffold ─────────────────────────────────────────────────────────

export function SettingsScreen({
  title, subtitle, right, children, scrollRef, contentStyle,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  scrollRef?: React.Ref<ScrollView>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={st.root}>
      <SettingsHeader title={title} subtitle={subtitle} right={right} />
      <KeyboardSafeView
        scrollViewRef={scrollRef}
        scrollViewProps={{ style: { flex: 1 } }}
        contentContainerStyle={[st.content, contentStyle]}
      >
        {children}
        <PlainBottomFiller />
      </KeyboardSafeView>
    </View>
  );
}

// ── Section / rows ──────────────────────────────────────────────────────────

export function SettingsSection({
  title, subtitle, children, style,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[st.section, style]}>
      {title ? <Text style={st.sectionTitle}>{title}</Text> : null}
      {subtitle ? <Text style={st.sectionSubtitle}>{subtitle}</Text> : null}
      <View style={st.sectionCard}>{children}</View>
    </View>
  );
}

export function SettingsDivider() {
  return <View style={st.divider} />;
}

export function SettingsRow({
  icon, title, subtitle, onPress, right, chevron = true, danger, disabled, testID,
  accessibilityRole: arole, accessibilityState: astate, accessibilityLabel: alabel,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  /** Right-side control (e.g. Switch, value text). Replaces the chevron. */
  right?: React.ReactNode;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityRole?: 'button' | 'radio' | 'checkbox' | 'link' | 'menuitem' | 'none';
  accessibilityState?: { checked?: boolean; selected?: boolean; disabled?: boolean };
  accessibilityLabel?: string;
}) {
  const body = (
    <>
      {icon ? <View style={[st.rowIcon, danger && st.rowIconDanger]}>{icon}</View> : null}
      <View style={{ flex: 1 }}>
        <Text style={[st.rowTitle, danger && st.rowTitleDanger]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={st.rowSubtitle} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right !== undefined
        ? right
        : (onPress && chevron ? <ChevronRight size={18} color={PP.inkMuted} /> : null)}
    </>
  );
  if (!onPress) return <View style={st.row} testID={testID}>{body}</View>;
  return (
    <Pressable
      style={({ pressed }) => [st.row, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={arole ?? 'button'}
      accessibilityLabel={alabel ?? title}
      accessibilityState={astate}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

export function ToggleRow({
  title, subtitle, value, onValueChange, disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      right={
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          accessibilityLabel={title}
          trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

// ── Save button ─────────────────────────────────────────────────────────────

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SaveButton({
  state, onPress, disabled, label = 'Save', testID,
}: {
  state: SaveState;
  onPress: () => void;
  disabled?: boolean;
  label?: string;
  testID?: string;
}) {
  const isDisabled = disabled || state === 'saving' || state === 'saved';
  return (
    <Pressable
      style={[
        st.saveBtn,
        state === 'saved' && st.saveBtnSaved,
        state === 'error' && st.saveBtnError,
        isDisabled && state !== 'saved' && state !== 'saving' && st.saveBtnDisabled,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      {state === 'saving' ? (
        <ActivityIndicator size="small" color={PP.paper} />
      ) : state === 'saved' ? (
        <Check size={16} color={PP.paper} />
      ) : state === 'error' ? (
        <RotateCcw size={14} color={PP.paper} />
      ) : null}
      <Text style={st.saveBtnText}>
        {state === 'saved' ? 'Saved' : state === 'error' ? 'Retry' : label}
      </Text>
    </Pressable>
  );
}

/** Full-width version for bottom-of-form saves. */
export function SaveBar({
  state, onPress, disabled, error, label = 'Save changes',
}: {
  state: SaveState;
  onPress: () => void;
  disabled?: boolean;
  error?: string | null;
  label?: string;
}) {
  return (
    <View style={{ gap: space.sm, marginTop: space.md }}>
      {error ? (
        <View style={st.errorBanner}>
          <AlertCircle size={16} color={PP.seal} />
          <Text style={st.errorBannerText}>{error}</Text>
        </View>
      ) : null}
      <Pressable
        style={[
          st.saveBar,
          state === 'saved' && st.saveBtnSaved,
          (disabled && state === 'idle') && st.saveBtnDisabled,
        ]}
        onPress={onPress}
        disabled={disabled || state === 'saving' || state === 'saved'}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {state === 'saving' ? (
          <ActivityIndicator size="small" color={PP.paper} />
        ) : state === 'saved' ? (
          <><Check size={16} color={PP.paper} /><Text style={st.saveBarText}>Saved</Text></>
        ) : state === 'error' ? (
          <><RotateCcw size={14} color={PP.paper} /><Text style={st.saveBarText}>Retry</Text></>
        ) : (
          <Text style={st.saveBarText}>{label}</Text>
        )}
      </Pressable>
    </View>
  );
}

// ── Form helpers ────────────────────────────────────────────────────────────

export function FieldLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={st.fieldLabelRow}>
      <Text style={st.fieldLabel}>{children}</Text>
      {right ?? null}
    </View>
  );
}

export function FieldHint({ children, tone }: { children: React.ReactNode; tone?: 'error' | 'success' }) {
  return (
    <Text style={[st.fieldHint, tone === 'error' && st.hintError, tone === 'success' && st.hintSuccess]}>
      {children}
    </Text>
  );
}

export function TextField(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={PP.inkMuted + '99'}
      {...props}
      style={[st.input, props.style]}
    />
  );
}

export function ChipGrid({
  options, selected, onToggle, mode = 'checkbox',
}: {
  options: { key: string; label: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  mode?: 'radio' | 'checkbox';
}) {
  return (
    <View style={st.chipGrid}>
      {options.map(({ key, label }) => {
        const on = selected.includes(key);
        return (
          <Pressable
            key={key}
            style={[st.chip, on && st.chipOn]}
            onPress={() => onToggle(key)}
            accessibilityRole={mode}
            accessibilityState={{ selected: on }}
          >
            <Text style={[st.chipText, on && st.chipTextOn]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: PP.paper },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: PP.paper,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
  },
  headerBtn: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  headerRight: { minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: PP.ink, textAlign: 'center' },
  headerSubtitle: { ...t.small, color: PP.inkMuted, fontSize: 11, marginTop: 1, textAlign: 'center' },
  content: { padding: space.lg, gap: space.xl },

  section: { gap: space.xs },
  sectionTitle: {
    fontFamily: 'Courier', fontSize: 11, fontWeight: '700',
    color: PP.inkMuted, letterSpacing: 1.4, textTransform: 'uppercase',
    marginBottom: 2,
  },
  sectionSubtitle: { ...t.small, color: PP.inkMuted, fontSize: 12, lineHeight: 17, marginBottom: 4 },
  sectionCard: {
    backgroundColor: '#FFFDF7',
    borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.borderLight,
    overflow: 'hidden',
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: PP.borderLight, marginLeft: space.lg },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    minHeight: 52,
  },
  rowIcon: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: PP.paperDeep,
    alignItems: 'center', justifyContent: 'center',
  },
  rowIconDanger: { backgroundColor: PP.sealLight },
  rowTitle: { ...t.body, color: PP.ink, fontWeight: '600' },
  rowTitleDanger: { color: PP.seal },
  rowSubtitle: { ...t.small, color: PP.inkMuted, fontSize: 12, marginTop: 1, lineHeight: 16 },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: PP.ink, borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: 8, minWidth: 68, minHeight: 36,
  },
  saveBtnSaved: { backgroundColor: '#2E7D5B' },
  saveBtnError: { backgroundColor: PP.seal },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { ...t.small, color: PP.paper, fontWeight: '700' },

  saveBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: PP.ink, borderRadius: radius.pill,
    paddingVertical: 14, minHeight: 48,
  },
  saveBarText: { ...t.bodyStrong, color: PP.paper, fontWeight: '700', fontSize: 15 },

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: PP.sealLight, borderRadius: radius.sm,
    borderWidth: 1, borderColor: PP.seal + '40', padding: space.md,
  },
  errorBannerText: { ...t.small, color: PP.seal, flex: 1 },

  fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: {
    fontFamily: 'Courier', fontSize: 11, fontWeight: '700',
    color: PP.inkMuted, letterSpacing: 1.2, textTransform: 'uppercase',
  },
  fieldHint: { ...t.small, color: PP.inkMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },
  hintError: { color: PP.seal },
  hintSuccess: { color: '#2E7D5B' },
  input: {
    ...t.body, color: PP.ink,
    backgroundColor: '#FFFDF7',
    borderWidth: 1, borderColor: PP.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 44,
  },

  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill,
    borderWidth: 1, borderColor: PP.border, backgroundColor: '#FFFDF7',
    minHeight: 32, justifyContent: 'center',
  },
  chipOn: { backgroundColor: PP.ink, borderColor: PP.ink },
  chipText: { ...t.small, color: PP.ink, fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: PP.paper },
});
