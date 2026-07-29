/**
 * CreateHubSheet — centralized creation hub bottom sheet.
 *
 * Three sections:
 *   Share   — Post, Story, Memory, Add a Gem
 *   Plan    — Event, Trip, Plan
 *   Contribute — Add Place, Review Place, Recommend Hidden Gem
 *
 * Routes that don't have a live destination show a "Soon" badge and are
 * rendered disabled so they never crash. Every live action navigates to
 * its existing route after closing the sheet.
 */
import React from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PenLine,
  Camera,
  BookImage,
  CalendarDays,
  MapPin,
  Compass,
  Gem,
  Plus,
  Star,
  X,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { closeThenNavigate } from '../../lib/deferredNavigate.ts';

// ── Entry definitions ──────────────────────────────────────────────────────────

interface HubEntry {
  id: string;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  iconColor: string;
  /** Navigate to this route on tap. Omit or leave undefined for "coming soon". */
  route?: string;
}

const SHARE_ENTRIES: HubEntry[] = [
  {
    id: 'post',
    label: 'Post',
    sublabel: 'Share a text update, photo or moment',
    icon: PenLine,
    iconColor: color.signal,
    route: '/create',
  },
  {
    id: 'story',
    label: 'Story',
    sublabel: 'Disappearing photo or short video',
    icon: Camera,
    iconColor: color.warn,
    // No live route yet — shows "Soon" badge
  },
  {
    id: 'memory',
    label: 'Memory',
    sublabel: 'A photo gallery from your trip',
    icon: BookImage,
    iconColor: '#8B5CF6',
    route: '/memory/edit',
  },
  {
    id: 'gem',
    label: 'Add a Gem',
    sublabel: 'Share a hidden gem with the community',
    icon: Gem,
    iconColor: '#10B981',
    route: '/gems/submit',
  },
];

const PLAN_ENTRIES: HubEntry[] = [
  {
    id: 'event',
    label: 'Event',
    sublabel: 'Invite travelers to meet up',
    icon: CalendarDays,
    iconColor: '#0891B2',
    route: '/events/create',
  },
  {
    id: 'trip',
    label: 'Trip',
    sublabel: 'Plan or share a journey',
    icon: MapPin,
    iconColor: '#059669',
    route: '/trip/new',
  },
  {
    id: 'plan',
    label: 'Plan',
    sublabel: 'Build a day-by-day itinerary',
    icon: Compass,
    iconColor: '#7C3AED',
    // No live route yet — shows "Soon" badge
  },
];

const CONTRIBUTE_ENTRIES: HubEntry[] = [
  {
    id: 'add_place',
    label: 'Add Place',
    sublabel: 'Put a new spot on the map',
    icon: Plus,
    iconColor: '#D97706',
    // No live route yet — shows "Soon" badge
  },
  {
    id: 'review_place',
    label: 'Review Place',
    sublabel: "Rate and review somewhere you've been",
    icon: Star,
    iconColor: '#F59E0B',
    // No live route yet — shows "Soon" badge
  },
  {
    id: 'hidden_gem',
    label: 'Recommend Hidden Gem',
    sublabel: 'Nominate a hidden spot others should know',
    icon: Gem,
    iconColor: '#10B981',
    route: '/gems/submit',
  },
];

// ── Props ──────────────────────────────────────────────────────────────────────

export interface CreateHubSheetProps {
  visible: boolean;
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function CreateHubSheet({ visible, onClose }: CreateHubSheetProps) {
  const insets = useSafeAreaInsets();

  function handleEntry(entry: HubEntry) {
    if (!entry.route) return; // coming soon — row is not tappable
    closeThenNavigate(onClose, entry.route);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
        {/* Grab bar */}
        <View style={styles.grab} />

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Create</Text>
          <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Share ── */}
          <Text style={styles.sectionLabel}>Share</Text>
          {SHARE_ENTRIES.map((entry) => (
            <EntryRow key={entry.id} entry={entry} onPress={() => handleEntry(entry)} />
          ))}

          {/* ── Plan ── */}
          <Text style={styles.sectionLabel}>Plan</Text>
          {PLAN_ENTRIES.map((entry) => (
            <EntryRow key={entry.id} entry={entry} onPress={() => handleEntry(entry)} />
          ))}

          {/* ── Contribute ── */}
          <Text style={styles.sectionLabel}>Contribute</Text>
          {CONTRIBUTE_ENTRIES.map((entry) => (
            <EntryRow key={entry.id} entry={entry} onPress={() => handleEntry(entry)} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── EntryRow ──────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: HubEntry;
  onPress: () => void;
}

function EntryRow({ entry, onPress }: EntryRowProps) {
  const IconComponent = entry.icon;
  const comingSoon = !entry.route;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        comingSoon && styles.rowDisabled,
        !comingSoon && pressed && styles.rowPressed,
      ]}
      onPress={comingSoon ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      accessibilityState={{ disabled: comingSoon }}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: `${entry.iconColor}18` },
          comingSoon && styles.iconWrapDisabled,
        ]}
      >
        <IconComponent size={20} color={entry.iconColor} strokeWidth={1.8} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowLabelRow}>
          <Text style={[styles.rowLabel, comingSoon && styles.rowLabelMuted]}>
            {entry.label}
          </Text>
          {comingSoon && (
            <View style={styles.soonBadge}>
              <Text style={styles.soonText}>Soon</Text>
            </View>
          )}
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>{entry.sublabel}</Text>
      </View>
    </Pressable>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '82%',
    ...shadow.float,
  },
  grab: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginTop: 10,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: 2,
  },
  sectionLabel: {
    ...t.stamp,
    color: color.mute,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 4,
    paddingHorizontal: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  rowDisabled: {
    opacity: 0.55,
  },
  rowPressed: {
    backgroundColor: color.haze,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapDisabled: {
    opacity: 0.7,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  rowLabelMuted: {
    color: color.mute,
  },
  rowSub: {
    ...t.small,
    color: color.mute,
  },
  soonBadge: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  soonText: {
    fontSize: 9,
    fontWeight: '700',
    color: color.mute,
    letterSpacing: 0.3,
  },
});
