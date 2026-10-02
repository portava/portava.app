import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { MapPin, Users, LogOut, Shield, AlertTriangle } from 'lucide-react-native';
import { postCheckIn, postNeedHelp } from '../../services/circle.ts';
import { color, type as t } from '../../theme/tokens.ts';

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
  /** Opens Safe Return (emergency contacts). */
  onNeedHelp: () => void;
  /**
   * True when the viewer HOSTS this trip/event. The circle need-help alert
   * goes to the host only (routes/circle.ts), so a host pressing it would
   * alert nobody — the option is not offered to them.
   */
  isHost?: boolean;
  /** Called after the host alert was accepted by the server. */
  onHostAlerted?: () => void;
}

export function CheckInActions({ contextType, contextId, disabled, onCheckInComplete, onNeedHelp, isHost = false, onHostAlerted }: Props) {
  const [loading, setLoading] = useState<CheckinType | null>(null);
  const [alerting, setAlerting] = useState(false);

  // TM-social MAP-F08 — POST /circle/contexts/:type/:id/need-help. The copy
  // says exactly what the server does: one alert to the HOST, no location, no
  // broadcast to members. A refusal is shown as a refusal, never as "sent".
  async function alertHost() {
    if (alerting) return;
    setAlerting(true);
    try {
      const res = await postNeedHelp(contextType, contextId);
      if (res.ok) {
        onHostAlerted?.();
        Alert.alert(
          'Alert sent to the host',
          `The ${contextType === 'trip' ? 'trip' : 'event'} host has been alerted that you need help. Your location was not shared. If you are in danger, contact local emergency services.`,
        );
      } else if (res.status === 429) {
        Alert.alert('Alert not sent', 'You have sent several alerts in a short time. Wait a moment, or open Safe Return to reach your emergency contacts.');
      } else if (res.status === 403) {
        Alert.alert('Alert not sent', 'You are not a member of this circle, so the host could not be alerted.');
      } else {
        Alert.alert('Alert not sent', 'The host could not be alerted. Check your connection and try again, or open Safe Return.');
      }
    } finally {
      setAlerting(false);
    }
  }

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
    if (isHost) {
      Alert.alert(
        'I need help',
        'Safe Return notifies your emergency contacts — not your Circle members. Your location stays private.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Safe Return', onPress: onNeedHelp, style: 'destructive' },
        ],
      );
      return;
    }
    Alert.alert(
      'I need help',
      `Alert the host of this ${contextType} that you need help (your location is not shared), or open Safe Return to notify your emergency contacts.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Alert the host', onPress: () => { void alertHost(); }, style: 'destructive' },
        { text: 'Open Safe Return', onPress: onNeedHelp },
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
      <Pressable
        style={s.helpBtn}
        onPress={handleNeedHelp}
        disabled={Boolean(disabled) || alerting}
        accessibilityRole="button"
        accessibilityLabel="I need help"
        testID="circle-need-help"
      >
        {alerting ? <ActivityIndicator size="small" color="#B71C1C" /> : <AlertTriangle size={14} color="#B71C1C" />}
        <Text style={s.helpText}>{alerting ? 'Alerting the host…' : 'I need help'}</Text>
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
