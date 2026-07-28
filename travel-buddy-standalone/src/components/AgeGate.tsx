/**
 * AgeGate — wraps the authenticated app tree.
 *
 * After the user is signed in and their account status is confirmed active,
 * this component checks whether they have a valid 18+ date of birth on file
 * by reading the `ageGateRequired` flag returned by GET /me/profile.
 *
 * Fail-closed: if the profile fetch fails for any reason, the user is shown a
 * blocking retry screen — protected app content is never rendered until
 * eligibility is confirmed.
 *
 * Persistence: once a userId passes the gate, the result is written to
 * AsyncStorage so subsequent reloads/rebuilds skip the network round-trip and
 * never re-show the DOB screen for that user.
 *
 * DEV/preview bypass: in development builds (__DEV__ === true) the gate is
 * auto-satisfied for the currently signed-in account so the preview app opens
 * without asking for DOB each time. __DEV__ is stripped to `false` by Metro in
 * every production build — this bypass is never present in production.
 */
import React, { useEffect, useState, useRef, type PropsWithChildren } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, space, type as typeTokens } from '../theme/tokens.ts';
import { useSession } from '../context/SessionContext.tsx';
import { getMyProfile, updateMyProfile } from '../services/profile.ts';
import { DatePickerField } from './DatePickerField';

/** Calculate full years from a YYYY-MM-DD string. Returns null if unparseable. */
function computeAge(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const birth = new Date(dob + 'T00:00:00');
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

/** AsyncStorage key that persists a verified userId across reloads. */
const ageVerifiedKey = (uid: string) => `@travel_buddy/age_verified:${uid}`;

/**
 * In development builds only: auto-satisfy the gate so the preview opens
 * directly. Metro replaces __DEV__ with `false` in every production bundle,
 * so any branch guarded by it is dead-code-eliminated before shipping.
 *
 * NOTE: __DEV__ is checked inline inside the effect (not captured as a
 * module-level const) so that test environments can override global.__DEV__
 * in beforeEach/afterEach without needing to reload the module.
 */

type GateState = 'loading' | 'clear' | 'blocked' | 'error';

export function AgeGate({ children }: PropsWithChildren) {
  const { userId, isAuthed, loading: sessionLoading } = useSession();
  const [gateState, setGateState] = useState<GateState>('loading');
  // Track the latest check so stale responses from a prior auth state are ignored.
  const checkSeqRef = useRef(0);
  /**
   * Once a userId is confirmed eligible — either by the persisted AsyncStorage
   * value, the initial profile fetch, or by the user successfully submitting
   * the DOB form — store it here so that subsequent effect re-runs triggered
   * by token refreshes or other auth events don't re-trigger the gate.
   *
   * Stored per-userId so a sign-out → sign-in as a different user forces a
   * fresh check for the new account.
   */
  const verifiedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (sessionLoading) return;

    if (!isAuthed || !userId) {
      setGateState('clear');
      return;
    }

    // Already confirmed eligible for this user in this JS session — skip
    // everything and stay clear without flashing a loading spinner.
    if (verifiedUserIdRef.current === userId) {
      setGateState('clear');
      return;
    }

    // ── DEV/preview bypass ────────────────────────────────────────────────
    // Auto-satisfy the gate in development so the preview app opens without
    // asking for DOB. Persisted to AsyncStorage so subsequent reloads in dev
    // are instant too.  Metro inlines __DEV__ = false in every production
    // bundle, so this entire block is dead-code-eliminated before shipping.
    // eslint-disable-next-line no-undef
    if (__DEV__) {
      verifiedUserIdRef.current = userId;
      AsyncStorage.setItem(ageVerifiedKey(userId), '1').catch(() => {});
      setGateState('clear');
      return;
    }

    // Transition to loading immediately so protected content is never briefly shown.
    setGateState('loading');

    const seq = ++checkSeqRef.current;
    let alive = true;

    (async () => {
      // ── 1. Persisted check (survives reloads and hot rebuilds) ─────────
      // If we've previously confirmed this userId is eligible, skip the
      // network round-trip entirely.
      try {
        const persisted = await AsyncStorage.getItem(ageVerifiedKey(userId));
        if (!alive || checkSeqRef.current !== seq) return;
        if (persisted === '1') {
          verifiedUserIdRef.current = userId;
          setGateState('clear');
          return;
        }
      } catch {
        // Non-fatal — AsyncStorage unavailable (e.g. first install, storage
        // cleared). Fall through to network check.
      }

      // ── 2. Network check (first load for this userId) ──────────────────
      try {
        const res = await getMyProfile();
        if (!alive || checkSeqRef.current !== seq) return;

        if (!res.ok || !res.data) {
          // Fail closed: unknown eligibility → block access until confirmed.
          setGateState('error');
          return;
        }

        // Only explicit false clears the gate — undefined/null/true all block (fail closed).
        const eligible = (res.data as any).ageGateRequired === false;
        if (eligible) {
          verifiedUserIdRef.current = userId;
          // Persist so future reloads skip the network call.
          AsyncStorage.setItem(ageVerifiedKey(userId), '1').catch(() => {});
        }
        setGateState(eligible ? 'clear' : 'blocked');
      } catch {
        if (!alive || checkSeqRef.current !== seq) return;
        // Fail closed on any unexpected error (network, parse, etc.).
        setGateState('error');
      }
    })();

    return () => { alive = false; };
  }, [sessionLoading, isAuthed, userId]);

  if (sessionLoading || gateState === 'loading') {
    return (
      <View style={st.loadingContainer}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (gateState === 'error') {
    return (
      <AgeGateErrorScreen onRetry={() => {
        setGateState('loading');
        const seq = ++checkSeqRef.current;
        (async () => {
          const res = await getMyProfile();
          if (checkSeqRef.current !== seq) return;
          if (!res.ok || !res.data) { setGateState('error'); return; }
          const eligible = (res.data as any).ageGateRequired === false;
          if (eligible) {
            verifiedUserIdRef.current = userId;
            AsyncStorage.setItem(ageVerifiedKey(userId!), '1').catch(() => {});
          }
          setGateState(eligible ? 'clear' : 'blocked');
        })();
      }} />
    );
  }

  if (gateState === 'blocked') {
    return (
      <AgeGateScreen
        onVerified={() => {
          // Mark this user as verified so any subsequent effect re-runs caused
          // by token refreshes or auth events don't re-block them, and so
          // future reloads skip the network check entirely.
          verifiedUserIdRef.current = userId;
          AsyncStorage.setItem(ageVerifiedKey(userId!), '1').catch(() => {});
          setGateState('clear');
        }}
      />
    );
  }

  return <>{children}</>;
}

// ── Error / retry screen ───────────────────────────────────────────────────────

function AgeGateErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { signOut } = useSession();
  return (
    <SafeAreaView style={st.root}>
      <View style={st.inner}>
        <Text style={st.icon}>⚠️</Text>
        <Text style={st.heading}>Verification check failed</Text>
        <Text style={st.body}>
          We could not verify your account eligibility. Please check your connection and try again.
        </Text>
        <TouchableOpacity style={st.primaryBtn} onPress={onRetry} activeOpacity={0.8}>
          <Text style={st.primaryBtnLabel}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={st.secondaryBtn} onPress={signOut} activeOpacity={0.7}>
          <Text style={st.secondaryBtnLabel}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Blocking DOB collection screen ────────────────────────────────────────────

function AgeGateScreen({ onVerified }: { onVerified: () => void }) {
  const { signOut } = useSession();
  const [dob, setDob] = useState('');
  const [dobError, setDobError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function validateDobClient(value: string): string | null {
    if (!value) return 'Please enter your date of birth.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date must be in YYYY-MM-DD format.';
    const age = computeAge(value);
    if (age === null) return 'Please enter a valid date.';
    if (age < 18) return 'You must be at least 18 years old to use this app.';
    return null;
  }

  async function handleSave() {
    const clientError = validateDobClient(dob);
    if (clientError) {
      setDobError(clientError);
      return;
    }
    setSaving(true);
    setDobError(null);
    const res = await updateMyProfile({ dateOfBirth: dob });
    setSaving(false);
    if (!res.ok) {
      const msg =
        res.errorKind === 'forbidden'
          ? 'You must be at least 18 years old to use this app.'
          : (res as any).message ?? 'Could not save your date of birth. Please try again.';
      setDobError(msg);
      return;
    }
    onVerified();
  }

  return (
    <SafeAreaView style={st.root}>
      <ScrollView contentContainerStyle={st.inner} bounces={false}>
        <Text style={st.icon}>🔒</Text>
        <Text style={st.heading}>Age verification required</Text>
        <Text style={st.body}>
          This app is for users 18 and older. Please provide your date of birth to continue.
          Your date of birth is kept private and is never shown publicly.
        </Text>

        <View style={st.fieldWrap}>
          <Text style={st.fieldLabel}>Date of birth</Text>
          <DatePickerField
            value={dob}
            onChange={(v) => { setDob(v); setDobError(null); }}
            placeholder="Select your date of birth"
          />
          {dobError ? <Text style={st.errorText}>{dobError}</Text> : null}
        </View>

        <TouchableOpacity
          style={[st.primaryBtn, saving && st.btnDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator color={color.onInk} />
          ) : (
            <Text style={st.primaryBtnLabel}>Confirm and continue</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={st.secondaryBtn}
          onPress={() => {
            Alert.alert(
              'Sign out?',
              'You must be 18 or older to use this app. Signing out will return you to the login screen.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: signOut },
              ],
            );
          }}
          activeOpacity={0.7}
        >
          <Text style={st.secondaryBtnLabel}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  inner: {
    flexGrow: 1,
    padding: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  icon: {
    fontSize: 48,
    textAlign: 'center',
    marginBottom: space.md,
  },
  heading: {
    ...typeTokens.hero,
    fontSize: 26,
    textAlign: 'center',
    color: color.ink,
    marginBottom: space.sm,
  },
  body: {
    ...typeTokens.body,
    fontSize: 15,
    textAlign: 'center',
    color: color.mute,
    lineHeight: 22,
    marginBottom: space.md,
  },
  fieldWrap: {
    width: '100%',
    gap: space.xs,
    marginBottom: space.md,
  },
  fieldLabel: {
    ...typeTokens.small,
    fontWeight: '600' as const,
    color: color.deep,
    marginBottom: 4,
  },
  errorText: {
    fontSize: 13,
    color: color.signal,
    marginTop: 4,
  },
  primaryBtn: {
    backgroundColor: color.signal,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    width: '100%',
    marginTop: space.lg,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  primaryBtnLabel: {
    color: color.onInk,
    fontSize: 16,
    fontWeight: '600' as const,
  },
  secondaryBtn: {
    marginTop: space.md,
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  secondaryBtnLabel: {
    color: color.mute,
    fontSize: 15,
  },
});
