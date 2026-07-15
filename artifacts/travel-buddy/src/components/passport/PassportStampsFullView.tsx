/**
 * PassportStampsFullView — full-screen passport visa-page stamp collection modal.
 * Wraps the existing StampsTab inside a passport-paper styled modal.
 */
import React from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, SafeAreaView,
} from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { StampsTab } from '../StampsTab';
import { PassportSecurityPattern } from './PassportSecurityPattern';
import { PP, PP_LABEL } from '../../theme/passportTokens';
import type { PassportStamp } from '../../types/models';

interface Props {
  visible: boolean;
  onClose: () => void;
  stamps: PassportStamp[];
  isOwner?: boolean;
  totalCount?: number;
  viewingUsername?: string;
  viewingUserId?: string;
}

export function PassportStampsFullView({
  visible, onClose, stamps, isOwner, totalCount, viewingUsername, viewingUserId,
}: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={s.root}>
        {/* Subtle texture background */}
        <PassportSecurityPattern opacity={0.4} />

        {/* Header */}
        <View style={s.header}>
          <Pressable style={s.backBtn} onPress={onClose} hitSlop={12} accessibilityLabel="Close stamps">
            <ArrowLeft size={20} color={PP.ink} />
            <Text style={s.backText}>Back</Text>
          </Pressable>
          <View style={s.titleBlock}>
            <Text style={s.title}>MY PASSPORT STAMPS</Text>
            {totalCount != null && totalCount > 0 ? (
              <Text style={s.count}>{totalCount} collected</Text>
            ) : null}
          </View>
          <View style={{ width: 60 }} />
        </View>

        {/* Top rule */}
        <View style={s.topRule} />

        {/* Stamp grid — existing StampsTab handles its own fetching + category filter */}
        <View style={s.content}>
          <StampsTab
            stamps={stamps}
            isOwner={isOwner}
            viewingUsername={viewingUsername}
            viewingUserId={viewingUserId}
          />
        </View>

        {/* Bottom collectible tagline */}
        <View style={s.footer}>
          <View style={s.footerRule} />
          <Text style={s.footerText}>✦  COLLECT MORE STAMPS ON YOUR TRAVELS  ✦</Text>
          <View style={s.footerRule} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PP.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 60,
  },
  backText: { ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 1 },
  titleBlock: { alignItems: 'center', gap: 2 },
  title: { ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 2.5 },
  count: {
    fontFamily: 'Courier', fontSize: 9,
    color: PP.inkMuted, letterSpacing: 0.8,
  },
  topRule: { height: 2, backgroundColor: PP.ink, marginHorizontal: 16 },
  content: { flex: 1 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  footerRule: { flex: 1, height: 1, backgroundColor: PP.borderLight },
  footerText: {
    ...PP_LABEL, fontSize: 7.5, color: PP.inkMuted,
    letterSpacing: 1.5, textAlign: 'center',
  },
});
