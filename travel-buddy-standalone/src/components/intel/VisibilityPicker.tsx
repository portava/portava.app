/**
 * VisibilityPicker — who may see a Trail movement signal.
 *
 * Lists the seven visibilities the spec allows, private-first (the safe default).
 * "No public location sharing by default": `private` is preselected and sits at
 * the top; `public` is last. Each row states plainly what it exposes.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import {
  Lock, ChartBar, Users, UserCheck, Mail, Clock, Globe, Check,
} from 'lucide-react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import {
  TRAIL_VISIBILITY_ORDER,
  VISIBILITY_META,
  type Visibility,
} from '../../lib/intel/contracts.ts';

const ICONS: Record<Visibility, React.ComponentType<{ size?: number; color?: string }>> = {
  private: Lock,
  aggregate_only: ChartBar,
  crew: Users,
  followers: UserCheck,
  invite_only: Mail,
  delayed: Clock,
  public: Globe,
};

export interface VisibilityPickerProps {
  value: Visibility;
  onChange: (v: Visibility) => void;
}

export function VisibilityPicker({ value, onChange }: VisibilityPickerProps) {
  return (
    <View style={styles.list}>
      {TRAIL_VISIBILITY_ORDER.map((v) => {
        const meta = VISIBILITY_META[v];
        const Icon = ICONS[v];
        const selected = v === value;
        const danger = v === 'public';
        return (
          <Pressable
            key={v}
            testID={`intel-visibility-${v}`}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={meta.label}
            onPress={() => onChange(v)}
            style={({ pressed }) => [
              styles.row,
              selected && styles.rowSelected,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={[styles.iconWrap, selected && styles.iconWrapSelected]}>
              <Icon size={16} color={selected ? color.onInk : danger ? color.signal : color.mute} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>
                {meta.label}
                {v === 'private' ? <Text style={styles.defaultTag}>  · default</Text> : null}
              </Text>
              <Text style={styles.desc} numberOfLines={2}>{meta.description}</Text>
            </View>
            {selected ? <Check size={18} color={color.signal} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  rowSelected: { borderColor: color.ink, backgroundColor: color.paper },
  rowPressed: { opacity: 0.85 },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  iconWrapSelected: { backgroundColor: color.ink },
  label: { ...typography.cardTitle, color: color.ink },
  defaultTag: { ...typography.metadata, color: color.mute },
  desc: { ...typography.caption, color: color.mute, marginTop: 2 },
});
