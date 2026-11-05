import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { VERIFICATION_KEPT, VERIFICATION_NEVER_STORED } from '../../src/lib/verificationDisclosure';
import { color, space, type as t, radius, layout } from '../../src/theme/tokens';
import { publicOwnerLink } from '../../src/lib/publicOwnerLink';

function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text selectable style={styles.body}>{children}</Text>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" selectable style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

export default function PrivacyInformationScreen() {
  const insets = useSafeAreaInsets();
  const [linkError, setLinkError] = useState<string | null>(null);
  // Configure only after the owner approves the published policy and operating contacts.
  const policy = publicOwnerLink(process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL);
  const providerPolicy = publicOwnerLink(process.env.EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL);
  const privacyContact = publicOwnerLink(process.env.EXPO_PUBLIC_PRIVACY_CONTACT_URL);
  async function openLink(url: string) {
    setLinkError(null);
    try { await Linking.openURL(url); }
    catch { setLinkError('Could not open this link. Please try again.'); }
  }
  function externalLink(label: string, url: string) {
    return <Pressable accessibilityRole="link" accessibilityLabel={label} style={styles.link}
      onPress={() => { void openLink(url); }}><Text style={styles.linkText}>{label}</Text></Pressable>;
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }

  return (
    <View style={styles.root}>
      <AppHeader variant="detail" title="Privacy information" onBack={goBack} />
      <ScrollView
        testID="privacy-information-content"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxxl }]}
      >
        <View style={styles.notice}>
          <Section title={policy ? 'Published privacy policy' : 'Not an approved privacy policy'}>
            {policy ? <>
              <Paragraph>Read the published privacy policy below. This screen also explains the documented identity-check flow.</Paragraph>
              {externalLink('Read privacy policy', policy)}
            </> : <Paragraph>
              The available policy text is a draft awaiting owner and legal review. This page explains
              only the documented identity-check flow; it is not a full privacy policy.
            </Paragraph>}
          </Section>
        </View>
        {linkError ? <Text accessibilityRole="alert" style={styles.body}>{linkError}</Text> : null}
        {providerPolicy ? <Section title="Verification service privacy">{externalLink('Verification service privacy policy', providerPolicy)}</Section> : null}
        <Section title="Privacy contact">
          {privacyContact ? externalLink('Contact about privacy', privacyContact)
            : <Paragraph>A privacy contact has not been supplied here yet.</Paragraph>}
        </Section>

        <Section title="How an identity check works">
          <Paragraph>
            When you choose an identity check, Portava creates a session associated with your account
            and opens the verification service’s hosted flow. Document capture and any selfie check
            take place with that service.
          </Paragraph>
          <Paragraph>
            Portava uses the check result and the derived details below to record verification status
            and determine access to features that require a verified adult. The service’s own handling
            of your documents is separate from what Portava’s identity-check records keep.
          </Paragraph>
        </Section>

        <Section title="What the identity check never stores">
          <Paragraph>Portava’s identity-check records do not store:</Paragraph>
          {VERIFICATION_NEVER_STORED.map((item) => <Paragraph key={item.label}>• {item.label}</Paragraph>)}
          <Paragraph>
            This describes the identity check only. A birth date you enter separately in your profile
            is a different field; this is not a claim that Portava never stores any birth date.
          </Paragraph>
        </Section>

        <Section title="What the identity check keeps">
          {VERIFICATION_KEPT.map((item) => <Paragraph key={item.label}>• {item.label}</Paragraph>)}
          <Paragraph>
            The record also links the check to your account and stores the provider name, session
            reference, and creation, update, verification and expiry times when available. Your profile
            can also hold a verification level and verification time.
          </Paragraph>
        </Section>

        <Section title="Deletion and retention boundaries">
          <Paragraph>
            Account deletion includes asking the verification service to delete its copy before
            deleting Portava’s verification records. A provider request can fail; it is not confirmation
            of completed erasure. The account-deletion request is in Settings → Account → Delete account.
          </Paragraph>
          <Paragraph>
            The documented cleanup targets failed or expired checks older than 90 days, measured from
            their last status update. It does not target successful checks. This page does not confirm
            that cleanup has run or guarantee when a provider deletes its copy.
          </Paragraph>
          <Paragraph>
            Moderation history is separate: deleting verification records does not itself delete
            reports or moderation actions.
          </Paragraph>
        </Section>

        {!policy ? <Section title="What is still awaiting approval">
          <Paragraph>
            A full policy needs reviewed text or a published policy URL, the company’s legal name,
            mailing address, privacy contact and effective date, plus the verification provider’s
            privacy-policy link. Age-policy choices and retention statements also need review.
          </Paragraph>
          <Paragraph>
            No approved policy is supplied here. Reading this
            information does not give consent to a new use of your data or start an identity check.
          </Paragraph>
        </Section> : null}
        {!providerPolicy ? <Paragraph>The verification service’s privacy-policy link has not been supplied here yet.</Paragraph> : null}

        <Section title="Related settings">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Privacy settings"
            accessibilityHint="Opens your profile privacy controls."
            onPress={() => router.push('/profile/edit/privacy')}
            style={({ pressed }) => [styles.link, pressed && { opacity: layout.pressedOpacity }]}
          >
            <Text style={styles.linkText}>Privacy settings</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Identity verification"
            accessibilityHint="Opens the verification screen without starting a check."
            onPress={() => router.push('/profile/verification')}
            style={({ pressed }) => [styles.link, pressed && { opacity: layout.pressedOpacity }]}
          >
            <Text style={styles.linkText}>Identity verification</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  content: { padding: space.lg, gap: space.xl, width: '100%', maxWidth: 720, alignSelf: 'center' },
  section: { gap: space.md },
  notice: {
    padding: space.lg, backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.deep, borderRadius: radius.md,
  },
  heading: { ...t.heading, color: color.ink },
  body: { ...t.body, color: color.ink },
  link: {
    minHeight: 48, padding: space.lg, justifyContent: 'center',
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
  },
  linkText: { ...t.bodyStrong, color: color.deep },
});
