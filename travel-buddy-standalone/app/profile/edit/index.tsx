/**
 * Edit Profile & Settings hub — single entry point for all profile editing
 * and settings, grouped into eleven sections. Passport ivory/green aesthetic.
 */
import React from 'react';
import { router } from 'expo-router';
import {
  User, Camera, LayoutGrid, Heart, Compass, Eye, Shield,
  Bell, MapPin, Link2, KeyRound, Phone, BookMarked, Map, Globe, Radio,
} from 'lucide-react-native';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';

const ICON = 18;

export default function EditSettingsHub() {
  const go = (path: string) => () => router.push(path as any);

  return (
    <SettingsScreen title="Edit & Settings" subtitle="Your profile, privacy, and account">
      <SettingsSection title="Profile">
        <SettingsRow
          icon={<User size={ICON} color={PP.ink} />}
          title="Identity"
          subtitle="Name, username, bio, home city, languages"
          onPress={go('/profile/edit/identity')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Camera size={ICON} color={PP.ink} />}
          title="Photos & Appearance"
          subtitle="Profile photo and cover backdrop"
          onPress={go('/profile/edit/photos')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<LayoutGrid size={ICON} color={PP.ink} />}
          title="Passport Layout"
          subtitle="Arrange your passport sections"
          onPress={go('/profile/edit/passport-layout')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Heart size={ICON} color={PP.ink} />}
          title="About Me"
          subtitle="Interests and travel style"
          onPress={go('/profile/edit/about')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Compass size={ICON} color={PP.ink} />}
          title="Travel Profile"
          subtitle="Pace, budget, planning style, meetups"
          onPress={go('/profile/edit/travel-profile')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<BookMarked size={ICON} color={PP.ink} />}
          title="Passports"
          subtitle="Saved for trip entry and visa checks"
          onPress={go('/profile/edit/passports')}
        />
      </SettingsSection>

      <SettingsSection title="Privacy & Safety">
        <SettingsRow
          icon={<Eye size={ICON} color={PP.ink} />}
          title="Privacy & Visibility"
          subtitle="Who can see your profile and activity"
          onPress={go('/profile/edit/privacy')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Shield size={ICON} color={PP.ink} />}
          title="Safety & Verification"
          subtitle="Verification, blocked users, emergency contacts"
          onPress={go('/profile/edit/safety')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<MapPin size={ICON} color={PP.ink} />}
          title="Location & Availability"
          subtitle="Location sharing, Find Your Circle"
          onPress={go('/profile/edit/location')}
        />
        <SettingsDivider />
        {/* D4: the persistent, separate Intelligence Contributions control must be
            reachable — this is its home in the real settings hub. (The legacy
            /settings hub screen is orphaned; nothing navigates to it.) */}
        <SettingsRow
          icon={<Radio size={ICON} color={PP.ink} />}
          title="Live Intel & Contributions"
          subtitle="Intelligence Contributions consent, capture prompts"
          onPress={go('/settings/intel-prompts')}
        />
      </SettingsSection>

      <SettingsSection title="Help &amp; Navigation">
        <SettingsRow
          icon={<Map size={ICON} color={PP.ink} />}
          title="Explore Portava"
          subtitle="Browse all features and screens in one place"
          onPress={go('/explore-portava')}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow
          icon={<Globe size={ICON} color={PP.ink} />}
          title="Content Language"
          subtitle="Language for feed and post translations"
          onPress={go('/profile/edit/content-language')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Bell size={ICON} color={PP.ink} />}
          title="Notifications"
          subtitle="What you get notified about"
          onPress={go('/profile/edit/notifications')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Phone size={ICON} color={PP.ink} />}
          title="Calling"
          subtitle="Who can call you, video calls"
          onPress={go('/profile/edit/calling')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<Link2 size={ICON} color={PP.ink} />}
          title="Connected Features"
          subtitle="Telegraph, Rent a Buddy, tags, translation"
          onPress={go('/profile/edit/connected')}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<KeyRound size={ICON} color={PP.ink} />}
          title="Account"
          subtitle="Email, deactivate, delete, log out"
          onPress={go('/profile/edit/account')}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
