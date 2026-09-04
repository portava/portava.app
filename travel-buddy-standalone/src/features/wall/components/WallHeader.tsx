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
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Bell, Send, Sparkles, X, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../theme/tokens.ts';
import { SmartInput } from '../../../platform/input-assistance/components/SmartInput.tsx';
import { registerField, isFieldRegistered } from '../../../platform/input-assistance/contexts/fieldRegistry.ts';
import type { InputSuggestion } from '../../../platform/input-assistance/types/inputSuggestion.ts';
import { resolveWallIntent, type ResolvedWallIntent } from '../services/wallSessionIntent.ts';

/**
 * The Wall steer bar joins the platform Global Input Intelligence layer by
 * registering a field, not by owning an autocomplete engine (spec §17). It uses
 * the `global_search` context so typeahead can resolve canonical entities
 * (cities, places, people, interests…) as well as free-text intent.
 */
const WALL_INTENT_FIELD_ID = 'wall.session_intent';
if (!isFieldRegistered(WALL_INTENT_FIELD_ID)) {
  registerField(WALL_INTENT_FIELD_ID, 'global_search');
}

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
  /** Submit the RESOLVED intent — a structured entity filter or free-text (§17). */
  onSetIntent?: (intent: ResolvedWallIntent) => void;
  onClearIntent?: () => void;
  onOpenNotifications?: () => void;
  onOpenTelegraph?: () => void;
}) {
  const [draft, setDraft] = React.useState('');

  // Free-text steer (return key): submit the raw typed intent (§17 example
  // 'food' / 'Bangkok nightlife'). The server parses it into structured filters.
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSetIntent?.({ text });
  };

  // A canonical entity (or query completion) chosen from typeahead: submit the
  // RESOLVED intent — an entity becomes a structured filter, not a raw string
  // (§17). Returning false suppresses SmartInput's default field mutation since
  // the steer chip replaces the input entirely.
  const onSelectSuggestion = (suggestion: InputSuggestion): boolean => {
    const resolved = resolveWallIntent(suggestion);
    if (resolved.text) onSetIntent?.(resolved);
    return false;
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
          {/* Global Input Intelligence typeahead (spec §17): entity selection
              becomes a structured filter, free text is a temporary steer. The
              steer chip replaces this input once an intent is active. The flex
              wrapper lets SmartInput fill the pill; its own input chrome is
              neutralised (transparent) so the pill remains the visible frame. */}
          <View style={s.steerInputWrap}>
            <SmartInput
              fieldId={WALL_INTENT_FIELD_ID}
              context="global_search"
              value={draft}
              onChangeText={setDraft}
              onSelectSuggestion={onSelectSuggestion}
              onSubmitEditing={submit}
              style={s.steerInput}
              placeholder="Steer your feed — try “food” or “Bangkok nightlife”"
              returnKeyType="search"
              editable={!intentPending}
              testID="wall-intent-input"
              label="Steer your feed"
              overlayMaxHeight={260}
            />
          </View>
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
  steerInputWrap: { flex: 1 },
  // Neutralise SmartInput's default bordered/padded input chrome so the steer
  // pill (steerBar) stays the single visible frame.
  steerInput: {
    ...t.body,
    color: color.ink,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
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
