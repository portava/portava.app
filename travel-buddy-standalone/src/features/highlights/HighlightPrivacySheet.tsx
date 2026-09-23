/**
 * HighlightPrivacySheet — where a person actually sets the §10 / §11 controls.
 *
 * Highlights/Memories Development Architecture Spec v1 §10 and §11.
 *
 * WHAT THIS SCREEN CLOSES. The server enforces six resurfacing controls and a
 * location-precision ladder on every Highlight read, and has since
 * migrations 2720 and 2721 were applied to production on 2026-09-15. Until this
 * sheet existed, nobody could set any of them: census §O.2 recorded both tables
 * as "deployed and EMPTY, and they will stay empty". This is the surface that
 * makes them reachable.
 *
 * ── FOUR THINGS IT REFUSES TO DO ───────────────────────────────────────────
 *
 * 1. IT DOES NOT HARD-CODE THE VOCABULARY. The control list, each control's
 *    scope and suppressed surfaces, and both §10 ladders arrive from the
 *    server. §21 requires these operations to stay separate in the UX as well
 *    as the data model, and a client with its own copy of what each control
 *    means is how two of them get collapsed a release later.
 *
 * 2. IT DOES NOT SHOW A SWITCH THAT DOES NOTHING. A control the server names in
 *    `unenforceableOnFeed` is rendered with the limit stated on it. Census H90:
 *    `public.highlights` has no trip reference, so HIDE_TRIP cannot hide ONE
 *    trip; the server withholds the owner's whole proactive surface instead.
 *    That is a real and surprising effect and the person choosing it is told.
 *
 * 3. IT DOES NOT REPORT A FAILED SAVE AS A SAVE. Optimistic state is rolled
 *    back on any non-ok result and the reason is shown. A privacy toggle that
 *    springs back silently is how somebody concludes a Memory is protected when
 *    the write never landed — which is the whole failure mode the server's
 *    `feature_disabled` / `degraded_unavailable` split exists to surface.
 *
 * 4. IT DOES NOT LET ONE TAP UNDO THE STRONGEST CONTROL. Clearing
 *    KEEP_PRIVATE_FOREVER goes through a confirmation, and the server refuses
 *    it without one, so a client that skipped the prompt would get a 400 rather
 *    than quietly reversing the decision.
 *
 * 5. IT DOES NOT OFFER A CONSENT SWITCH NOBODY READS. §10 names five consent
 *    dimensions and the schema stores all five, but only the ones the server
 *    reports in `consentEnforcement.enforced` are read by a surface a viewer
 *    can observe. Those are the only ones rendered, and WHICH ones they are
 *    comes off the wire — there is no fallback to `consentDimensions`, because
 *    a fallback would put three dead switches on this sheet on exactly the
 *    deployment that could not tell us they were dead.
 *
 *    This section is why the sheet exists at all for §10: `consent_share =
 *    false` is a live withholding gate on every non-owner surface, and before
 *    it there was no user anywhere who could set one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { X, Check, AlertTriangle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow, avatar, icon } from '../../theme/tokens.ts';
import {
  fetchResurfacingControls,
  setResurfacingControl,
  clearResurfacingControl,
  fetchProjectionPolicy,
  saveProjectionPolicy,
  isControlSet,
  highlightScopedControls,
  enforcedConsentDimensions,
  surfacesGatedBy,
  consentChoice,
  type ResurfacingControlsView,
  type ProjectionPolicyView,
  type ResurfacingControl,
  type LocationPrecisionRung,
  type PrivacyErrorKind,
  type ConsentValue,
} from './privacyControlsApi.ts';

/**
 * The four server calls, injectable.
 *
 * Defaulted to the real client so every caller in the app gets the real thing
 * with no wiring, and overridable so a test drives the SHAPES the server can
 * return — including the two failures that must not look alike,
 * `feature_disabled` and `degraded_unavailable` — without a network. This is
 * the pattern TripCloseoutCard already uses for the same reason.
 */
export interface PrivacySheetIO {
  loadControls: typeof fetchResurfacingControls;
  loadPolicy: typeof fetchProjectionPolicy;
  setControl: typeof setResurfacingControl;
  clearControl: typeof clearResurfacingControl;
  savePolicy: typeof saveProjectionPolicy;
}

const REAL_IO: PrivacySheetIO = {
  loadControls: fetchResurfacingControls,
  loadPolicy: fetchProjectionPolicy,
  setControl: setResurfacingControl,
  clearControl: clearResurfacingControl,
  savePolicy: saveProjectionPolicy,
};

interface Props {
  visible: boolean;
  highlightId: string;
  onClose: () => void;
  /** Fired after any control or policy change lands, so a feed can refetch. */
  onChanged?: () => void;
  io?: Partial<PrivacySheetIO>;
  /**
   * How a destructive confirmation is asked. Defaults to a native Alert; a test
   * supplies its own so the KEEP_PRIVATE_FOREVER guard is assertable rather
   * than hidden behind a platform dialog that never resolves under jest.
   */
  confirm?: (title: string, body: string) => Promise<boolean>;
  /** Where a failure is reported. Defaults to a native Alert. */
  notify?: (title: string, body: string) => void;
}

/**
 * What a person is told when a save fails, per reason.
 *
 * `feature_disabled` is PERMANENT on this deployment and deliberately offers no
 * retry; everything else is transient. Saying "try again" for a control that
 * does not exist is how a person keeps tapping something that will never work.
 */
function messageFor(kind: PrivacyErrorKind | undefined, message?: string): string {
  switch (kind) {
    case 'feature_disabled':
      return 'This privacy control is not available on this version of Portava yet.';
    case 'degraded_unavailable':
      return 'We could not save that right now. Please try again in a moment.';
    case 'network_unreachable':
      return 'You appear to be offline. Nothing was changed.';
    case 'not_found':
      return 'This highlight is no longer available.';
    case 'unauthenticated':
      return 'Please sign in again.';
    default:
      return message ?? 'Something went wrong. Nothing was changed.';
  }
}

/** Plain-language labels. Falls back to the server's own name for anything new. */
const CONTROL_LABELS: Partial<Record<ResurfacingControl, string>> = {
  DO_NOT_RESURFACE: 'Don’t resurface this',
  DO_NOT_INCLUDE_IN_RECAPS: 'Keep out of recaps',
  KEEP_PRIVATE_FOREVER: 'Keep private forever',
  RETAIN_BUT_DO_NOT_PERSONALIZE: 'Keep, but don’t personalise from it',
};

/**
 * Plain-language names for the §10 consent dimensions.
 *
 * PARTIAL on purpose, exactly like CONTROL_LABELS above: a dimension this build
 * has never heard of falls back to the server's own name and is still offered.
 * The moment this map decided WHICH dimensions exist, it would be a second copy
 * of a vocabulary `consentEnforcement` is on the wire to own.
 */
const CONSENT_LABELS: Record<string, string> = {
  STORE: 'Storing this memory',
  RESURFACE: 'Bringing this back to me later',
  PERSONALIZE: 'Personalising from it',
  SHARE: 'Showing this to other people',
  CONTRIBUTE_TO_AGGREGATE_INTEL: 'Contributing to travel insights',
};

/** Plain-language names for the surfaces the server names in `bySurface`. */
const SURFACE_LABELS: Record<string, string> = {
  proactive_resurfacing: 'memories we resurface',
  public_projection: 'the public version of this highlight',
  recap: 'recaps',
  personalization: 'personalisation',
};

function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface;
}

const PRECISION_LABELS: Record<LocationPrecisionRung, string> = {
  EXACT: 'Exact spot',
  VENUE: 'The venue',
  NEIGHBORHOOD: 'Neighbourhood',
  CITY: 'City only',
  COUNTRY: 'Country only',
  HIDDEN: 'No location',
};

export function HighlightPrivacySheet({ visible, highlightId, onClose, onChanged, io, confirm, notify }: Props) {
  const api: PrivacySheetIO = { ...REAL_IO, ...io };
  const ask = confirm ?? ((title: string, body: string) => new Promise<boolean>((resolve) => {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Turn off', style: 'destructive', onPress: () => resolve(true) },
    ]);
  }));
  const tell = notify ?? ((title: string, body: string) => Alert.alert(title, body));
  const insets = useSafeAreaInsets();
  const [controls, setControls] = useState<ResurfacingControlsView | null>(null);
  const [policy, setPolicy] = useState<ProjectionPolicyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [c, p] = await Promise.all([api.loadControls(), api.loadPolicy(highlightId)]);
    // A FAILED LOAD IS NOT AN EMPTY SETTINGS SCREEN. Rendering "nothing is set"
    // for an outage invites a person to set a control that is already set, and
    // on the next load they see two. The sheet says it could not read instead.
    if (!c.ok || !p.ok) {
      setControls(null);
      setPolicy(null);
      setLoadError(messageFor(c.ok ? p.errorKind : c.errorKind, c.ok ? p.message : c.message));
      setLoading(false);
      return;
    }
    setControls(c.data);
    setPolicy(p.data);
    setLoading(false);
  }, [highlightId, api.loadControls, api.loadPolicy]);

  useEffect(() => {
    if (!visible || !highlightId) return;
    void load();
  }, [visible, highlightId, load]);

  async function toggleControl(control: ResurfacingControl, currentlySet: boolean) {
    setSaving(control);
    let result;
    if (currentlySet) {
      if (control === 'KEEP_PRIVATE_FOREVER') {
        const confirmed = await ask(
          'Turn off “Keep private forever”?',
          'This highlight could be resurfaced and included in recaps again.',
        );
        if (!confirmed) { setSaving(null); return; }
      }
      result = await api.clearControl(control, highlightId, { confirm: true });
    } else {
      result = await api.setControl(control, highlightId);
    }
    setSaving(null);
    if (!result.ok) {
      tell('Not saved', messageFor(result.errorKind, result.message));
      return;
    }
    // Re-read rather than patching local state: the server is the only thing
    // that knows what is stored, and a toggle that trusts its own optimism is
    // how a screen shows a control as on after the write was rejected.
    await load();
    onChanged?.();
  }

  async function choosePrecision(rung: LocationPrecisionRung | null) {
    setSaving('precision');
    const result = await api.savePolicy(highlightId, { locationPrecision: rung });
    setSaving(null);
    if (!result.ok) {
      tell('Not saved', messageFor(result.errorKind, result.message));
      return;
    }
    setPolicy(result.data);
    onChanged?.();
  }

  /**
   * Record one §10 consent decision.
   *
   * THE PATCH NAMES ONE DIMENSION. `saveProjectionPolicy` treats an ABSENT key
   * as "leave it alone" and a `null` value as "unset it", and the server keeps
   * the same distinction. Sending the whole consent object would mean a client
   * built before a sixth dimension existed resets it to unknown on every save.
   *
   * Then it RE-READS rather than patching local state, for the reason
   * `toggleControl` gives: the server is the only thing that knows what is
   * stored, and a switch that trusts its own optimism is how a screen shows a
   * consent as withheld after the write was rejected.
   */
  async function chooseConsent(dimension: string, next: ConsentValue) {
    setSaving(`consent:${dimension}`);
    const result = await api.savePolicy(highlightId, { consent: { [dimension]: next } });
    setSaving(null);
    if (!result.ok) {
      tell('Not saved', messageFor(result.errorKind, result.message));
      return;
    }
    await load();
    onChanged?.();
  }

  const offered = highlightScopedControls(controls);
  const consentDimensions = enforcedConsentDimensions(policy);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close privacy controls" />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.grab} />
        <View style={s.head}>
          <Text style={s.title}>Privacy</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.loading} testID="highlight-privacy-loading"><ActivityIndicator size="small" color={color.signal} /></View>
        ) : loadError ? (
          <View style={s.empty} testID="highlight-privacy-unavailable">
            <Text style={s.emptyText}>{loadError}</Text>
            <Pressable onPress={() => void load()} style={s.retry} accessibilityRole="button">
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false} testID="highlight-privacy-sheet">
            <Text style={s.section}>Resurfacing</Text>
            {offered.map((entry) => {
              const on = isControlSet(controls, entry.control, highlightId);
              const unenforceable = (controls?.unenforceableOnFeed ?? []).includes(entry.control);
              return (
                <Pressable
                  key={entry.control}
                  onPress={() => void toggleControl(entry.control, on)}
                  disabled={saving !== null}
                  style={s.row}
                  testID={`highlight-privacy-control-${entry.control}`}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on, disabled: saving !== null }}
                  accessibilityLabel={CONTROL_LABELS[entry.control] ?? entry.control}
                >
                  <View style={s.info}>
                    <Text style={s.rowTitle}>{CONTROL_LABELS[entry.control] ?? entry.control}</Text>
                    <Text style={s.rowNote} numberOfLines={3}>{entry.note}</Text>
                    {unenforceable && (
                      <View style={s.warnRow} testID={`highlight-privacy-unenforceable-${entry.control}`}>
                        <AlertTriangle size={12} color={color.mute} />
                        <Text style={s.warn}>
                          This one can’t be applied to a single trip yet — turning it on hides your
                          whole resurfacing feed instead.
                        </Text>
                      </View>
                    )}
                  </View>
                  {saving === entry.control ? (
                    <ActivityIndicator size="small" color={color.signal} />
                  ) : (
                    <View style={[s.check, on && s.checkOn]} testID={`highlight-privacy-control-state-${entry.control}-${on ? 'on' : 'off'}`}>
                      {on && <Check size={14} color={color.paper} />}
                    </View>
                  )}
                </Pressable>
              );
            })}

            <Text style={s.section}>Location shown to others</Text>
            <Text style={s.sectionNote}>
              Your choice can only make the location less precise than your audience already
              allows — it never reveals more.
            </Text>
            {(policy?.locationPrecisionLadder ?? []).map((rung) => {
              const on = policy?.locationPrecision === rung;
              return (
                <Pressable
                  key={rung}
                  onPress={() => void choosePrecision(on ? null : rung)}
                  disabled={saving !== null}
                  style={s.row}
                  testID={`highlight-privacy-precision-${rung}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: saving !== null }}
                  accessibilityLabel={PRECISION_LABELS[rung] ?? rung}
                >
                  <View style={s.info}>
                    <Text style={s.rowTitle}>{PRECISION_LABELS[rung] ?? rung}</Text>
                  </View>
                  <View style={[s.check, on && s.checkOn]} testID={`highlight-privacy-precision-state-${rung}-${on ? 'on' : 'off'}`}>
                    {on && <Check size={14} color={color.paper} />}
                  </View>
                </Pressable>
              );
            })}
            {policy?.locationPrecision == null && (
              <Text style={s.rowNote}>
                No choice saved yet — the location follows who you shared this with.
              </Text>
            )}

            {/* ── §10 consent ────────────────────────────────────────────────
              * Only the dimensions the SERVER marked ENFORCED are offered. The
              * others are storable and read by no surface, and a switch whose
              * effect no viewer can observe is worse than no switch: it is a
              * promise. `enforcedConsentDimensions` reads that list off the
              * wire and has no fallback to `consentDimensions` for exactly
              * that reason.
              */}
            <Text style={s.section}>What this highlight may be used for</Text>
            {consentDimensions.length === 0 ? (
              <Text style={s.rowNote} testID="highlight-privacy-consent-unavailable">
                These choices aren’t available on this version of Portava yet.
              </Text>
            ) : (
              consentDimensions.map((dimension) => {
                const choice = consentChoice(policy, dimension);
                const surfaces = surfacesGatedBy(policy, dimension).map(surfaceLabel);
                const busy = saving === `consent:${dimension}`;
                const label = CONSENT_LABELS[dimension] ?? dimension;
                return (
                  <View key={dimension} style={s.consentRow} testID={`highlight-privacy-consent-${dimension}`}>
                    <View style={s.info}>
                      <Text style={s.rowTitle}>{label}</Text>
                      {surfaces.length > 0 && (
                        <Text style={s.rowNote} testID={`highlight-privacy-consent-surfaces-${dimension}`}>
                          {`Applies to ${surfaces.join(' and ')}.`}
                        </Text>
                      )}
                      {/* The three states are named, because "no answer" and
                        * "no" are different facts: only a stored NO withholds
                        * this highlight, and leaving it unanswered does not. */}
                      <Text
                        style={s.rowNote}
                        testID={`highlight-privacy-consent-state-${dimension}-${choice}`}
                      >
                        {choice === 'granted'
                          ? 'You’ve allowed this.'
                          : choice === 'withheld'
                            ? 'You’ve said no — this is withheld.'
                            : 'You haven’t answered yet, so nothing is withheld.'}
                      </Text>
                    </View>
                    {busy ? (
                      <ActivityIndicator size="small" color={color.signal} />
                    ) : (
                      <View style={s.consentChoices}>
                        {/* Pressing the choice already stored CLEARS it — the
                          * same "press the selected rung to unset" the §10
                          * precision ladder above uses, so a person can take
                          * an answer back rather than only change it. */}
                        <Pressable
                          onPress={() => void chooseConsent(dimension, choice === 'granted' ? null : true)}
                          disabled={saving !== null}
                          style={[s.consentBtn, choice === 'granted' && s.consentBtnOn]}
                          testID={`highlight-privacy-consent-allow-${dimension}`}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: choice === 'granted', disabled: saving !== null }}
                          accessibilityLabel={`Allow: ${label}`}
                        >
                          <Text style={[s.consentBtnText, choice === 'granted' && s.consentBtnTextOn]}>Yes</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void chooseConsent(dimension, choice === 'withheld' ? null : false)}
                          disabled={saving !== null}
                          style={[s.consentBtn, choice === 'withheld' && s.consentBtnOn]}
                          testID={`highlight-privacy-consent-withhold-${dimension}`}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: choice === 'withheld', disabled: saving !== null }}
                          accessibilityLabel={`Don’t allow: ${label}`}
                        >
                          <Text style={[s.consentBtnText, choice === 'withheld' && s.consentBtnTextOn]}>No</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.heading, color: color.ink },
  closeBtn: { width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  loading: { padding: space.xl, alignItems: 'center' },
  empty: { padding: space.xl, alignItems: 'center', gap: space.md },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  retry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  retryText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  list: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  section: { ...t.bodyStrong, color: color.ink, marginTop: space.md },
  sectionNote: { ...t.small, color: color.faint, marginBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  info: { flex: 1, gap: 2 },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowNote: { ...t.small, color: color.faint, fontSize: 11 },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  consentChoices: { flexDirection: 'row', gap: space.xs },
  consentBtn: {
    paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    minWidth: 44, alignItems: 'center',
  },
  consentBtnOn: { backgroundColor: color.signal, borderColor: color.signal },
  consentBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  consentBtnTextOn: { color: color.paper },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 2 },
  warn: { ...t.small, color: color.mute, fontSize: 11, flex: 1 },
  check: {
    width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2,
    borderWidth: 1, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: color.signal, borderColor: color.signal },
});
