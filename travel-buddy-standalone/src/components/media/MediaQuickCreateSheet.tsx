/**
 * MediaQuickCreateSheet — bottom sheet accessible from the Media page's create button.
 *
 * Shows all standard content-creation options plus "Add a Gem" when:
 *   - The viewer is in Gems mode, OR showGemEntry is explicitly passed as true
 *   - The MEDIA_HIDDEN_GEMS_CREATE_ENABLED feature flag is on
 *
 * Tapping a standard option routes to /create (which opens the UnifiedPostComposer).
 * Tapping "Add a Gem" routes to /media/add-gem.
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
import { router } from 'expo-router';
import {
  PenLine,
  Camera,
  BookImage,
  CalendarDays,
  MapPin,
  Compass,
  Users,
  Gem,
  X,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, avatar } from '../../theme/tokens.ts';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';

// ── Entry definitions ──────────────────────────────────────────────────────────

interface QuickEntry {
  id: string;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  iconColor: string;
  /** When set, navigate to this route. When null, close sheet and push /create. */
  route?: string;
}

const STANDARD_ENTRIES: QuickEntry[] = [
  {
    id: 'post',
    label: 'Post',
    sublabel: 'Share a text update, photo or moment',
    icon: PenLine,
    iconColor: color.signal,
  },
  {
    id: 'story',
    label: 'Story',
    sublabel: 'Disappearing photo or short video',
    icon: Camera,
    iconColor: color.warn,
  },
  {
    id: 'memory',
    label: 'Memory',
    sublabel: 'A photo gallery from your trip',
    icon: BookImage,
    iconColor: '#8B5CF6',
  },
  {
    id: 'event',
    label: 'Event',
    sublabel: 'Invite travelers to meet up',
    icon: CalendarDays,
    iconColor: '#0891B2',
  },
  {
    id: 'trip',
    label: 'Trip',
    sublabel: 'Plan or share a journey',
    icon: MapPin,
    iconColor: '#059669',
  },
  {
    id: 'plan',
    label: 'Plan',
    sublabel: 'Build an itinerary',
    icon: Compass,
    iconColor: '#7C3AED',
  },
  {
    id: 'group',
    label: 'Group activity',
    sublabel: 'Organise a group experience',
    icon: Users,
    iconColor: '#D97706',
  },
];

const GEM_ENTRY: QuickEntry = {
  id: 'add_gem',
  label: 'Add a Gem',
  sublabel: 'Share a hidden gem — photo + verified place',
  icon: Gem,
  iconColor: '#10B981',
  route: '/media/add-gem',
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface MediaQuickCreateSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Show the Add a Gem entry unconditionally (in addition to flag check). */
  showGemEntry?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function MediaQuickCreateSheet({
  visible,
  onClose,
  showGemEntry = false,
}: MediaQuickCreateSheetProps) {
  const insets = useSafeAreaInsets();
  const { isEnabled } = useFeatureFlags();

  const gemEnabled = isEnabled('MEDIA_HIDDEN_GEMS_CREATE_ENABLED');
  const showGem = showGemEntry && gemEnabled;

  function handleStandardEntry() {
    onClose();
    // Small delay so the modal animation plays cleanly before navigating.
    setTimeout(() => router.push('/create'), 80);
  }

  function handleEntry(entry: QuickEntry) {
    onClose();
    const target = entry.route ?? '/create';
    setTimeout(() => router.push(target as any), 80);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
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
          {/* Add a Gem — shown first when active (priority placement) */}
          {showGem && (
            <EntryRow
              entry={GEM_ENTRY}
              onPress={() => handleEntry(GEM_ENTRY)}
              highlight
            />
          )}

          {/* Standard content types */}
          {STANDARD_ENTRIES.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onPress={handleStandardEntry}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── EntryRow ──────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: QuickEntry;
  onPress: () => void;
  highlight?: boolean;
}

function EntryRow({ entry, onPress, highlight }: EntryRowProps) {
  const IconComponent = entry.icon;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        highlight && styles.rowHighlight,
        pressed && styles.rowPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
    >
      <View style={[styles.iconWrap, { backgroundColor: `${entry.iconColor}18` }]}>
        <IconComponent size={20} color={entry.iconColor} strokeWidth={1.8} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, highlight && styles.rowLabelHighlight]}>
          {entry.label}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {entry.sublabel}
        </Text>
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
    maxHeight: '75%',
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
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  rowHighlight: {
    backgroundColor: '#10B98108',
    borderWidth: 1,
    borderColor: '#10B98130',
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
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  rowLabelHighlight: {
    color: '#065F46',
  },
  rowSub: {
    ...t.small,
    color: color.mute,
  },
});
