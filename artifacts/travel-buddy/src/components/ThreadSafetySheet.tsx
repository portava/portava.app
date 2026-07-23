/**
 * ThreadSafetySheet — safety and privacy controls accessible from the "…" overflow
 * in any Telegraph thread header.
 *
 * Controls:
 *  - Hide AI suggestions toggle (AsyncStorage per-thread)
 *  - Mute notifications toggle (API call)
 *  - Verify safety number (E2EE 1:1 DM only) — opens SafetyNumberScreen inline
 *  - Block user (DM only) — destructive
 *  - Report conversation — uses unified ReportSheet
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
  ShieldCheck,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { SafetyNumberScreen } from '../screens/SafetyNumberScreen.tsx';
import { ReportSheet } from './ReportSheet.tsx';

interface Props {
  visible: boolean;
  onClose: () => void;
  threadType: 'direct' | 'trip' | 'circle';
  otherUserId?: string | null;
  otherUserName?: string | null;
  isMuted: boolean;
  onToggleMute: () => Promise<void>;
  hideAiSuggestions: boolean;
  onToggleHideAi: () => void;
  onBlock?: () => void;
  onLeave?: () => void;
  onDeleteForMe?: () => void;
  /** Legacy fallback — used for group thread reporting when no user subject is available. */
  onReport?: (reason: string) => Promise<void>;
  /** E-2: set true for 1:1 E2EE DM threads to reveal "Verify safety number" row. */
  isE2ee?: boolean;
  /** E-2: display name of the other user — shown inside SafetyNumberScreen. */
  peerName?: string;
  /** E-2: peer's Ed25519 identity public key (base64) from /api/users/:id/devices. */
  peerIdentityPubB64?: string;
}

export function ThreadSafetySheet({
  visible,
  onClose,
  threadType,
  otherUserId,
  otherUserName,
  isMuted,
  onToggleMute,
  hideAiSuggestions,
  onToggleHideAi,
  onBlock,
  onLeave,
  onDeleteForMe,
  onReport,
  isE2ee,
  peerName,
  peerIdentityPubB64,
}: Props) {
  const [mutingBusy, setMutingBusy] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);

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

  // SafetyNumberScreen is a full-screen modal layered on top of this sheet.
  if (showSafetyNumber && peerIdentityPubB64) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={() => setShowSafetyNumber(false)}>
        <SafetyNumberScreen
          peerName={peerName ?? 'Contact'}
          peerIdentityPubB64={peerIdentityPubB64}
          onDismiss={() => setShowSafetyNumber(false)}
        />
      </Modal>
    );
  }

  // For DM threads with a known user: report via unified ReportSheet
  const canUseReportSheet = threadType === 'direct' && !!otherUserId;

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <Pressable style={sh.overlay} onPress={onClose} />
        <View style={sh.sheet}>
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

          {/* Verify safety number — E2EE 1:1 DM only */}
          {isE2ee && threadType === 'direct' && peerIdentityPubB64 && (
            <Pressable style={sh.row} onPress={() => setShowSafetyNumber(true)}>
              <ShieldCheck size={18} color="#2A7A4B" />
              <View style={sh.rowTextBlock}>
                <Text style={[sh.rowLabel, { color: '#2A7A4B' }]}>Verify safety number</Text>
                <Text style={sh.rowSub}>Confirm this conversation is end-to-end encrypted</Text>
              </View>
            </Pressable>
          )}

          <View style={sh.divider} />

          {/* Report */}
          <Pressable style={sh.row} onPress={() => {
            if (canUseReportSheet) {
              setShowReport(true);
            } else if (onReport) {
              // Group thread fallback — keep existing behavior
              onClose();
              Alert.alert('Report conversation', 'Flag this conversation for review?', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Report', style: 'destructive',
                  onPress: () => onReport('Inappropriate conversation').catch(() => {}),
                },
              ]);
            }
          }}>
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
        </View>
      </Modal>

      {/* Unified ReportSheet — DM threads: report the other user */}
      {canUseReportSheet && (
        <ReportSheet
          visible={showReport}
          onClose={() => { setShowReport(false); onClose(); }}
          subjectType="user"
          subjectId={otherUserId!}
          subjectUserId={otherUserId!}
          subjectName={otherUserName ?? peerName}
          onReported={() => { setShowReport(false); onClose(); }}
        />
      )}
    </>
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
  rowTextBlock: { flex: 1 },
  rowLabel: { ...t.body, color: color.ink },
  rowSub: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  destructive: { color: '#EF4444' },
});
