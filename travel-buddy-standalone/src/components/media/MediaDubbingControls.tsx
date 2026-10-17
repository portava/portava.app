import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSession } from '../../context/SessionContext.tsx';
import { useLanguagePreference } from '../../context/LanguagePreferenceContext.tsx';
import { color, radius, space } from '../../theme/tokens.ts';
import type { DubbingPlayback } from '../../hooks/useDubbingPlayback.ts';
import { DUBBING_LABEL, DUBBING_DISCLOSURE_VERSION, DubbingRequestError, getDubbingConsent, requestDubbing, revokeDubbing, type DubbingConsent } from '../../services/media/dubbing.ts';

export interface MediaDubbingControlsProps {
  assetId: string;
  sourceKey: string;
  ownerId: string;
  enabled: boolean;
  languages: readonly { code: string; label: string; ready: boolean }[];
  playback: DubbingPlayback;
  disclosure?: { version: typeof DUBBING_DISCLOSURE_VERSION; text: string; approved: true };
  automaticPreference?: { userId: string; enabled: boolean };
  automaticPreferenceLoading?: boolean;
  onAutomaticPreferenceChange?: (preference: { userId: string; enabled: boolean }) => void | Promise<void>;
}

export function MediaDubbingControls(props: MediaDubbingControlsProps) {
  const { userId, isAuthed } = useSession();
  const { preferredLanguage } = useLanguagePreference();
  const identityKey = JSON.stringify([props.assetId, props.sourceKey, userId, props.ownerId]);
  const preferred = props.languages.find((item) => item.code === preferredLanguage)?.code ?? props.languages[0]?.code ?? '';
  const [selected, setSelected] = useState({ key: identityKey, language: preferred });
  const targetLanguage = selected.key === identityKey && props.languages.some((item) => item.code === selected.language) ? selected.language : preferred;
  const formKey = JSON.stringify([identityKey, targetLanguage, props.disclosure?.version, props.disclosure?.text, props.disclosure?.approved]);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ key: string; value: DubbingConsent } | null>(null);
  const [busy, setBusy] = useState<'loading' | 'requesting' | 'revoking' | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const nonce = useRef(0);
  const latestKey = useRef(formKey); latestKey.current = formKey;
  const creator = isAuthed && !!userId && userId === props.ownerId;
  const approved = props.disclosure?.approved === true && props.disclosure.version === DUBBING_DISCLOSURE_VERSION && !!props.disclosure.text.trim();
  const consent = receipt?.key === formKey ? receipt.value : null;
  const canGenerate = creator && props.enabled && approved && accepted === formKey && !!consent && !busy;
  const canPlay = props.enabled && isAuthed && !!userId && props.languages.some(item => item.code === targetLanguage && item.ready === true) && props.playback.status !== 'loading' && props.playback.status !== 'restoring';

  useEffect(() => {
    const captured = ++nonce.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setAccepted(null); setReceipt(null); setBusy(null);
    if (props.enabled && creator && targetLanguage && userId) {
      setBusy('loading');
      void getDubbingConsent({ assetId: props.assetId, userId }, targetLanguage, controller.signal).then((value) => {
        if (captured === nonce.current && !controller.signal.aborted && latestKey.current === formKey) setReceipt({ key: formKey, value });
      }).catch(() => {
        if (captured === nonce.current && !controller.signal.aborted) setNotice({ key: formKey, text: 'AI audio is unavailable. Original audio remains available.' });
      }).finally(() => { if (captured === nonce.current && !controller.signal.aborted) setBusy(null); });
    }
    return () => { ++nonce.current; controller.abort(); pending.current?.abort(); };
  }, [formKey, creator, refresh, props.enabled]);

  async function generate() {
    if (!canGenerate || !userId || !consent) return;
    const captured = ++nonce.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy('requesting'); setAccepted(null);
    try {
      await requestDubbing({ assetId: props.assetId, userId }, targetLanguage, consent.consentRevision, true, controller.signal);
      if (captured === nonce.current && latestKey.current === formKey) setNotice({ key: formKey, text: 'AI audio requested. It is not ready to play yet.' });
    } catch {
      if (captured === nonce.current && latestKey.current === formKey) setNotice({ key: formKey, text: 'Request not confirmed. Reload permission and try again.' });
    } finally {
      if (captured === nonce.current && latestKey.current === formKey) { setBusy(null); setRefresh((value) => value + 1); }
    }
  }

  async function withdraw() {
    if (!creator || !userId || busy === 'revoking') return;
    const captured = ++nonce.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setAccepted(null); setReceipt(null); setBusy('revoking'); void props.playback.selectOriginal();
    try {
      await revokeDubbing({ assetId: props.assetId, userId }, controller.signal);
      if (captured === nonce.current && latestKey.current === formKey) setNotice({ key: formKey, text: 'AI audio permission withdrawn.' });
    } catch (error) {
      if (captured === nonce.current && latestKey.current === formKey) setNotice({ key: formKey, text: error instanceof DubbingRequestError && error.code === 'cleanup_failed' ? 'Permission withdrawn. Audio cleanup needs another attempt.' : 'Withdrawal not confirmed. Please try again.' });
    } finally {
      if (captured === nonce.current && latestKey.current === formKey) { setBusy(null); setRefresh((value) => value + 1); }
    }
  }

  const automatic = props.automaticPreference?.userId === userId && props.automaticPreference.enabled === true;
  const automaticDisabled = props.automaticPreferenceLoading === true || (!props.enabled && !automatic);
  return <View style={styles.container}>
    <Text style={styles.title}>{DUBBING_LABEL}</Text>
    <Text style={styles.help}>A stock synthetic voice, not the creator’s voice. Original audio remains available; background music is not mixed into AI audio.</Text>
    <View style={styles.row}>
      {props.languages.map((item) => <Pressable key={item.code} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ selected: targetLanguage === item.code }} style={[styles.button, targetLanguage === item.code && styles.selected]} onPress={() => { setAccepted(null); setSelected({ key: identityKey, language: item.code }); }}><Text style={styles.text}>{item.label}</Text></Pressable>)}
    </View>
    <View style={styles.row}>
      <Pressable accessibilityRole="radio" accessibilityLabel="Original audio" accessibilityState={{ selected: !props.playback.muteOriginal }} style={styles.button} onPress={() => { void props.playback.selectOriginal(); }}><Text style={styles.text}>Original audio</Text></Pressable>
      <Pressable accessibilityRole="radio" accessibilityLabel="Play AI audio" accessibilityState={{ selected: props.playback.status === 'ready' && props.playback.language === targetLanguage, disabled: !canPlay }} disabled={!canPlay} style={styles.button} onPress={() => { if (canPlay) void props.playback.selectDubbed(targetLanguage); }}><Text style={styles.text}>Play AI audio</Text></Pressable>
    </View>
    {props.playback.status === 'ready' ? <Text accessibilityLiveRegion="polite" style={styles.help}>Playing AI audio: {props.languages.find((item) => item.code === props.playback.language)?.label ?? props.playback.language}</Text> : null}
    {props.playback.status === 'loading' ? <Text accessibilityLiveRegion="polite" style={styles.help}>Checking AI audio…</Text> : null}
    {props.playback.status === 'restoring' ? <Text accessibilityLiveRegion="polite" style={styles.help}>Returning to original audio…</Text> : null}
    {props.playback.status === 'unavailable' ? <Text accessibilityLiveRegion="polite" style={styles.help}>{props.playback.muteOriginal ? 'Audio cleanup or restoration failed. Stop playback; if Original audio cannot recover, restart the app before retrying.' : 'AI audio is unavailable. Original audio is selected.'}</Text> : null}
    {props.onAutomaticPreferenceChange && isAuthed && userId ? <><Text style={styles.help}>Saved for this account on this device. Uses your Content Language setting only when that exact audio language is ready; otherwise original audio plays. This does not generate audio or grant creator consent.</Text><Pressable accessibilityRole="checkbox" accessibilityLabel="Automatically use AI audio in my preferred language" accessibilityState={{ checked: automatic, disabled: automaticDisabled, busy: props.automaticPreferenceLoading === true }} disabled={automaticDisabled} style={styles.button} onPress={() => {
      if (automaticDisabled) return;
      const savedKey = formKey;
      setNotice(null);
      void Promise.resolve().then(() => {
        if (latestKey.current !== savedKey) return;
        return props.onAutomaticPreferenceChange?.({ userId, enabled: !automatic });
      }).catch(() => { if (latestKey.current === savedKey) setNotice({ key: savedKey, text: 'Automatic audio preference was not saved.' }); });
    }}><Text style={styles.text}>{automatic ? '☑' : '☐'} Automatically use AI audio in my preferred language</Text></Pressable></> : null}
    {creator ? <View style={styles.creator}>
      {approved ? <Pressable accessibilityRole="checkbox" accessibilityLabel="I agree to generate AI audio" accessibilityState={{ checked: accepted === formKey }} style={styles.button} onPress={() => setAccepted(accepted === formKey ? null : formKey)}><Text style={styles.text}>{accepted === formKey ? '☑' : '☐'} {props.disclosure?.text}</Text></Pressable> : <Text style={styles.help}>Generation awaits approved consent wording.</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Generate AI audio" accessibilityState={{ disabled: !canGenerate, busy: busy === 'requesting' }} disabled={!canGenerate} style={styles.button} onPress={() => { void generate(); }}><Text style={styles.text}>{busy === 'requesting' ? 'Requesting…' : 'Generate AI audio'}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Remove AI audio" accessibilityState={{ disabled: busy === 'revoking', busy: busy === 'revoking' }} disabled={busy === 'revoking'} style={styles.button} onPress={() => { void withdraw(); }}><Text style={styles.text}>Remove AI audio</Text></Pressable>
    </View> : null}
    {notice?.key === formKey ? <Text accessibilityLiveRegion="polite" style={styles.help}>{notice.text}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm },
  title: { color: color.ink, fontSize: 15, fontWeight: '600' },
  help: { color: color.mute, fontSize: 13, lineHeight: 19 },
  text: { color: color.ink, fontSize: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  button: { minHeight: 44, justifyContent: 'center', padding: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm },
  selected: { borderColor: color.deep, backgroundColor: color.paperRaised },
  creator: { gap: space.sm },
});
