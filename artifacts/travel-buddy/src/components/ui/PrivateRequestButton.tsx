/**
 * PrivateRequestButton — shared "Send Request" / "Request sent" button for
 * private-profile surfaces.
 *
 * Used by:
 *   - app/u/[username].tsx  (private-profile wall)
 *   - src/components/compass/CompassTravelerRow.tsx  (traveler card)
 *
 * Calls followUser() internally; for private profiles the server converts a
 * follow into a friend request.  On success the button transitions to the
 * pending state and cannot be pressed again.
 */
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { Clock, Lock } from 'lucide-react-native';
import { followUser } from '../../services/follows.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  userId: string;
  /** Pre-seed the pending state when the API already reported a pending request. */
  initialPending?: boolean;
  /** Optional callback fired after a successful send (before state update). */
  onRequestSent?: () => void;
  style?: object;
}

export function PrivateRequestButton({
  userId,
  initialPending = false,
  onRequestSent,
  style,
}: Props) {
  const [pending, setPending] = useState(initialPending);
  const [inFlight, setInFlight] = useState(false);

  // Sync prop changes so the wall button reflects state set by the header badge
  // (parent flips requestSent → initialPending becomes true → we disable here too).
  useEffect(() => {
    if (initialPending) setPending(true);
  }, [initialPending]);

  async function handlePress() {
    if (pending || inFlight) return;
    setInFlight(true);
    try {
      const res = await followUser(userId);
      if (res.ok) {
        onRequestSent?.();
        setPending(true);
      } else {
        Alert.alert('Could not send request', res.message ?? 'Please try again.');
      }
    } catch {
      Alert.alert('Could not send request', 'Please try again.');
    } finally {
      setInFlight(false);
    }
  }

  if (pending) {
    return (
      <View style={[s.btn, s.pendingBtn, style]}>
        <Clock size={15} color={color.mute} />
        <Text style={[s.btnText, s.pendingText]}>Request sent</Text>
      </View>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [s.btn, s.requestBtn, pressed && { opacity: 0.8 }, style]}
      onPress={handlePress}
      disabled={inFlight}
    >
      {inFlight
        ? <ActivityIndicator size="small" color="#fff" style={{ marginRight: 4 }} />
        : <Lock size={15} color="#fff" />
      }
      <Text style={[s.btnText, s.requestText]}>
        {inFlight ? 'Sending…' : 'Send Request'}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  requestBtn: {
    backgroundColor: color.ink,
  },
  pendingBtn: {
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  btnText: {
    ...t.small,
    fontWeight: '700' as const,
    fontSize: 14,
  },
  requestText: {
    color: '#fff',
  },
  pendingText: {
    color: color.mute,
  },
});
