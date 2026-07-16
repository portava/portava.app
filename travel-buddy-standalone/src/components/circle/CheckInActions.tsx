import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { MapPin, Users, LogOut, Shield, AlertTriangle } from 'lucide-react-native';
import { postCheckIn } from '../../services/circle';
import { color, type as t } from '../../theme/tokens';

export type CheckinType = 'arrived' | 'with_group' | 'leaving' | 'safe';

interface ActionConfig {
  type: CheckinType;
  label: string;
  bg: string;
  textColor: string;
  icon: (color: string) => React.ReactNode;
}

const ACTIONS: ActionConfig[] = [
  {
    type: 'arrived',
    label: 'I arrived',
    bg: '#E3F2FD',
    textColor: '#1565C0',
    icon: (c) => <MapPin size={14} color={c} />,
  },
  {
    type: 'with_group',
    label: "I'm with the group",
    bg: '#E0F2F1',
    textColor: '#00695C',
    icon: (c) => <Users size={14} color={c} />,
  },
  {
    type: 'leaving',
    label: "I'm leaving",
    bg: '#FFF3E0',
    textColor: '#E65100',
    icon: (c) => <LogOut size={14} color={c} />,
  },
  {
    type: 'safe',
    label: "I'm safe",
    bg: '#E8F5E9',
    textColor: '#2E7D32',
    icon: (c) => <Shield size={14} color={c} />,
  },
];

interface Props {
  contextType: 'trip' | 'event';
  contextId: string;
  disabled?: boolean;
  onCheckInComplete: (checkinType: CheckinType) => void;
  onNeedHelp: () => void;
}

export function CheckInActions({ contextType, contextId, disabled, onCheckInComplete, onNeedHelp }: Props) {
  const [loading, setLoading] = useState<CheckinType | null>(null);

  async function handleCheckIn(type: CheckinType) {
    if (loading || disabled) return;
    setLoading(type);
    try {
      const res = await postCheckIn(contextType, contextId, { checkinType: type });
      if (res.ok) {
        onCheckInComplete(type);
      } else {
        Alert.alert('Could not check in', res.error === 'forbidden' ? 'You are not a member of this context.' : 'Please try again.');
      }
    } catch {
      Alert.alert('Could not check in', 'Network error. Please try again.');
    } finally {
      setLoading(null);
    }
  }

  function handleNeedHelp() {
    Alert.alert(
      'I need help',
      'Safe Return notifies your emergency contacts — not your Circle members. Your location stays private.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Safe Return', onPress: onNeedHelp, style: 'destructive' },
      ],
    );
  }

  return (
    <View style={s.wrap}>
      <Text style={s.label}>Check in</Text>
      <View style={s.row}>
        {ACTIONS.map((action) => (
          <Pressable
            key={action.type}
            style={[
              s.btn,
              { backgroundColor: disabled ? color.haze : action.bg },
              (loading && loading !== action.type) && s.btnFaded,
            ]}
            onPress={() => handleCheckIn(action.type)}
            disabled={Boolean(loading || disabled)}
          >
            {loading === action.type ? (
              <ActivityIndicator size="small" color={action.textColor} />
            ) : (
              action.icon(disabled ? color.faint : action.textColor)
            )}
            <Text style={[s.btnText, { color: disabled ? color.faint : action.textColor }]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={s.helpBtn} onPress={handleNeedHelp} disabled={Boolean(disabled)}>
        <AlertTriangle size={14} color="#B71C1C" />
        <Text style={s.helpText}>I need help</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  label: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  btnFaded: { opacity: 0.4 },
  btnText: { ...t.small, fontWeight: '600' },
  helpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    marginTop: 2,
  },
  helpText: { ...t.small, color: '#B71C1C', fontWeight: '600' },
});
