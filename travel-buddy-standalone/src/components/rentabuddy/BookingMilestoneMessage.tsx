/**
 * BookingMilestoneMessage
 *
 * Rendered in place of TelegraphSystemNotice for system messages with
 * subtype starting with 'rent_buddy_'. Shows a centred milestone banner
 * with icon and label.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  CheckCircle, Clock, DollarSign, Navigation, MapPin,
  Star, AlertCircle, UserCheck, PlusCircle,
} from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../../features/telegraph/theme/telegraphTheme.ts';

type MilestoneSubtype =
  | 'rent_buddy_confirmed'
  | 'rent_buddy_accepted'
  | 'rent_buddy_deposit_paid'
  | 'rent_buddy_started'
  | 'rent_buddy_route_approved'
  | 'rent_buddy_extra_time'
  | 'rent_buddy_completed'
  | 'rent_buddy_review_requested'
  | 'rent_buddy_cancelled'
  | 'rent_buddy_disputed';

interface MilestoneConfig {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  /** A fixed hue, or OPERATIONAL: the scheme's teal (census T123 — teal-ink is unreadable on the dark surface). */
  accent: string;
}

const OPERATIONAL = 'operational';

const MILESTONE_MAP: Record<string, MilestoneConfig> = {
  rent_buddy_confirmed: {
    label: 'Booking confirmed',
    icon: CheckCircle,
    accent: '#3B82F6',
  },
  rent_buddy_accepted: {
    label: 'Buddy accepted',
    icon: UserCheck,
    accent: '#8B5CF6',
  },
  rent_buddy_deposit_paid: {
    label: 'Deposit paid',
    icon: DollarSign,
    accent: '#10B981',
  },
  rent_buddy_started: {
    label: 'Meetup started',
    icon: MapPin,
    accent: '#8B5CF6',
  },
  rent_buddy_route_approved: {
    label: 'Route approved',
    icon: Navigation,
    accent: OPERATIONAL,
  },
  rent_buddy_extra_time: {
    label: 'Extra time added',
    icon: PlusCircle,
    accent: color.warn,
  },
  rent_buddy_completed: {
    label: 'Booking completed',
    icon: CheckCircle,
    accent: '#10B981',
  },
  rent_buddy_review_requested: {
    label: 'Leave a review',
    icon: Star,
    accent: color.warn,
  },
  rent_buddy_cancelled: {
    label: 'Booking cancelled',
    icon: AlertCircle,
    accent: '#EF4444',
  },
  rent_buddy_disputed: {
    label: 'Booking disputed',
    icon: AlertCircle,
    accent: '#EF4444',
  },
};

interface Props {
  subtype: string;
  body?: string;
}

export function BookingMilestoneMessage({ subtype, body }: Props) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const config = MILESTONE_MAP[subtype];
  if (!config) {
    return (
      <View style={styles.wrap}>
        <View style={styles.pill}>
          <Clock size={11} color={palette.mute} />
          <Text style={styles.text}>{body ?? subtype.replace(/_/g, ' ')}</Text>
        </View>
      </View>
    );
  }

  const Icon = config.icon;
  const label = body || config.label;
  const accent = config.accent === OPERATIONAL ? palette.operational : config.accent;

  return (
    <View style={styles.wrap}>
      <View style={[styles.milestone, { borderColor: accent + '44' }]}>
        <View style={[styles.iconWrap, { backgroundColor: accent + '20' }]}>
          <Icon size={14} color={accent} />
        </View>
        <Text style={[styles.milestoneText, { color: accent }]}>{label}</Text>
      </View>
    </View>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: p.surfaceRaised,
    borderWidth: 1,
    borderColor: p.recvBorder,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  text: {
    ...t.small,
    color: p.mute,
  },
  milestone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: p.surfaceRaised,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  iconWrap: {
    width: icon.s22, height: icon.s22,
    borderRadius: icon.s22 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  milestoneText: {
    ...t.small,
    fontWeight: '700',
  },
});
