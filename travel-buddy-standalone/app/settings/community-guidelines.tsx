import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Flag, ShieldCheck, UserX } from 'lucide-react-native';
import { SettingsScreen, SettingsSection, SettingsRow, SettingsDivider } from '../../src/components/settings/SettingsUI';
import { PP } from '../../src/theme/passportTokens';
import { space, type as t } from '../../src/theme/tokens';

// Product guidance reflects the existing report categories and Buddy rules.
// This screen does not assert a new legal policy, retention term or service guarantee.
export default function CommunityGuidelinesScreen() {
  return (
    <SettingsScreen title="Community Guidelines" subtitle="Help keep travel connections respectful and useful">
      <SettingsSection title="Respect people and their boundaries">
        <Text selectable style={styles.body}>
          Respect someone’s decision to decline a conversation, invitation, or meeting. Do not harass,
          threaten, impersonate, or keep contacting someone who has asked you to stop. Never share
          another person’s private details, messages, or location without their permission.
        </Text>
      </SettingsSection>
      <SettingsSection title="Share honestly">
        <Text selectable style={styles.body}>
          Use accurate profile, place, event, and service information. Do not post scams, spam, or
          misleading offers. Describe what you experienced without presenting a plan as a completed
          visit. Report incorrect place details so they can be reviewed.
        </Text>
      </SettingsSection>
      <SettingsSection title="Make informed connections">
        <Text selectable style={styles.body}>
          Agree on a meeting place and respect everyone’s consent. Use the safety tools when you need
          them. A verified badge records an identity check; a Trust standing or stamp is not a safety
          guarantee or endorsement. If you face immediate danger, use local emergency services.
        </Text>
      </SettingsSection>
      <SettingsSection title="Buddy services">
        <Text selectable style={styles.body}>
          Buddy services are social travel companionship, with no romantic or adult-service
          expectations. Buddies must keep availability and pricing accurate, respond to booking
          requests within 24 hours, and honour confirmed bookings and agreed meeting locations.
        </Text>
      </SettingsSection>
      <SettingsSection title="Report concerns and control contact">
        <Text selectable style={styles.body}>
          Open the menu on a profile, post, message, event, or listing to report a concern. Choose the
          closest reason and include the details needed for review. Reports do not automatically
          prove wrongdoing. You can also block or mute an account. Eligible moderation decisions can
          be appealed; the appeal screen shows the status of your request.
        </Text>
        <SettingsRow icon={<Flag size={18} color={PP.ink} />} title="Your Reports"
          onPress={() => router.push('/profile/edit/reports')} />
        <SettingsDivider />
        <SettingsRow icon={<UserX size={18} color={PP.ink} />} title="Blocked Users"
          onPress={() => router.push('/blocked-users')} />
        <SettingsDivider />
        <SettingsRow icon={<ShieldCheck size={18} color={PP.ink} />} title="Restrictions & Appeals"
          onPress={() => router.push('/appeals')} />
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({ body: { ...t.body, color: PP.ink, padding: space.lg } });
