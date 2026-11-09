import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { BadgeCheck } from 'lucide-react-native';
import { usePrivateSurfaceKey } from '../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../hooks/useMediaSurfaceActivity.ts';
import { captureMessagingOwnerRequest } from '../../services/messagingOwnerRequest.ts';
import { color, space } from '../../theme/tokens.ts';
import { readRecordingStamp, type CaptureTarget, type RecordingStamp as Stamp } from './recordingStamp.ts';

export function RecordingStampOption({ selected, onChange, disabled }: { selected: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: !!disabled }} disabled={disabled}
    onPress={() => onChange(!selected)} style={s.option}>
    <BadgeCheck color={selected ? color.deep : color.mute} size={20} />
    <Text style={s.optionLabel}>{selected ? '✓ ' : ''}Add a Portava recording stamp</Text>
  </Pressable>;
}

interface BadgeProps { targetType: CaptureTarget; targetId: string; onInspectChange?: (open: boolean) => void }
export function RecordingStampBadge({ targetType, targetId, onInspectChange }: BadgeProps) {
  const scope = usePrivateSurfaceKey();
  return <CurrentBadge key={`${scope}:${targetType}:${targetId}`} targetType={targetType} targetId={targetId} onInspectChange={onInspectChange} />;
}
function CurrentBadge({ targetType, targetId, onInspectChange }: BadgeProps) {
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [checking, setChecking] = useState(false);
  const activity = useMediaSurfaceActivity(() => { setStamp(null); setChecking(false); });
  useEffect(() => {
    const owner = activity.active ? captureMessagingOwnerRequest() : null;
    if (!owner) return;
    void readRecordingStamp(owner, targetType, targetId).then(result => {
      if (owner.isCurrent() && activity.isCurrent()) setStamp(result);
    }).catch(() => {});
    return () => owner.invalidate();
  }, [targetType, targetId, activity.active, activity.isCurrent]);
  async function verify() {
    if (checking) return;
    const owner = captureMessagingOwnerRequest();
    if (!owner) return;
    setChecking(true); onInspectChange?.(true);
    try {
      const result = await readRecordingStamp(owner, targetType, targetId);
      if (!owner.isCurrent() || !activity.isCurrent()) return;
      setStamp(result);
      const done = () => onInspectChange?.(false);
      if (result) Alert.alert('Portava recording stamp', `${result.code}\nPortava issued this code for the recording uploaded to this ${targetType}.\nIssued ${new Date(result.issuedAt).toLocaleDateString()}.`,
        [{ text: 'Done', onPress: done }], { cancelable: true, onDismiss: done });
      else { done(); Alert.alert('Recording stamp unavailable'); }
    } catch { if (owner.isCurrent() && activity.isCurrent()) { onInspectChange?.(false); Alert.alert('Couldn’t verify this stamp', 'Please try again.'); } }
    finally { if (owner.isCurrent() && activity.isCurrent()) setChecking(false); owner.invalidate(); }
  }
  if (!stamp || !activity.active) return null;
  return <View style={s.badgeWrap}><Pressable accessibilityRole="button" accessibilityLabel={`Verify Portava recording stamp ${stamp.code}`}
    accessibilityState={{ busy: checking }} onPress={() => void verify()} style={s.badge}>
    <RecordingMark code={stamp.code} /><Text style={s.badgeText}>{stamp.code.replace(/^PV-([0-9A-F]{32})$/, (_full, digits: string) => 'PV-' + digits.match(/.{1,8}/g)!.join(' '))}</Text>
  </Pressable></View>;
}
// Each issued code has a distinct ink pattern. Only the server read verifies it.
function RecordingMark({ code }: { code: string }) {
  let hash = 2166136261;
  for (const char of code) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={s.mark}>
    {Array.from({ length: 25 }, (_, index) => {
      const column = index % 5;
      const bit = Math.floor(index / 5) * 3 + Math.min(column, 4 - column);
      return <View key={index} style={[s.dot, { opacity: ((hash >>> bit) & 1) || index === 12 ? 1 : 0 }]} />;
    })}
  </View>;
}
const s = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  optionLabel: { color: color.ink, fontSize: 15 }, badgeWrap: { alignItems: 'flex-start' },
  badge: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 10, backgroundColor: color.deep },
  mark: { width: 20, height: 20, flexDirection: 'row', flexWrap: 'wrap' },
  dot: { width: 4, height: 4, backgroundColor: color.onInk },
  badgeText: { flexShrink: 1, fontSize: 12, fontWeight: '700', color: color.onInk },
});
