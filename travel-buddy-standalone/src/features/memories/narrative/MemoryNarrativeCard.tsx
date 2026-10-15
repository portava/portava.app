/**
 * MemoryNarrativeCard — the owner's summary of one of their Memories, on the
 * Memory screen. census-highlights-memories H14 (§2 MemoryNarrativeService:
 * "optional editable summaries from structured facts"), H172 (§18 the optional
 * AI summary) and H265 (§28.16 the owner's own words). Server: PR #720
 * (routes/memoryNarrative.ts, migration 3802); client: memoryNarrativeApi.ts.
 *
 * OWNER ONLY. For anyone else it renders nothing and asks the server nothing
 * (the server answers a non-owner 404 anyway).
 *
 * THE SUMMARY is the server's deterministic one, built from the Memory's own
 * facts. The owner may edit it here; an edit is theirs, on this screen only:
 * summaries are not saved (open owner question Q-NARR-4's default), and nothing
 * on this card writes the Memory — the owner's title and caption are never
 * changed from here (§28.4, §28.16).
 *
 * THE AI DRAFT is opt-in, and every gate fails closed:
 *   1. the flag `memory_narrative_ai_enabled` (3802, seeded FALSE) — off in the
 *      app's flags, OR off on the server's own answer, and the card shows no AI
 *      control and makes no AI request of any kind;
 *   2. the owner's opt-in (3802's consent row), read from the server: off, and
 *      no draft can be asked for. The switch sits beside, in plain words, exactly
 *      what is sent (the server's payload, field by field — narrativeAiDisclosure.ts)
 *      and the server's own versioned disclosure; turning it on records a grant
 *      of THAT version through PUT, turning it off withdraws through DELETE and
 *      stops every later request;
 *   3. the Memory's own settings: one set to keep it from the model says so.
 * A draft the server accepted is a PROPOSAL, labelled AI. It replaces nothing
 * until the owner taps Insert, and then only the summary on this card — never
 * the owner's title or caption, which stay on screen beside it, verbatim.
 *
 * FAILURE STATES. A refused, unavailable or failed draft leaves the summary as
 * it was and says why, never what the draft said (the server does not return
 * it). Offline: the card shows nothing new — on load it renders nothing; on a
 * tap the summary and the proposal are unchanged and only the connection is
 * mentioned. A failed summary read is said, with a retry; never an empty summary.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import type { Memory } from '../../../services/memories.ts';
import {
  fetchMemoryNarrative, fetchNarrativeAiConsent, grantNarrativeAiConsent, requestAiNarrative, withdrawNarrativeAiConsent,
  type AiOffer, type AiProposal, type ConsentRead, type NarrativeRead, type OriginalText,
} from './memoryNarrativeApi.ts';
import {
  NARRATIVE_AI_NEVER_SENT, NARRATIVE_AI_NEVER_SENT_MEMORIES, NARRATIVE_AI_SENT_KEYS, NARRATIVE_AI_SENT_LABELS, excludedByControlText, fallbackText,
} from './narrativeAiDisclosure.ts';

export interface MemoryNarrativeCardProps {
  memory: Pick<Memory, 'id' | 'updatedAt' | 'items'>;
  isOwner: boolean;
}

const UNAVAILABLE: AiOffer = { available: false, reason: 'unavailable' };

/** The owner's own words, verbatim (H265) — shown beside any AI text. */
function OriginalWords({ original, testID }: { original: OriginalText; testID: string }) {
  if (original.title === null && original.caption === null) return null;
  return (
    <View style={s.original} testID={testID}>
      <Text style={s.caption}>Your words, unchanged</Text>
      {original.title !== null ? <Text style={s.originalText} testID={`${testID}-title`}>{original.title}</Text> : null}
      {original.caption !== null ? <Text style={s.originalText} testID={`${testID}-caption`}>{original.caption}</Text> : null}
    </View>
  );
}

export function MemoryNarrativeCard({ memory, isOwner }: MemoryNarrativeCardProps) {
  const { isEnabled } = useFeatureFlags();
  const flagOn = isEnabled('memory_narrative_ai_enabled');
  const memoryId = memory.id;
  // A reload when the Memory changes under the card (an item added or removed, an edit saved).
  const revision = `${memory.updatedAt ?? ''}|${memory.items?.length ?? -1}`;

  const [read, setRead] = useState<NarrativeRead | null>(null);
  const [offer, setOffer] = useState<AiOffer>(UNAVAILABLE);
  const [aiOff, setAiOff] = useState(false);
  const [consent, setConsent] = useState<ConsentRead | null>(null);
  const [editorText, setEditorText] = useState('');
  const [editorSource, setEditorSource] = useState<'summary' | 'ai'>('summary');
  const [editing, setEditing] = useState(false);
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'draft' | 'consent' | null>(null);
  const touched = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    if (!isOwner) return;
    const r = await fetchMemoryNarrative(memoryId);
    if (!alive.current) return;
    if (r.state === 'ok' && r.narrative.memoryId !== memoryId) {
      setRead({ state: 'error', message: 'The summary could not be loaded.' });
      return;
    }
    setRead(r);
    setProposal(null);
    setAiNote(null);
    if (r.state === 'ok') {
      setOffer(r.ai); // a server that says feature_disabled closes gate 1 through `offerSaysOff`
      if (!touched.current) { setEditorText(r.narrative.summary); setEditorSource('summary'); }
    }
  }, [isOwner, memoryId]);

  useEffect(() => { void load(); }, [load, revision]);

  // Gate 1 then gate 2: the opt-in is read only while the flag is on on both sides.
  const offerSaysOff = offer.available === false && offer.reason === 'feature_disabled';
  const aiGateOpen = isOwner && flagOn && !aiOff && read?.state === 'ok' && !offerSaysOff;
  useEffect(() => {
    if (!aiGateOpen || consent !== null) return;
    let cancelled = false;
    void fetchNarrativeAiConsent().then((c) => { if (!cancelled && alive.current) setConsent(c); });
    return () => { cancelled = true; };
  }, [aiGateOpen, consent]);

  const refreshOffer = useCallback(async () => {
    const r = await fetchMemoryNarrative(memoryId);
    if (!alive.current) return;
    setOffer(r.state === 'ok' ? r.ai : UNAVAILABLE);
  }, [memoryId]);

  const consentOn = consent?.state === 'ok' && consent.consent.enabled;

  const onToggle = useCallback(async (next: boolean) => {
    if (busy || consent?.state !== 'ok') return;
    setBusy('consent');
    setAiNote(null);
    const res = next ? await grantNarrativeAiConsent(consent.consent.currentDisclosureVersion) : await withdrawNarrativeAiConsent();
    if (!alive.current) return;
    setBusy(null);
    if (res.ok) {
      setConsent({ state: 'ok', consent: res.consent });
      if (next) { await refreshOffer(); return; }
      // Withdrawn: nothing more is asked for, and a proposal on screen goes with it.
      setProposal(null);
      setOffer({ available: false, reason: 'consent_required' });
      return;
    }
    if (res.kind === 'feature_disabled') { setAiOff(true); return; }
    if (res.kind === 'stale_disclosure') {
      setConsent(await fetchNarrativeAiConsent());
      setAiNote('The explanation changed. Please read it again before turning this on.');
      return;
    }
    Alert.alert(next ? 'AI drafts were not turned on' : 'AI drafts were not turned off', res.message);
  }, [busy, consent, refreshOffer]);

  const onDraft = useCallback(async () => {
    // The gates, again, at the moment of the request: the flag on both sides, the opt-in, the offer.
    if (busy || !aiGateOpen || !consentOn || offer.available !== true) return;
    setBusy('draft');
    setAiNote(null);
    setProposal(null);
    const r = await requestAiNarrative(memoryId);
    if (!alive.current) return;
    setBusy(null);
    switch (r.state) {
      case 'proposal':
        if (r.proposal.memoryId !== memoryId) { setAiNote('An AI draft could not be made right now.'); return; }
        setProposal(r.proposal);
        return;
      case 'fallback':
        setAiNote(fallbackText(r.reason));
        return;
      case 'refused':
        if (r.reason === 'feature_disabled') { setAiOff(true); return; }
        if (r.reason === 'excluded_by_control') { setOffer({ available: false, reason: 'excluded_by_control', controls: r.controls }); return; }
        if (r.reason === 'consent_required') {
          setOffer({ available: false, reason: 'consent_required' });
          setConsent(await fetchNarrativeAiConsent());
          setAiNote('Turn on AI summary drafts first.');
          return;
        }
        setAiNote(r.message);
        return;
      case 'rate_limited':
        setAiNote(r.message);
        return;
      case 'offline':
        setAiNote("You appear to be offline. Try again when you're connected.");
        return;
      default:
        setAiNote(r.message);
    }
  }, [aiGateOpen, busy, consentOn, memoryId, offer]);

  const insert = useCallback(() => {
    if (!proposal) return;
    touched.current = true;
    setEditorText(proposal.summary);
    setEditorSource('ai');
    setEditing(false);
    setProposal(null);
  }, [proposal]);

  const reset = useCallback(() => {
    if (read?.state !== 'ok') return;
    touched.current = false;
    setEditorText(read.narrative.summary);
    setEditorSource('summary');
    setEditing(false);
  }, [read]);

  if (!isOwner || read === null || read.state === 'not_found' || read.state === 'offline') return null;
  if (read.state === 'error') {
    return (
      <View style={s.wrap} testID="memory-narrative-error">
        <Text style={s.head}>Summary</Text>
        <Text style={s.caption}>The summary could not be loaded.</Text>
        <Pressable onPress={() => void load()} accessibilityRole="button" testID="memory-narrative-retry">
          <Text style={s.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const narrative = read.narrative;
  const changed = editorSource === 'ai' || editorText !== narrative.summary;
  const showAi = aiGateOpen && consent?.state === 'ok' && consent.consent.available;

  return (
    <View style={s.wrap} testID="memory-narrative-card">
      <Text style={s.head}>Summary</Text>
      {editing ? (
        <TextInput
          testID="memory-narrative-editor"
          style={s.editor}
          multiline
          value={editorText}
          onChangeText={(v) => { touched.current = true; setEditorText(v); }}
          accessibilityLabel="Edit the summary"
        />
      ) : (
        <Text style={s.summary} testID="memory-narrative-summary" selectable>{editorText}</Text>
      )}
      {editorSource === 'ai' ? (
        <>
          <Text style={s.badge} testID="memory-narrative-ai-label">AI draft</Text>
          <Text style={s.caption}>You inserted an AI draft. The server checked it against this Memory's details.</Text>
          <OriginalWords original={narrative.originalText} testID="memory-narrative-original" />
        </>
      ) : (
        <Text style={s.caption} testID="memory-narrative-source">Built from this Memory's own details.</Text>
      )}
      <View style={s.row}>
        <Pressable onPress={() => setEditing((e) => !e)} accessibilityRole="button" testID="memory-narrative-edit">
          <Text style={s.link}>{editing ? 'Done' : 'Edit'}</Text>
        </Pressable>
        {changed ? (
          <Pressable onPress={reset} accessibilityRole="button" testID="memory-narrative-reset">
            <Text style={s.link}>Back to the summary from your details</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={s.caption}>Summaries are not saved. Your title and caption are never changed here.</Text>

      {showAi && consent?.state === 'ok' ? (
        <View style={s.ai} testID="memory-narrative-ai">
          <View style={s.switchRow}>
            <Text style={s.bodyStrong}>AI summary drafts</Text>
            <Switch
              testID="memory-narrative-ai-consent-toggle"
              value={consent.consent.enabled}
              onValueChange={(v) => void onToggle(v)}
              disabled={busy !== null}
              accessibilityLabel="AI summary drafts"
              accessibilityHint="Lets you ask for an AI draft of this summary. Off by default."
            />
          </View>
          <Text style={s.caption}>
            When you ask for a draft, Portava sends these facts about that one Memory to OpenAI, through our hosting provider's AI integration:
          </Text>
          {NARRATIVE_AI_SENT_KEYS.map((k) => (
            <Text key={k} style={s.bullet} testID={`memory-narrative-ai-sent-${k}`}>{`• ${NARRATIVE_AI_SENT_LABELS[k]}`}</Text>
          ))}
          <Text style={s.caption} testID="memory-narrative-ai-never-sent">{`Never sent: ${NARRATIVE_AI_NEVER_SENT.join(', ').toLowerCase()}.`}</Text>
          <Text style={s.caption} testID="memory-narrative-ai-never-memories">{NARRATIVE_AI_NEVER_SENT_MEMORIES}</Text>
          <Text style={s.caption}>A draft is checked against those facts, shown only to you, and not saved. Turning this off stops anything more being sent.</Text>
          {consent.consent.enabled ? null : (
            <Text style={s.disclosure} testID="memory-narrative-ai-disclosure">{consent.consent.disclosureText}</Text>
          )}
          {consentOn ? (
            offer.available === true ? (
              <Pressable
                style={[s.button, busy !== null && s.dim]}
                onPress={() => void onDraft()}
                disabled={busy !== null}
                accessibilityRole="button"
                testID="memory-narrative-ai-draft"
              >
                {busy === 'draft' ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.buttonText}>Draft with AI</Text>}
              </Pressable>
            ) : offer.reason === 'excluded_by_control' ? (
              <Text style={s.caption} testID="memory-narrative-ai-excluded">{excludedByControlText(offer.controls)}</Text>
            ) : (
              <Text style={s.caption} testID="memory-narrative-ai-unavailable">AI drafts can't be checked for this Memory right now.</Text>
            )
          ) : null}
          {aiNote ? <Text style={s.caption} testID="memory-narrative-ai-note">{aiNote}</Text> : null}
          {proposal ? (
            <View style={s.proposal} testID="memory-narrative-ai-proposal">
              <Text style={s.badge}>AI draft</Text>
              <Text style={s.summary} testID="memory-narrative-ai-proposal-text">{proposal.summary}</Text>
              <Text style={s.caption}>Checked by the server against this Memory's details. Nothing changes unless you insert it.</Text>
              <OriginalWords original={narrative.originalText} testID="memory-narrative-ai-proposal-original" />
              <View style={s.row}>
                <Pressable onPress={insert} accessibilityRole="button" testID="memory-narrative-ai-insert">
                  <Text style={s.link}>Insert into the summary</Text>
                </Pressable>
                <Pressable onPress={() => setProposal(null)} accessibilityRole="button" testID="memory-narrative-ai-dismiss">
                  <Text style={s.link}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  head: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  summary: { ...(t.body as object), color: color.ink },
  editor: {
    ...(t.body as object), color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.sm, minHeight: 88, textAlignVertical: 'top', backgroundColor: color.paperRaised,
  },
  caption: { ...(t.small as object), color: color.mute },
  bullet: { ...(t.small as object), color: color.ink },
  disclosure: { ...(t.small as object), color: color.ink, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.sm },
  badge: { ...(t.small as object), color: color.deep, fontWeight: '700' },
  link: { ...(t.small as object), color: color.deep, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  ai: { marginTop: space.sm, gap: space.sm, borderTopWidth: 1, borderColor: color.haze, paddingTop: space.md },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink, flexShrink: 1 },
  button: { alignSelf: 'flex-start', borderWidth: 1, borderColor: color.ink, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.md },
  buttonText: { ...(t.small as object), color: color.ink, fontWeight: '700' },
  proposal: { gap: space.xs, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.sm, backgroundColor: color.paperRaised },
  original: { gap: 2, borderLeftWidth: 2, borderColor: color.haze, paddingLeft: space.sm },
  originalText: { ...(t.small as object), color: color.ink },
  dim: { opacity: 0.5 },
});
