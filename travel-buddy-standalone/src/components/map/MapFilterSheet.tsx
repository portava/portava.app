/**
 * MapFilterSheet — bottom sheet overlay for toggling map entity layers.
 *
 * Each toggleable layer (Buddies, Events, Gems, Trips, Friends) gets a row
 * with a colour swatch, label, and native Switch. State is persisted to
 * AsyncStorage so the user's preferences survive app restarts.
 *
 * 'places' and 'travelers' are controlled by DiscoveryMapView's own filter UI
 * and are intentionally excluded here to avoid conflicting controls.
 */
import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  Switch,
  StyleSheet,
  ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { X } from 'lucide-react-native';
import { color, radius, space, type as t, shadow, avatar, icon } from '../../theme/tokens.ts';
import { MAP_LAYER_CONFIG, TOGGLEABLE_LAYERS } from '../../types/mapTypes.ts';
import type { ToggleableEntityType } from '../../types/mapTypes.ts';

const STORAGE_KEY = 'map_entity_layers_v1';

const DEFAULT_ENABLED: ToggleableEntityType[] = [...TOGGLEABLE_LAYERS];

/** Load saved layer preferences from AsyncStorage. */
export async function loadEnabledLayers(): Promise<ToggleableEntityType[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ENABLED;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_ENABLED;
    // Only keep values that are still valid toggleable types.
    const valid = parsed.filter((v): v is ToggleableEntityType =>
      TOGGLEABLE_LAYERS.includes(v as ToggleableEntityType),
    );
    return valid.length > 0 ? valid : DEFAULT_ENABLED;
  } catch {
    return DEFAULT_ENABLED;
  }
}

export async function saveEnabledLayers(layers: ToggleableEntityType[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(layers));
  } catch {
    // non-fatal — preferences revert to default on next mount
  }
}

// ── Layer descriptions ─────────────────────────────────────────────────────────

const LAYER_DESCRIPTION: Record<ToggleableEntityType, string> = {
  buddies: 'Local guides available for hire',
  events:  'Live & upcoming events (next 24 h)',
  gems:    'Community hidden gems',
  trips:   'Your public & friends-visible trips',
  friends: 'Circle members sharing their location',
};

// ── Component ─────────────────────────────────────────────────────────────────

export interface MapFilterSheetProps {
  visible: boolean;
  onClose: () => void;
  enabledLayers: ToggleableEntityType[];
  onChangeEnabledLayers: (layers: ToggleableEntityType[]) => void;
}

export function MapFilterSheet({
  visible,
  onClose,
  enabledLayers,
  onChangeEnabledLayers,
}: MapFilterSheetProps) {
  const [localEnabled, setLocalEnabled] = useState<Set<ToggleableEntityType>>(
    () => new Set(enabledLayers),
  );

  // Sync local state when parent changes (e.g. after initial AsyncStorage load).
  useEffect(() => {
    setLocalEnabled(new Set(enabledLayers));
  }, [enabledLayers]);

  const toggle = (layer: ToggleableEntityType) => {
    const next = new Set(localEnabled);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setLocalEnabled(next);
    const arr = TOGGLEABLE_LAYERS.filter((l) => next.has(l));
    onChangeEnabledLayers(arr);
    void saveEnabledLayers(arr);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <Pressable style={s.backdrop} onPress={onClose} />

      <View style={s.sheet} pointerEvents="box-none">
        {/* Handle */}
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Map Layers</Text>
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        <Text style={s.subtitle}>
          Toggle which types of pins appear on the map.
        </Text>

        <ScrollView
          style={s.list}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
        >
          {TOGGLEABLE_LAYERS.map((layer) => {
            const cfg = MAP_LAYER_CONFIG[layer];
            const enabled = localEnabled.has(layer);
            return (
              <View key={layer} style={s.row}>
                <View style={[s.swatch, { backgroundColor: cfg.color }]} />
                <View style={s.rowText}>
                  <Text style={s.rowLabel}>{cfg.label}</Text>
                  <Text style={s.rowDesc} numberOfLines={1}>
                    {LAYER_DESCRIPTION[layer]}
                  </Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={() => toggle(layer)}
                  trackColor={{ false: color.haze, true: cfg.color + 'AA' }}
                  thumbColor={enabled ? cfg.color : '#fff'}
                />
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 36,
    ...shadow.card,
    elevation: 16,
  },
  handle: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 2,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    fontSize: 12,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: space.lg,
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  swatch: {
    width: icon.s18, height: icon.s18,
    borderRadius: icon.s18 / 2,
    flexShrink: 0,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
  },
  rowDesc: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
    marginTop: 1,
  },
});
