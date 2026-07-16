import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { MoreVertical } from 'lucide-react-native';
import { useBlockUser } from '../../hooks/useBlockUser.ts';
import { useMuteUser } from '../../hooks/useMuteUser.ts';
import { useRestrictUser } from '../../hooks/useRestrictUser.ts';
import { useReportUser } from '../../hooks/useReportUser.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { BlockUserConfirmSheet } from './BlockUserConfirmSheet.tsx';
import { MuteUserSheet } from './MuteUserSheet.tsx';
import { RestrictUserSheet } from './RestrictUserSheet.tsx';
import { ReportUserSheet } from './ReportUserSheet.tsx';
import type { ReportReason } from '../../services/reports.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface UserOverflowMenuProps {
  userId: string;
  displayName: string;
  isMuted?: boolean;
  isRestricted?: boolean;
  onBlockSuccess?: (userId: string) => void;
  onMuteSuccess?: (userId: string, muted: boolean) => void;
  onRestrictSuccess?: (userId: string, restricted: boolean) => void;
  onReportSuccess?: (userId: string) => void;
  iconColor?: string;
  iconSize?: number;
}

export function UserOverflowMenu({
  userId,
  displayName,
  isMuted = false,
  isRestricted = false,
  onBlockSuccess,
  onMuteSuccess,
  onRestrictSuccess,
  onReportSuccess,
  iconColor,
  iconSize = 20,
}: UserOverflowMenuProps) {
  const { blockedIds } = useBlockedIds();
  const isAlreadyBlocked = blockedIds.has(userId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [restrictOpen, setRestrictOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const { doBlock, loading: blocking } = useBlockUser();
  const { doMute, doUnmute, loading: muting } = useMuteUser();
  const { doRestrict, doUnrestrict, loading: restricting } = useRestrictUser();
  const { doReport, loading: reporting } = useReportUser();

  async function handleBlock() {
    setBlockOpen(false);
    const ok = await doBlock(userId);
    if (ok) onBlockSuccess?.(userId);
  }

  async function handleMuteToggle() {
    setMuteOpen(false);
    const ok = isMuted ? await doUnmute(userId) : await doMute(userId);
    if (ok) onMuteSuccess?.(userId, !isMuted);
  }

  async function handleRestrictToggle() {
    setRestrictOpen(false);
    const ok = isRestricted ? await doUnrestrict(userId) : await doRestrict(userId);
    if (ok) onRestrictSuccess?.(userId, !isRestricted);
  }

  async function handleReport(reason: ReportReason, details?: string) {
    const ok = await doReport({ targetUserId: userId, reason, details });
    if (ok) { setReportOpen(false); onReportSuccess?.(userId); }
  }

  if (isAlreadyBlocked) return null;

  return (
    <>
      <Pressable
        onPress={() => setMenuOpen(true)}
        hitSlop={8}
        style={styles.trigger}
      >
        <MoreVertical size={iconSize} color={iconColor ?? color.mute} />
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.menu} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.menuTitle} numberOfLines={1}>{displayName}</Text>

            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); setMuteOpen(true); }}>
              <Text style={styles.menuItemText}>{isMuted ? '🔊 Unmute' : '🔇 Mute'}</Text>
            </Pressable>

            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); setRestrictOpen(true); }}>
              <Text style={styles.menuItemText}>{isRestricted ? '✅ Unrestrict' : '⚠️ Restrict'}</Text>
            </Pressable>

            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); setReportOpen(true); }}>
              <Text style={styles.menuItemText}>🚩 Report</Text>
            </Pressable>

            <View style={styles.separator} />

            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); setBlockOpen(true); }}>
              <Text style={[styles.menuItemText, styles.destructive]}>🚫 Block</Text>
            </Pressable>

            <Pressable style={[styles.menuItem, styles.cancelItem]} onPress={() => setMenuOpen(false)}>
              <Text style={styles.menuItemText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <BlockUserConfirmSheet
        visible={blockOpen}
        displayName={displayName}
        onConfirm={handleBlock}
        onCancel={() => setBlockOpen(false)}
        loading={blocking}
      />
      <MuteUserSheet
        visible={muteOpen}
        displayName={displayName}
        isMuted={isMuted}
        onConfirm={handleMuteToggle}
        onCancel={() => setMuteOpen(false)}
        loading={muting}
      />
      <RestrictUserSheet
        visible={restrictOpen}
        displayName={displayName}
        isRestricted={isRestricted}
        onConfirm={handleRestrictToggle}
        onCancel={() => setRestrictOpen(false)}
        loading={restricting}
      />
      <ReportUserSheet
        visible={reportOpen}
        displayName={displayName}
        onSubmit={handleReport}
        onCancel={() => setReportOpen(false)}
        loading={reporting}
      />
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    padding: 4,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  menu: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    gap: space.xs,
  },
  menuTitle: {
    ...t.heading,
    fontSize: 15,
    color: color.mute,
    textAlign: 'center',
    paddingBottom: space.sm,
  },
  menuItem: {
    padding: space.md,
    borderRadius: radius.md,
  },
  menuItemText: {
    fontSize: 15,
    color: color.ink,
  },
  destructive: {
    color: '#DC2626',
  },
  cancelItem: {
    backgroundColor: color.haze,
    alignItems: 'center',
    marginTop: space.sm,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.haze,
    marginVertical: space.xs,
  },
});
