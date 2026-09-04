/**
 * ExplorePortavaScreen
 *
 * App-wide directory screen — a categorised index of every major system.
 * Accessible from the Passport owner menu and Settings.
 *
 * Sections: Social · Discover · Travel · Create · Passport · Services · Account
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, SectionList, Pressable, StyleSheet, Alert,
} from 'react-native';
import { router } from 'expo-router';
import {
  // Social
  Zap, Image as ImageIcon, Film, BookOpen, MessageSquare, Phone, UserPlus, Users, UserCheck,
  // Discover
  Compass, Search, Map, MapPin, Gem, Calendar, Globe, Home,
  // Travel
  Briefcase, Navigation, CalendarDays, Bookmark, CreditCard,
  MailOpen, TicketCheck, FileText,
  // Create
  PenLine, Star, Plus, Route,
  // Passport
  User, Camera, FileImage, AlignLeft, Stamp, LayoutGrid,
  Eye, Shield, ShieldCheck,
  // Services
  Handshake, ClipboardList, DollarSign, MessageCircle, AlertTriangle, LifeBuoy, Siren,
  // Account
  Settings, Lock, Bell, Languages, Accessibility, Database,
  UserX, VolumeX, KeyRound, Smartphone, HelpCircle, Flag, LogOut,
  // Shared
  ChevronRight,
} from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { CreateHubSheet } from '../src/components/create/CreateHubSheet';
import { useSession } from '../src/context/SessionContext';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useBottomInset } from '../src/hooks/useBottomInset';

// ─── Types ─────────────────────────────────────────────────────────────────────

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

interface DirectoryItem {
  key: string;
  label: string;
  Icon: IconComponent;
  iconColor: string;
  /** Navigation route to push — omit for action items or disabled rows. */
  route?: string;
  /** For items that trigger an action instead of navigation. */
  action?: 'create-hub' | 'sign-out';
  /** True → muted row, no press, "Coming soon" badge. */
  disabled?: boolean;
}

interface DirectorySection {
  title: string;
  data: DirectoryItem[];
}

// ─── Section data ──────────────────────────────────────────────────────────────

export const SECTIONS: DirectorySection[] = [
  {
    title: 'Social',
    data: [
      { key: 'pulse',      label: 'Pulse',      Icon: Zap,           iconColor: '#FF4D2E', route: '/(tabs)/' },
      { key: 'media',      label: 'Media',       Icon: ImageIcon,     iconColor: '#7B5CE5', route: '/(tabs)/media' },
      { key: 'stories',    label: 'Stories',     Icon: Film,          iconColor: '#DB2777', disabled: true },
      { key: 'memories',   label: 'Memories',    Icon: BookOpen,      iconColor: '#27AE71', route: '/(tabs)/passport' },
      { key: 'telegraph',  label: 'Telegraph',   Icon: MessageSquare, iconColor: '#2563EB', route: '/(tabs)/messages' },
      { key: 'calls',      label: 'Calls',       Icon: Phone,         iconColor: '#059669', route: '/profile/edit/calling' },
      { key: 'following',  label: 'Following',   Icon: UserPlus,      iconColor: '#D97706', route: '/following' },
      { key: 'followers',  label: 'Followers',   Icon: Users,         iconColor: '#4F46E5', route: '/followers' },
      { key: 'requests',   label: 'Requests',    Icon: UserCheck,     iconColor: '#0891B2', route: '/follow-requests' },
    ],
  },
  {
    title: 'Discover',
    data: [
      { key: 'discovery',      label: 'Discovery',      Icon: Compass,  iconColor: '#FF4D2E', route: '/(tabs)/discovery' },
      { key: 'search',         label: 'Search',          Icon: Search,   iconColor: '#11110F', route: '/search' },
      { key: 'compass',        label: 'Compass',         Icon: Compass,  iconColor: '#3B7DED', route: '/compass-preferences' },
      { key: 'map',            label: 'Map',             Icon: Map,      iconColor: '#2563EB', route: '/map?entry=unknown' },
      { key: 'places',         label: 'Places',          Icon: MapPin,   iconColor: '#059669', disabled: true },
      { key: 'hidden-gems',    label: 'Hidden Gems',     Icon: Gem,      iconColor: '#D97706', route: '/gems' },
      { key: 'events',         label: 'Events',          Icon: Calendar, iconColor: '#7C3AED', route: '/(tabs)/events' },
      { key: 'travelers',      label: 'Travelers',       Icon: Globe,    iconColor: '#0891B2', route: '/discover' },
      { key: 'neighborhoods',  label: 'Neighborhoods',   Icon: Home,     iconColor: '#27AE71', route: '/map?entry=unknown' },
      { key: 'nearby',         label: 'Nearby',          Icon: Navigation, iconColor: '#DB2777', disabled: true },
    ],
  },
  {
    title: 'Travel',
    data: [
      { key: 'trips',            label: 'Trips',                     Icon: Briefcase,    iconColor: '#7C3AED', route: '/(tabs)/trips' },
      { key: 'active-trip',      label: 'Active Trip',               Icon: Navigation,   iconColor: '#FF4D2E', disabled: true },
      { key: 'trip-calendar',    label: 'Trip Calendar',             Icon: CalendarDays, iconColor: '#2563EB', disabled: true },
      { key: 'trip-map',         label: 'Trip Map',                  Icon: Map,          iconColor: '#059669', disabled: true },
      { key: 'saved-places',     label: 'Saved Places',              Icon: Bookmark,     iconColor: '#D4A017', route: '/saved' },
      { key: 'boarding-passes',  label: 'Boarding Passes',           Icon: CreditCard,   iconColor: '#4F46E5', disabled: true },
      { key: 'trip-invitations', label: 'Trip Invitations',          Icon: MailOpen,     iconColor: '#0891B2', disabled: true },
      { key: 'trip-requests',    label: 'Trip Requests',             Icon: TicketCheck,  iconColor: '#DB2777', disabled: true },
      { key: 'visa-passport',    label: 'Visa and Passport Tools',   Icon: FileText,     iconColor: '#059669', route: '/profile/edit/passports' },
    ],
  },
  {
    title: 'Create',
    data: [
      { key: 'create-post',    label: 'Post',        Icon: PenLine,   iconColor: '#3B7DED', action: 'create-hub' },
      { key: 'create-story',   label: 'Story',       Icon: Film,      iconColor: '#DB2777', action: 'create-hub' },
      { key: 'create-memory',  label: 'Memory',      Icon: BookOpen,  iconColor: '#27AE71', action: 'create-hub' },
      { key: 'create-event',   label: 'Event',       Icon: Calendar,  iconColor: '#7C3AED', action: 'create-hub' },
      { key: 'create-trip',    label: 'Trip',        Icon: Briefcase, iconColor: '#4F46E5', action: 'create-hub' },
      { key: 'create-plan',    label: 'Plan',        Icon: Route,     iconColor: '#0891B2', disabled: true },
      { key: 'add-gem',        label: 'Add a Gem',   Icon: Gem,       iconColor: '#D97706', action: 'create-hub' },
      { key: 'add-place',      label: 'Add Place',   Icon: Plus,      iconColor: '#059669', disabled: true },
      { key: 'review',         label: 'Review',      Icon: Star,      iconColor: '#F59E0B', disabled: true },
    ],
  },
  {
    title: 'Passport',
    data: [
      { key: 'pp-view',        label: 'View Passport',     Icon: Eye,          iconColor: '#3B7DED', route: '/(tabs)/passport' },
      { key: 'pp-edit',        label: 'Edit Profile',      Icon: PenLine,      iconColor: '#059669', route: '/profile/edit' },
      { key: 'pp-photo',       label: 'Profile Photo',     Icon: Camera,       iconColor: '#1A9CB0', route: '/profile/edit/photos' },
      { key: 'pp-cover',       label: 'Cover',             Icon: FileImage,    iconColor: '#7B5CE5', route: '/profile/edit/photos' },
      { key: 'pp-bio',         label: 'Bio',               Icon: AlignLeft,    iconColor: '#27AE71', route: '/profile/edit/about' },
      { key: 'pp-stamps',      label: 'Stamps',            Icon: Stamp,        iconColor: '#D97706', route: '/(tabs)/passport' },
      { key: 'pp-highlights',  label: 'Highlights',        Icon: Star,         iconColor: '#F59E0B', route: '/(tabs)/passport' },
      { key: 'pp-posts',       label: 'Posts',             Icon: LayoutGrid,   iconColor: '#4F46E5', route: '/(tabs)/passport' },
      { key: 'pp-memories-tab',label: 'Memories',          Icon: BookOpen,     iconColor: '#27AE71', route: '/(tabs)/passport' },
      { key: 'pp-plans',       label: 'Plans',             Icon: CalendarDays, iconColor: '#0891B2', route: '/(tabs)/passport' },
      { key: 'pp-trips-tab',   label: 'Trips',             Icon: Briefcase,    iconColor: '#7C3AED', route: '/(tabs)/passport' },
      { key: 'pp-followers',   label: 'Followers',         Icon: Users,        iconColor: '#DB2777', route: '/followers' },
      { key: 'pp-following',   label: 'Following',         Icon: UserPlus,     iconColor: '#059669', route: '/following' },
      { key: 'pp-verification',label: 'Verification',      Icon: ShieldCheck,  iconColor: '#2563EB', route: '/profile/verification' },
      { key: 'pp-trust',       label: 'Trust and Safety',  Icon: Shield,       iconColor: '#D94040', route: '/profile/edit/safety' },
    ],
  },
  {
    title: 'Services',
    data: [
      { key: 'rent-buddy',      label: 'Rent a Buddy',      Icon: Handshake,     iconColor: '#7C3AED', route: '/(rent-a-buddy)' },
      { key: 'buddy-requests',  label: 'Buddy Requests',    Icon: ClipboardList, iconColor: '#2563EB', disabled: true },
      { key: 'buddy-bookings',  label: 'Buddy Bookings',    Icon: CalendarDays,  iconColor: '#059669', disabled: true },
      { key: 'payments',        label: 'Payments',          Icon: DollarSign,    iconColor: '#D4A017', disabled: true },
      { key: 'reviews',         label: 'Reviews',           Icon: Star,          iconColor: '#F59E0B', disabled: true },
      { key: 'safety',          label: 'Safety',            Icon: Shield,        iconColor: '#D94040', route: '/profile/edit/safety' },
      { key: 'safe-return',     label: 'Safe Return',       Icon: LifeBuoy,      iconColor: '#0891B2', disabled: true },
      { key: 'emergency-tools', label: 'Emergency Tools',   Icon: Siren,         iconColor: '#FF4D2E', route: '/profile/edit/emergency-contacts' },
    ],
  },
  {
    title: 'Account',
    data: [
      { key: 'acc-settings',    label: 'Settings',           Icon: Settings,     iconColor: '#4A4A48', route: '/profile/edit' },
      { key: 'acc-privacy',     label: 'Privacy',            Icon: Lock,         iconColor: '#3B7DED', route: '/profile/edit/privacy' },
      { key: 'acc-notifs',      label: 'Notifications',      Icon: Bell,         iconColor: '#D97706', route: '/profile/edit/notifications' },
      { key: 'acc-language',    label: 'Language',           Icon: Languages,    iconColor: '#27AE71', disabled: true },
      { key: 'acc-translation', label: 'Translation',        Icon: Globe,        iconColor: '#059669', disabled: true },
      { key: 'acc-a11y',        label: 'Accessibility',      Icon: Accessibility, iconColor: '#7C3AED', disabled: true },
      { key: 'acc-data',        label: 'Data and Storage',   Icon: Database,     iconColor: '#4F46E5', disabled: true },
      { key: 'acc-blocked',     label: 'Blocked Accounts',   Icon: UserX,        iconColor: '#D94040', route: '/blocked-users' },
      { key: 'acc-muted',       label: 'Muted Accounts',     Icon: VolumeX,      iconColor: '#6B6862', route: '/muted-users' },
      { key: 'acc-security',    label: 'Security',           Icon: KeyRound,     iconColor: '#2563EB', disabled: true },
      { key: 'acc-devices',     label: 'Devices',            Icon: Smartphone,   iconColor: '#0891B2', disabled: true },
      { key: 'acc-help',        label: 'Help',               Icon: HelpCircle,   iconColor: '#27AE71', disabled: true },
      { key: 'acc-report',      label: 'Report a Problem',   Icon: Flag,         iconColor: '#D97706', route: '/profile/edit/reports' },
      { key: 'acc-sign-out',    label: 'Sign Out',           Icon: LogOut,       iconColor: '#D94040', action: 'sign-out' },
    ],
  },
];

// ─── DirectoryRow ──────────────────────────────────────────────────────────────

function DirectoryRow({
  item,
  onPress,
}: {
  item: DirectoryItem;
  onPress: () => void;
}) {
  const { Icon, label, iconColor, disabled } = item;
  return (
    <Pressable
      style={({ pressed }) => [
        dr.row,
        disabled && dr.rowDisabled,
        pressed && !disabled && dr.rowPressed,
      ]}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      <View style={[dr.iconWrap, { opacity: disabled ? 0.35 : 1 }]}>
        <Icon size={19} color={iconColor} strokeWidth={1.8} />
      </View>
      <Text style={[dr.label, disabled && dr.labelMuted]} numberOfLines={1}>
        {label}
      </Text>
      {disabled ? (
        <View style={dr.soonBadge}>
          <Text style={dr.soonText}>SOON</Text>
        </View>
      ) : (
        <ChevronRight size={16} color={color.faint} strokeWidth={1.5} />
      )}
    </Pressable>
  );
}

const dr = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    backgroundColor: color.paperRaised,
  },
  rowDisabled: {
    opacity: 0.55,
  },
  rowPressed: {
    backgroundColor: color.haze,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    ...t.body,
    color: color.ink,
    fontWeight: '500',
  },
  labelMuted: {
    color: color.mute,
  },
  soonBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: color.haze,
    borderRadius: radius.pill,
  },
  soonText: {
    fontSize: 9,
    fontWeight: '700',
    color: color.faint,
    letterSpacing: 0.6,
  },
});

// ─── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={sh.wrap}>
      <Text style={sh.label}>{title.toUpperCase()}</Text>
    </View>
  );
}

const sh = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xs,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: color.faint,
  },
});

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function ExplorePortavaScreen() {
  const { signOut } = useSession();
  const bottomInset = useBottomInset();
  const [createHubOpen, setCreateHubOpen] = useState(false);

  const handleItemPress = useCallback((item: DirectoryItem) => {
    if (item.disabled) return;

    if (item.action === 'create-hub') {
      setCreateHubOpen(true);
      return;
    }

    if (item.action === 'sign-out') {
      Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await signOut();
          },
        },
      ]);
      return;
    }

    if (item.route) {
      router.push(item.route as any);
    }
  }, [signOut]);

  return (
    <View style={s.root}>
      <AppHeader
        variant="detail"
        title="Explore Portava"
        onBack={() => router.back()}
      />

      <SectionList
        sections={SECTIONS}
        keyExtractor={(item) => item.key}
        renderSectionHeader={({ section }) => (
          <SectionHeader title={section.title} />
        )}
        renderItem={({ item, index, section }) => {
          const isLast = index === section.data.length - 1;
          return (
            <View>
              <DirectoryRow
                item={item}
                onPress={() => handleItemPress(item)}
              />
              {!isLast && <View style={s.divider} />}
            </View>
          );
        }}
        SectionSeparatorComponent={() => null}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: bottomInset + space.xl }}
        showsVerticalScrollIndicator={false}
      />

      <CreateHubSheet
        visible={createHubOpen}
        onClose={() => setCreateHubOpen(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.haze,
    marginLeft: space.lg + 34 + space.md, // align with label start
  },
});
