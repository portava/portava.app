import React, { useState } from 'react';
import { Linking, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SettingsScreen, SettingsSection, SettingsRow } from '../../src/components/settings/SettingsUI';
import { accountAppealContact } from '../../src/lib/accountAppealContact';
import { supabase } from '../../src/lib/supabase';
import { useSession } from '../../src/context/SessionContext';

/** Public route: a GoTrue-locked account must not need a working login to find help. */
export default function AccountAccessScreen() {
  const { isAuthed } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contact = accountAppealContact();
  async function openContact() {
    if (!contact || busy) return;
    setBusy(true); setError(null);
    try { await Linking.openURL(contact); }
    catch { setError('Could not open the appeal service. Please try again.'); }
    finally { setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await supabase.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      router.replace('/(auth)/sign-in');
    } catch { setError('Could not sign out. Please try again.'); }
    finally { setBusy(false); }
  }
  return <SettingsScreen title="Account access & appeals">
    <SettingsSection title="If your account is restricted">
      <Text style={styles.body}>An account suspension or ban can prevent sign-in as well as activity in the app. A password reset does not overturn a moderation decision.</Text>
      <Text style={styles.body}>Ask for a review if you believe a decision is incorrect. Include your account email or handle and any decision reference you received. Do not include your password, identity documents, or another person’s private details.</Text>
      {contact ? <SettingsRow title={busy ? 'Opening…' : 'Request an account review'} onPress={() => { void openContact(); }} disabled={busy} />
        : <Text accessibilityRole="alert" style={styles.body}>An external account-review contact is not available here yet. If you received a moderation notice, use the contact or appeal instructions in that notice.</Text>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {isAuthed ? <>
        <SettingsRow title="In-app restrictions & appeals" onPress={() => router.push('/appeals')} />
        <SettingsRow title={busy ? 'Please wait…' : 'Sign out of this device'} onPress={() => { void signOut(); }} disabled={busy} />
      </> : null}
    </SettingsSection>
  </SettingsScreen>;
}
const styles = StyleSheet.create({ body: { padding: 16, color: '#111827', fontSize: 15 }, error: { padding: 16, color: '#B91C1C' } });
