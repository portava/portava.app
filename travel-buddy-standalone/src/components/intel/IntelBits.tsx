/**
 * Small shared pieces for the Intelligence Gathering capture surfaces:
 *  - SuppressedNotice     — why prompts are hidden (disabled / emergency / paused)
 *  - PrivateLocationBadge — "location + time, prefilled and privately verified"
 *  - SentToast            — the one-tap success confirmation
 *
 * PrivateLocationBadge never renders coordinates. The traveler's location is
 * used to attach the report to a place and is kept private (visibility defaults
 * to `private`); the badge only affirms that verification happened.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ShieldCheck, ShieldAlert, Clock, Lock, CirclePause, Check } from 'lucide-react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import type { SuppressReason } from '../../hooks/useIntelPrompts.ts';

export function SuppressedNotice({ reason }: { reason: Exclude<SuppressReason, null> }) {
  const map = {
    disabled: {
      Icon: Lock,
      tint: color.faint,
      title: 'Signals aren’t collecting here yet',
      body: 'This feature is turned off. Nothing is being captured.',
    },
    safe_return: {
      Icon: ShieldAlert,
      tint: color.signal,
      title: 'Paused during Safe Return',
      body: 'While a Safe Return check-in is active we won’t ask you to share anything. Your safety comes first.',
    },
    paused: {
      Icon: CirclePause,
      tint: color.warn,
      title: 'Prompts are paused',
      body: 'You’ve paused capture prompts. You can resume them in Settings → Live intel prompts.',
    },
    throttled: {
      Icon: Clock,
      tint: color.mute,
      title: 'Just a moment',
      body: 'You were asked about this place recently — we won’t prompt again for a little while.',
    },
  }[reason];
  const { Icon, tint, title, body } = map;
  return (
    <View style={[styles.notice, { borderColor: tint + '55' }]}>
      <Icon size={20} color={tint} />
      <View style={{ flex: 1 }}>
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeBody}>{body}</Text>
      </View>
    </View>
  );
}

export function PrivateLocationBadge({
  placeName,
  verified,
  timeLabel,
}: {
  placeName?: string | null;
  verified: boolean;
  timeLabel: string;
}) {
  return (
    <View style={styles.badge}>
      <View style={styles.badgeIcon}>
        {verified ? <ShieldCheck size={16} color={color.success} /> : <ShieldAlert size={16} color={color.warn} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.badgeTitle} numberOfLines={1}>
          {placeName ? placeName : 'Here'}
        </Text>
        <View style={styles.badgeMetaRow}>
          <Lock size={11} color={color.mute} />
          <Text style={styles.badgeMeta}>
            {verified ? 'Location verified privately' : 'Location not verified'} · {timeLabel}
          </Text>
        </View>
      </View>
      <Clock size={14} color={color.faint} />
    </View>
  );
}

export function SentToast({ label = 'Signal sent' }: { label?: string }) {
  return (
    <View style={styles.toast}>
      <Check size={16} color={color.onInk} />
      <Text style={styles.toastText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: color.paperRaised,
  },
  noticeTitle: { ...typography.cardTitle, color: color.ink },
  noticeBody: { ...typography.caption, color: color.mute, marginTop: 3, lineHeight: 19 },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  badgeIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  badgeTitle: { ...typography.cardTitle, color: color.ink },
  badgeMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  badgeMeta: { ...typography.metadata, color: color.mute },

  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 12,
  },
  toastText: { ...typography.button, color: color.onInk },
});
