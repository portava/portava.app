/**
 * PassportOwnerMenuSheet
 *
 * Scrollable bottom sheet with five labeled sections for the passport owner.
 * Replaces the old 4-column OwnerActionMenu grid.
 *
 * Sections:
 *   Profile · Travel Identity · Content · Connections · Account
 *
 * Items with live routes navigate on press.
 * Items without live routes are rendered with muted style + "Soon" badge.
 */
import React from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, Alert,
} from 'react-native';
import {
  PenLine, Camera, Image, FileText, Columns, Star, Eye,
  Stamp, MapPin, Home, Globe, Heart, Calendar,
  ShieldCheck, Shield, LayoutGrid, Film, BookOpen,
  Briefcase, Bookmark, Users, UserPlus, UserCheck, UserX,
  VolumeX, Settings, Lock, Bell, HelpCircle, LogOut,
  ChevronRight, X, MoreHorizontal, Edit2, Compass, PlusCircle,
  BarChart2,
} from 'lucide-react-native';
import { closeThenNavigate } from '../../lib/deferredNavigate.ts';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { space, radius, avatar } from '../../theme/tokens.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PassportOwnerMenuSheetProps {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  /** Navigate to /profile/edit */
  onEditProfile: () => void;
  /** Trigger avatar/photo picker */
  onChangeAvatar?: () => void;
  /** Trigger cover photo picker */
  onChangeCover?: () => void;
  /** Open the tab reorder sheet */
  onArrangeTabs?: () => void;
  /** Open the highlight composer */
  onManageHighlights?: () => void;
  /** Navigate to the owner's public profile */
  onViewAsPublic?: () => void;
  onViewMyStamps?: () => void;
  /** Open the section reorder sheet */
  onArrangeSections?: () => void;
  /** Switch the passport tab (for My Posts / My Memories / My Trips) */
  onSwitchTab?: (tab: string) => void;
  /** Open the Create Hub sheet */
  onCreatePress?: () => void;
  /** Sign the user out (shows confirmation prompt first) */
  onSignOut?: () => Promise<void>;
}

// ─── Item definitions ─────────────────────────────────────────────────────────

type ActionItem = {
  key: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  iconColor: string;
  /** false = coming soon / disabled */
  live: boolean;
  action: (props: PassportOwnerMenuSheetProps) => void;
};

type Section = {
  title: string;
  items: ActionItem[];
};

function close(props: PassportOwnerMenuSheetProps) {
  props.onClose();
}

const SECTIONS: Section[] = [
  {
    title: 'Profile',
    items: [
      {
        key: 'edit-profile',
        label: 'Edit Profile',
        Icon: PenLine,
        iconColor: '#3B7DED',
        live: true,
        action: (p) => { close(p); p.onEditProfile(); },
      },
      {
        key: 'change-photo',
        label: 'Change Profile Photo',
        Icon: Camera,
        iconColor: '#1A9CB0',
        live: true,
        action: (p) => { close(p); p.onChangeAvatar?.(); },
      },
      {
        key: 'change-cover',
        label: 'Change Passport Cover',
        Icon: Image,
        iconColor: '#7B5CE5',
        live: true,
        action: (p) => { close(p); p.onChangeCover?.(); },
      },
      {
        key: 'edit-bio',
        label: 'Edit Bio',
        Icon: FileText,
        iconColor: '#059669',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/about'); },
      },
      {
        key: 'reorder-tabs',
        label: 'Reorder Passport Tabs',
        Icon: Columns,
        iconColor: '#4F46E5',
        live: true,
        action: (p) => { close(p); p.onArrangeTabs?.(); },
      },
      {
        key: 'highlights',
        label: 'Manage Highlights',
        Icon: Star,
        iconColor: '#D97706',
        live: true,
        action: (p) => { close(p); p.onManageHighlights?.(); },
      },
      {
        key: 'preview-public',
        label: 'Preview Public Profile',
        Icon: Eye,
        iconColor: '#27AE71',
        live: true,
        action: (p) => { close(p); p.onViewAsPublic?.(); },
      },
      {
        key: 'analytics',
        label: 'Profile Analytics',
        Icon: BarChart2,
        iconColor: '#7B5CE5',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/analytics'); },
      },
    ],
  },
  {
    title: 'Travel Identity',
    items: [
      {
        key: 'my-stamps',
        label: 'My Stamps',
        Icon: Stamp,
        iconColor: '#D97706',
        live: true,
        action: (p) => { close(p); p.onViewMyStamps?.(); },
      },
      {
        key: 'travel-history',
        label: 'Travel History',
        Icon: MapPin,
        iconColor: '#2563EB',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/travel-history'); },
      },
      {
        key: 'home-base',
        label: 'Home Base',
        Icon: Home,
        iconColor: '#059669',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/home-base'); },
      },
      {
        key: 'languages',
        label: 'Languages',
        Icon: Globe,
        iconColor: '#7C3AED',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/languages'); },
      },
      {
        key: 'interests',
        label: 'Interests',
        Icon: Heart,
        iconColor: '#DB2777',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/interests'); },
      },
      {
        key: 'availability',
        label: 'Availability',
        Icon: Calendar,
        iconColor: '#059669',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/availability'); },
      },
      {
        key: 'verification',
        label: 'Verification',
        Icon: ShieldCheck,
        iconColor: '#2563EB',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/verification'); },
      },
      {
        key: 'trust-safety',
        label: 'Trust and Safety',
        Icon: Shield,
        iconColor: '#D94040',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/safety'); },
      },
    ],
  },
  {
    title: 'Content',
    items: [
      {
        key: 'create',
        label: 'Create',
        Icon: PlusCircle,
        iconColor: '#3B7DED',
        live: true,
        action: (p) => { close(p); p.onCreatePress?.(); },
      },
      {
        key: 'my-posts',
        label: 'My Posts',
        Icon: LayoutGrid,
        iconColor: '#3B7DED',
        live: true,
        action: (p) => { close(p); p.onSwitchTab?.('postcards'); },
      },
      {
        key: 'my-stories',
        label: 'My Stories',
        Icon: Film,
        iconColor: '#7B5CE5',
        live: false,
        action: (_p) => {},
      },
      {
        key: 'my-memories',
        label: 'My Memories',
        Icon: BookOpen,
        iconColor: '#27AE71',
        live: true,
        action: (p) => { close(p); p.onSwitchTab?.('memories'); },
      },
      {
        key: 'my-events',
        label: 'My Events',
        Icon: Calendar,
        iconColor: '#D97706',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/events/list'); },
      },
      {
        key: 'my-trips',
        label: 'My Trips',
        Icon: Briefcase,
        iconColor: '#7C3AED',
        live: true,
        action: (p) => { close(p); p.onSwitchTab?.('plans'); },
      },
      {
        key: 'saved-places',
        label: 'My Saved Places',
        Icon: Bookmark,
        iconColor: '#D4A017',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/saved'); },
      },
      {
        key: 'drafts',
        label: 'Drafts',
        Icon: FileText,
        iconColor: '#6B6862',
        live: false,
        action: (_p) => {},
      },
    ],
  },
  {
    title: 'Connections',
    items: [
      {
        key: 'followers',
        label: 'Followers',
        Icon: Users,
        iconColor: '#DB2777',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/followers'); },
      },
      {
        key: 'following',
        label: 'Following',
        Icon: UserPlus,
        iconColor: '#059669',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/following'); },
      },
      {
        key: 'follow-requests',
        label: 'Follow Requests',
        Icon: UserCheck,
        iconColor: '#2563EB',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/follow-requests'); },
      },
      {
        key: 'blocked',
        label: 'Blocked Accounts',
        Icon: UserX,
        iconColor: '#D94040',
        live: true,
        // Demonstrates object-form Href: closeThenNavigate now accepts
        // { pathname, params } in addition to plain strings, so sheets
        // that need to pass route params can use the shared helper too.
        action: (p) => { closeThenNavigate(p.onClose, { pathname: '/blocked-users' }); },
      },
      {
        key: 'muted',
        label: 'Muted Accounts',
        Icon: VolumeX,
        iconColor: '#6B6862',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/muted-users'); },
      },
    ],
  },
  {
    title: 'Account',
    items: [
      {
        key: 'settings',
        label: 'Settings',
        Icon: Settings,
        iconColor: '#4A4A48',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit'); },
      },
      {
        key: 'privacy',
        label: 'Privacy',
        Icon: Lock,
        iconColor: '#3B7DED',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/profile/edit/privacy'); },
      },
      {
        key: 'notifications',
        label: 'Notifications',
        Icon: Bell,
        iconColor: '#D97706',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/notifications'); },
      },
      {
        key: 'help',
        label: 'Help',
        Icon: HelpCircle,
        iconColor: '#27AE71',
        live: false,
        action: (_p) => {},
      },
      {
        key: 'explore-portava',
        label: 'Explore Portava',
        Icon: Compass,
        iconColor: '#3B7DED',
        live: true,
        action: (p) => { closeThenNavigate(p.onClose, '/explore-portava'); },
      },
      {
        key: 'sign-out',
        label: 'Sign Out',
        Icon: LogOut,
        iconColor: '#D94040',
        live: true,
        action: (p) => {
          Alert.alert(
            'Sign Out',
            'Are you sure you want to sign out?',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign Out',
                style: 'destructive',
                onPress: () => { close(p); p.onSignOut?.(); },
              },
            ],
          );
        },
      },
    ],
  },
];

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={sh.sectionHeader}>
      <Text style={sh.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={sh.sectionRule} />
    </View>
  );
}

const sh = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: space.lg,
    marginBottom: 4,
    paddingHorizontal: space.lg,
  },
  sectionTitle: {
    ...PP_LABEL,
    fontSize: 10,
    letterSpacing: 1.4,
    color: PP.inkMuted,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: PP.borderLight,
  },
});

// ─── Row ──────────────────────────────────────────────────────────────────────

function MenuRow({
  item,
  onAction,
}: {
  item: ActionItem;
  onAction: () => void;
}) {
  const { Icon, label, iconColor, live } = item;
  return (
    <Pressable
      style={({ pressed }) => [
        mr.row,
        !live && mr.rowDisabled,
        pressed && live && mr.rowPressed,
      ]}
      onPress={live ? onAction : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !live }}
    >
      <View style={[mr.iconWrap, { opacity: live ? 1 : 0.35 }]}>
        <Icon size={20} color={iconColor} strokeWidth={1.8} />
      </View>
      <Text style={[mr.label, !live && mr.labelMuted]}>
        {label}
      </Text>
      {!live ? (
        <View style={mr.soonBadge}>
          <Text style={mr.soonText}>Soon</Text>
        </View>
      ) : (
        <ChevronRight size={16} color={PP.inkMuted} strokeWidth={1.5} />
      )}
    </Pressable>
  );
}

const mr = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowPressed: {
    backgroundColor: PP.inkFaint,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: PP.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: PP.ink,
    lineHeight: 20,
  },
  labelMuted: {
    color: PP.inkMuted,
  },
  soonBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: PP.paperShadow,
    borderRadius: radius.pill,
  },
  soonText: {
    fontSize: 10,
    fontWeight: '700',
    color: PP.inkMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});

// ─── Main component ───────────────────────────────────────────────────────────

export function PassportOwnerMenuSheet(props: PassportOwnerMenuSheetProps) {
  const { visible, onClose } = props;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={s.root}>
      <Pressable style={s.overlay} onPress={onClose} />
      <View style={s.sheet}>
        {/* Handle + title row */}
        <View style={s.topBar}>
          <View style={s.handle} />
        </View>
        <View style={s.titleRow}>
          <Text style={s.title}>My Passport</Text>
          <Pressable style={s.closeBtn} onPress={onClose} hitSlop={10} accessibilityLabel="Close menu">
            <X size={18} color={PP.inkMuted} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Scrollable sections */}
        <ScrollView
          style={s.scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.scrollContent}
        >
          {SECTIONS.map((section) => (
            <View key={section.title}>
              <SectionHeader title={section.title} />
              {section.items.map((item) => (
                <MenuRow
                  key={item.key}
                  item={item}
                  onAction={() => item.action(props)}
                />
              ))}
            </View>
          ))}
          <View style={{ height: space.xl }} />
        </ScrollView>
      </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  // The sheet must sit inside a parent with a REAL height, or the ScrollView
  // below collapses. See the note on `scroll`.
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  sheet: {
    backgroundColor: PP.paper,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    // DEFINITE height, not maxHeight.
    //
    // maxHeight alone gives Yoga no definite height to resolve a child against,
    // so the ScrollView below could not be shrunk to fit: its frame took the
    // full content height, `overflow: hidden` clipped the excess at this
    // boundary, and the list rendered but would not scroll — the content that
    // was cut off was simply unreachable. A definite height gives the
    // ScrollView a real viewport, which is what makes it scrollable.
    height: '82%',
    overflow: 'hidden',
  },
  topBar: {
    alignItems: 'center',
    paddingTop: space.md,
    paddingBottom: 4,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: PP.paperShadow,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: PP.ink,
    letterSpacing: 0.2,
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: PP.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // flex:1 inside a sheet with a DEFINITE height (see `sheet` above).
  //
  // This menu rendered as a bare header with no items: the overlay above was
  // `flex: 1` and consumed the modal's whole height, leaving `sheet` (which has
  // only maxHeight, no flex and no height) to size itself from its content. A
  // child with `flex: 1` inside a content-sized parent resolves to ZERO height,
  // so the ScrollView — and every one of the eight menu sections in it —
  // measured 0pt. The data was always fine; nothing was ever visible.
  //
  // Now the overlay is an absolute backdrop, `root` gives the sheet somewhere
  // bounded to sit, and `sheet` has a definite height — so this flex:1 resolves
  // against a real viewport and the list scrolls.
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: space.xl,
  },
});
