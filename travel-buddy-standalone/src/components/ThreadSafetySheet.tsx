/**
 * ThreadSafetySheet — safety and privacy controls accessible from the "…" overflow
 * in any Telegraph thread header.
 *
 * Controls:
 *  - Hide AI suggestions toggle (AsyncStorage per-thread)
 *  - Mute notifications toggle (API call)
 *  - Block user (DM only) — destructive
 *  - Report conversation — reason picker
 *  - Leave group (trip/circle only) — destructive
 *  - Delete for me (archive) — destructive
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import {
  Bot,
  VolumeX,
  Volume2,
  UserX,
  Flag,
  LogOut,
  Trash2,
  X,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  threadType: 'direct' | 'trip' | 'circle';
  otherUserId?: string | null;
  isMuted: boolean;
  onToggleMute: () => Promise<void>;
  hideAiSuggestions: boolean;
  onToggleHideAi: () => void;
  onBlock?: () => void;
  onLeave?: () => void;
  onDeleteForMe?: () => void;
  onReport?: (reason: string) => Promise<void>;
}

const REPORT_REASONS = [
  'Spam or advertising',
  'Harassment or bullying',
  'Inappropriate content',
  'Misinformation',
  'Threats or violence',
  'Other',
];

function ReportSheet({ onClose, onReport }: { onClose: () => void; onReport?: (reason: string) => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit() {
    if (!selected) return;
    setSending(true);
    if (onReport) {
      await onReport(selected).catch(() => {});
    }
    setSending(false);
    onClose();
    Alert.alert('Report submitted', 'Thank you. Our team will review this conversation.');
  }

  return (
    <View style={rs.wrap}>
      <View style={rs.handle} />
      <Text style={rs.title}>Report this conversation</Text>
      <Text style={rs.sub}>What's wrong with this conversation?</Text>

      {REPORT_REASONS.map((reason) => (
        <Pressable
          key={reason}
          style={[rs.option, selected === reason && rs.optionSelected]}
          onPress={() => setSelected(reason)}
        >
          <Text style={[rs.optionText, selected === reason && rs.optionTextSelected]}>{reason}</Text>
          {selected === reason && <Text style={rs.check}>✓</Text>}
        </Pressable>
      ))}

      <Pressable
        style={[rs.submitBtn, (!selected || sending) && rs.submitBtnDisabled]}
        onPress={handleSubmit}
        disabled={!selected || sending}
      >
        {sending ? (
          <ActivityIndicator size="small" color={color.onInk} />
        ) : (
          <Text style={rs.submitLabel}>Submit Report</Text>
        )}
      </Pressable>
      <Pressable style={rs.cancelBtn} onPress={onClose}>
        <Text style={rs.cancelLabel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

export function ThreadSafetySheet({
  visible,
  onClose,
  threadType,
  otherUserId,
  isMuted,
  onToggleMute,
  hideAiSuggestions,
  onToggleHideAi,
  onBlock,
  onLeave,
  onDeleteForMe,
  onReport,
}: Props) {
  const [mutingBusy, setMutingBusy] = useState(false);
  const [showReport, setShowReport] = useState(false);

  async function handleToggleMute() {
    setMutingBusy(true);
    try { await onToggleMute(); } catch { /* ignore */ }
    setMutingBusy(false);
  }

  function handleBlock() {
    onClose();
    Alert.alert(
      'Block user?',
      "They won't be able to message you or see your profile.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: onBlock },
      ],
    );
  }

  function handleLeave() {
    onClose();
    Alert.alert(
      'Leave group?',
      'You will no longer have access to this chat.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: onLeave },
      ],
    );
  }

  function handleDeleteForMe() {
    onClose();
    Alert.alert(
      'Delete for me?',
      'This conversation will be removed from your inbox. This only affects your view.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDeleteForMe },
      ],
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sh.overlay} onPress={onClose} />
      <View style={sh.sheet}>
        {showReport ? (
          <ReportSheet onClose={() => { setShowReport(false); onClose(); }} onReport={onReport} />
        ) : (
          <>
            <View style={sh.handle} />
            <View style={sh.headerRow}>
              <Text style={sh.title}>Chat settings</Text>
              <Pressable onPress={onClose} hitSlop={8}><X size={18} color={color.mute} /></Pressable>
            </View>

            {/* Hide AI suggestions toggle */}
            <View style={sh.toggleRow}>
              <View style={sh.toggleLeft}>
                <Bot size={18} color={color.ink} />
                <View>
                  <Text style={sh.rowLabel}>Hide AI suggestions</Text>
                  <Text style={sh.rowSub}>Don't show Compass AI cards above composer</Text>
                </View>
              </View>
              <Switch
                value={hideAiSuggestions}
                onValueChange={onToggleHideAi}
                trackColor={{ false: color.haze, true: color.signal }}
                thumbColor={color.onInk}
              />
            </View>

            {/* Mute notifications */}
            <View style={sh.toggleRow}>
              <View style={sh.toggleLeft}>
                {isMuted
                  ? <Volume2 size={18} color={color.ink} />
                  : <VolumeX size={18} color={color.ink} />}
                <View>
                  <Text style={sh.rowLabel}>{isMuted ? 'Unmute notifications' : 'Mute notifications'}</Text>
                  <Text style={sh.rowSub}>{isMuted ? 'Re-enable push alerts for this chat' : 'Silence push alerts for this chat'}</Text>
                </View>
              </View>
              {mutingBusy ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <Switch
                  value={isMuted}
                  onValueChange={handleToggleMute}
                  trackColor={{ false: color.haze, true: color.signal }}
                  thumbColor={color.onInk}
                />
              )}
            </View>

            <View style={sh.divider} />

            {/* Report */}
            <Pressable style={sh.row} onPress={() => setShowReport(true)}>
              <Flag size={18} color={color.ink} />
              <Text style={sh.rowLabel}>Report conversation</Text>
            </Pressable>

            {/* Block — DM only */}
            {threadType === 'direct' && otherUserId && (
              <Pressable style={sh.row} onPress={handleBlock}>
                <UserX size={18} color="#EF4444" />
                <Text style={[sh.rowLabel, sh.destructive]}>Block user</Text>
              </Pressable>
            )}

            {/* Leave — group only */}
            {(threadType === 'trip' || threadType === 'circle') && onLeave && (
              <Pressable style={sh.row} onPress={handleLeave}>
                <LogOut size={18} color="#EF4444" />
                <Text style={[sh.rowLabel, sh.destructive]}>Leave group</Text>
              </Pressable>
            )}

            {/* Delete for me */}
            {onDeleteForMe && (
              <Pressable style={sh.row} onPress={handleDeleteForMe}>
                <Trash2 size={18} color="#EF4444" />
                <Text style={[sh.rowLabel, sh.destructive]}>Delete for me</Text>
              </Pressable>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

const sh = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    paddingTop: space.sm,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md, flex: 1, paddingRight: space.md },

  divider: { height: 8, marginHorizontal: -space.lg, backgroundColor: color.paper, marginVertical: space.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  rowLabel: { ...t.body, color: color.ink },
  rowSub: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  destructive: { color: '#EF4444' },
});

const rs = StyleSheet.create({
  wrap: { gap: space.sm },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16, marginBottom: 2 },
  sub: { ...t.small, color: color.mute, marginBottom: space.md },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.xs,
  },
  optionSelected: { borderColor: color.signal, backgroundColor: color.signal + '0A' },
  optionText: { ...t.body, color: color.ink },
  optionTextSelected: { color: color.signal, fontWeight: '700' },
  check: { fontSize: 14, color: color.signal, fontWeight: '700' },
  submitBtn: {
    marginTop: space.md,
    backgroundColor: '#EF4444',
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.45 },
  submitLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelLabel: { ...t.body, color: color.mute },
});
