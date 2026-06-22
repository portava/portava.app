/**
 * ManualCityPicker — bottom-sheet city selector.
 *
 * Shows a text input + quick-pick list of popular travel cities.
 * Calls setManualCity() from LocationContext on selection.
 */
import React, { useState, useMemo } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList,
  Modal, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { X, MapPin, Search } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { useLocationContext } from '../context/LocationContext';

// ── Popular cities ────────────────────────────────────────────────────────────

const POPULAR: { city: string; country: string; emoji: string }[] = [
  { city: 'Bangkok',       country: 'Thailand',     emoji: '🇹🇭' },
  { city: 'Bali',          country: 'Indonesia',    emoji: '🇮🇩' },
  { city: 'Tokyo',         country: 'Japan',        emoji: '🇯🇵' },
  { city: 'Paris',         country: 'France',       emoji: '🇫🇷' },
  { city: 'Barcelona',     country: 'Spain',        emoji: '🇪🇸' },
  { city: 'New York',      country: 'USA',          emoji: '🇺🇸' },
  { city: 'London',        country: 'UK',           emoji: '🇬🇧' },
  { city: 'Singapore',     country: 'Singapore',    emoji: '🇸🇬' },
  { city: 'Istanbul',      country: 'Turkey',       emoji: '🇹🇷' },
  { city: 'Dubai',         country: 'UAE',          emoji: '🇦🇪' },
  { city: 'Cebu City',     country: 'Philippines',  emoji: '🇵🇭' },
  { city: 'Ho Chi Minh',   country: 'Vietnam',      emoji: '🇻🇳' },
  { city: 'Lisbon',        country: 'Portugal',     emoji: '🇵🇹' },
  { city: 'Mexico City',   country: 'Mexico',       emoji: '🇲🇽' },
  { city: 'Cape Town',     country: 'South Africa', emoji: '🇿🇦' },
  { city: 'Amsterdam',     country: 'Netherlands',  emoji: '🇳🇱' },
  { city: 'Medellín',      country: 'Colombia',     emoji: '🇨🇴' },
  { city: 'Kuala Lumpur',  country: 'Malaysia',     emoji: '🇲🇾' },
];

interface Props {
  /** When provided, replaces the context's showCityPicker flag (standalone use). */
  visible?: boolean;
  onClose?: () => void;
  onSelect?: (city: string, country: string) => void;
}

export function ManualCityPicker({ visible, onClose, onSelect }: Props) {
  const ctx = useLocationContext();
  const isVisible = visible ?? ctx.showCityPicker;
  const handleClose = onClose ?? ctx.closeCityPicker;

  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return POPULAR;
    const q = query.toLowerCase();
    return POPULAR.filter(
      (c) => c.city.toLowerCase().includes(q) || c.country.toLowerCase().includes(q),
    );
  }, [query]);

  async function pick(city: string, country: string) {
    if (onSelect) {
      onSelect(city, country);
    } else {
      await ctx.setManualCity(city, country);
    }
    setQuery('');
    handleClose();
  }

  async function confirmCustom() {
    const trimmed = query.trim();
    if (!trimmed) return;
    await pick(trimmed, '');
  }

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={s.backdrop} onPress={handleClose} />
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Choose a City</Text>
            <Pressable style={s.closeBtn} onPress={handleClose} hitSlop={12}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {/* Search input */}
          <View style={s.searchRow}>
            <Search size={16} color={color.mute} />
            <TextInput
              style={s.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Search cities…"
              placeholderTextColor={color.faint}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={confirmCustom}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <X size={14} color={color.mute} />
              </Pressable>
            )}
          </View>

          {/* Custom city confirm row */}
          {query.trim().length > 0 && !filtered.find((c) => c.city.toLowerCase() === query.toLowerCase()) && (
            <Pressable style={s.customRow} onPress={confirmCustom}>
              <MapPin size={15} color={color.signal} />
              <Text style={s.customText}>Use "<Text style={{ fontWeight: '700' }}>{query.trim()}</Text>"</Text>
            </Pressable>
          )}

          {/* City list */}
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.city}
            style={s.list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                onPress={() => pick(item.city, item.country)}
              >
                <Text style={s.rowEmoji}>{item.emoji}</Text>
                <View style={s.rowText}>
                  <Text style={s.rowCity}>{item.city}</Text>
                  <Text style={s.rowCountry}>{item.country}</Text>
                </View>
                <MapPin size={14} color={color.faint} />
              </Pressable>
            )}
            ListEmptyComponent={
              <View style={s.empty}>
                <Text style={s.emptyText}>No matches. Type a city name above.</Text>
              </View>
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '80%',
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  title: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  closeBtn: {
    padding: space.xs,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.xl,
    marginBottom: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 44,
  },
  input: {
    flex: 1,
    ...t.body,
    color: color.ink,
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: '#FFF5F2',
    marginHorizontal: space.xl,
    borderRadius: radius.md,
    marginBottom: space.xs,
  },
  customText: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  list: {
    flex: 1,
    paddingHorizontal: space.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  rowPressed: {
    backgroundColor: color.paperRaised,
  },
  rowEmoji: {
    fontSize: 22,
    width: 30,
    textAlign: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowCity: {
    ...t.body,
    fontWeight: '600',
    color: color.ink,
  },
  rowCountry: {
    ...t.small,
    color: color.mute,
  },
  empty: {
    padding: space.xl,
    alignItems: 'center',
  },
  emptyText: {
    ...t.body,
    color: color.mute,
  },
});
