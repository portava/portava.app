/**
 * WallHeader — the Wall's top chrome (Wall spec §3/§17/§35).
 *
 * Portava brand, current city/context, Notifications and Telegraph, plus the
 * typed session-intent steer bar. The steer bar consumes the platform Global
 * Input Intelligence layer (the parent wires it): typing an intent temporarily
 * steers For You; an active intent shows a clearable chip, and clearing it
 * restores the prior feed (spec §17). The user should understand all of this
 * without knowing Portava's architecture (spec §35).
 */

import React from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { Bell, Send, Sparkles, X, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../theme/tokens.ts';

export function WallHeader({
  city,
  notificationsBadge = 0,
  intentActive = false,
  intentLabel,
  intentPending = false,
  onSetIntent,
  onClearIntent,
  onOpenNotifications,
  onOpenTelegraph,
}: {
  city?: string | null;
  notificationsBadge?: number;
  intentActive?: boolean;
  intentLabel?: string | null;
  intentPending?: boolean;
  onSetIntent?: (text: string) => void;
  onClearIntent?: () => void;
  onOpenNotifications?: () => void;
  onOpenTelegraph?: () => void;
}) {
  const [draft, setDraft] = React.useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSetIntent?.(text);
  };

  const clear = () => {
    setDraft('');
    onClearIntent?.();
  };

  return (
    <View style={s.container}>
      <View style={s.topRow}>
        <Text style={s.brand}>Portava</Text>
        {city ? (
          <View style={s.cityChip}>
            <MapPin size={icon.s14} color={color.deep} />
            <Text style={s.cityText} numberOfLines={1}>
              {city}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={s.actions}>
          <Pressable
            style={s.iconBtn}
            onPress={onOpenNotifications}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            testID="wall-notifications"
          >
            <Bell size={icon.s22} color={color.ink} />
            {notificationsBadge > 0 ? (
              <View style={s.badge}>
                <Text style={s.badgeText}>{notificationsBadge > 9 ? '9+' : String(notificationsBadge)}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            style={s.iconBtn}
            onPress={onOpenTelegraph}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Telegraph"
            testID="wall-telegraph"
          >
            <Send size={icon.s22} color={color.ink} />
          </Pressable>
        </View>
      </View>

      {/* Session-intent steer bar (spec §17) */}
      {intentActive ? (
        <View style={s.intentChip} testID="wall-intent-chip">
          <Sparkles size={icon.s14} color={color.signal} />
          <Text style={s.intentChipText} numberOfLines={1}>
            {intentLabel || 'Steering your feed'}
          </Text>
          <Pressable
            onPress={clear}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear feed steer"
            testID="wall-intent-clear"
          >
            <X size={icon.s16} color={color.mute} />
          </Pressable>
        </View>
      ) : (
        <View style={s.steerBar}>
          <Sparkles size={icon.s16} color={color.faint} />
          <TextInput
            style={s.steerInput}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder="Steer your feed — try “food” or “Bangkok nightlife”"
            placeholderTextColor={color.faint}
            returnKeyType="search"
            editable={!intentPending}
            testID="wall-intent-input"
            accessibilityLabel="Steer your feed"
          />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  brand: { ...t.title, color: color.ink, fontWeight: '800' },
  cityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    flexShrink: 1,
  },
  cityText: { ...t.small, color: color.deep, fontWeight: '700', flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto' },
  iconBtn: { padding: space.xs },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: color.onInk, fontSize: 9, fontWeight: '800' },
  steerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  steerInput: { flex: 1, ...t.body, color: color.ink, padding: 0 },
  intentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  intentChipText: { ...t.small, color: color.ink, fontWeight: '700', maxWidth: 220 },
});
