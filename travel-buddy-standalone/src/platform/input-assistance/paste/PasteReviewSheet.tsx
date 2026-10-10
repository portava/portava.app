/**
 * Global Input Intelligence — §24 Paste Intelligence: the REVIEW SCREEN
 * (flow GII-F08, census G154–G157, G161, G162).
 *
 *   paste → "Find places" → the server classifies it and resolves every item
 *   through the shared gateway (it writes nothing) → THIS SCREEN shows each item
 *   with its status and candidates → the person ticks what they want →
 *   "Add N" → `onConfirm` persists exactly those, through the field's own path.
 *
 * §24: "Bulk extraction must always lead to a review screen before persistent
 * mutation." Nothing reaches `onConfirm` without a tap on the confirm button,
 * and a partial answer is never pre-ticked (see `pasteReview.ts`).
 *
 * Every state is true: reading → a spinner; a failed read → the reason and
 * Retry (never an empty review); per item, `failed` / `no_match` /
 * `unsupported` each say which one it is; a write that fails comes back and
 * stays on screen with Retry.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, AlertTriangle, MapPin } from 'lucide-react-native';
import { color, icon as iconToken, radius, space, type as t } from '../../../theme/tokens.ts';
import type { InputContext } from '../types/inputContext.ts';
import { extractPastedEntities } from './pasteExtraction.ts'; import { usePrefersReducedMotion } from '../components/reducedMotion.ts';
import {
  acceptedDestinations,
  destinationFromCandidate,
  initialSelection,
  itemStatusCopy,
  reviewSummary,
  toggleSelection,
  type PasteDestination,
  type PasteExtraction,
  type PasteSelection,
} from './pasteReview.ts';

export interface PasteReviewSheetProps {
  visible: boolean;
  context: InputContext;
  fieldId: string;
  /** What the confirm button adds, e.g. "destination". */
  noun?: string;
  onClose: () => void;
  /**
   * Persist exactly the ticked destinations. Resolve with the ones that could
   * NOT be saved (empty when all were); they stay on screen with Retry.
   */
  onConfirm: (destinations: PasteDestination[]) => Promise<PasteDestination[]>;
  /** Optional input accessory rendered beside the paste box (e.g. a dictation button). */
  renderInputAccessory?: (append: (text: string) => void) => React.ReactNode;
}

type Phase = 'compose' | 'extracting' | 'error' | 'review' | 'applying';

export function PasteReviewSheet({
  visible,
  context,
  fieldId,
  noun = 'destination',
  onClose,
  onConfirm,
  renderInputAccessory,
}: PasteReviewSheetProps) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('compose');
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [extraction, setExtraction] = useState<PasteExtraction | null>(null);
  const [selection, setSelection] = useState<PasteSelection>({});
  const [applyFailed, setApplyFailed] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  // §46 census G351: the OS "reduce motion" setting stops the slide.
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!visible) {
      abortRef.current?.abort();
      setText('');
      setPhase('compose');
      setError(null);
      setExtraction(null);
      setSelection({});
      setApplyFailed(0);
    }
  }, [visible]);

  const extract = useCallback(async () => {
    const pasted = text.trim();
    if (!pasted) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase('extracting');
    setError(null);
    setApplyFailed(0);
    const res = await extractPastedEntities({ context, fieldId, text: pasted }, ctrl.signal);
    if (ctrl.signal.aborted) return;
    if (!res.ok) {
      setError({ message: res.error, retryable: res.retryable });
      setPhase('error');
      return;
    }
    setExtraction(res.data);
    setSelection(initialSelection(res.data.items));
    setPhase('review');
  }, [text, context, fieldId]);

  const chosen = useMemo(
    () => (extraction ? acceptedDestinations(extraction.items, selection) : []),
    [extraction, selection],
  );
  const summary = useMemo(() => (extraction ? reviewSummary(extraction.items) : null), [extraction]);

  const confirm = useCallback(async () => {
    if (!extraction || chosen.length === 0) return;
    setPhase('applying');
    let failed: PasteDestination[];
    try {
      failed = await onConfirm(chosen);
    } catch {
      failed = chosen;
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    // Keep ONLY what failed ticked, so Retry re-sends those and nothing twice.
    const failedIdx = new Set(failed.map((d) => d.itemIndex));
    setSelection((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => failedIdx.has(Number(k)))));
    setApplyFailed(failed.length);
    setPhase('review');
  }, [extraction, chosen, onConfirm, onClose]);

  const append = useCallback((more: string) => {
    setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${more}` : more));
  }, []);

  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      testID="paste-review-modal"
    >
      <View style={styles.screen} testID="paste-review-sheet" accessibilityViewIsModal>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {phase === 'review' || phase === 'applying' ? 'Review before adding' : 'Paste a list, link or coordinates'}
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} testID="paste-close">
            <Text style={styles.link}>Close</Text>
          </Pressable>
        </View>

        {phase === 'compose' || phase === 'error' ? (
          <View style={styles.body}>
            <Text style={styles.help}>
              One stop per line, a Google Maps, Apple Maps or OpenStreetMap link, or coordinates. Nothing is added until you review it.
            </Text>
            <View style={styles.inputRow}>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                placeholder={'Da Nang\nHoi An\nhttps://maps.google.com/…'}
                placeholderTextColor={color.faint}
                style={styles.input}
                accessibilityLabel="Pasted list, link or coordinates"
                testID="paste-input"
                autoCorrect={false}
              />
              {renderInputAccessory ? renderInputAccessory(append) : null}
            </View>
            {phase === 'error' && error ? (
              <View style={styles.errorBox} accessibilityRole="alert" testID="paste-error">
                <AlertTriangle size={iconToken.s16} color={color.signal} />
                <Text style={styles.errorText}>{error.message}</Text>
              </View>
            ) : null}
            <Pressable
              onPress={extract}
              disabled={!text.trim()}
              accessibilityRole="button"
              accessibilityState={{ disabled: !text.trim() }}
              style={[styles.primary, !text.trim() && styles.disabled]}
              testID={phase === 'error' ? 'paste-retry' : 'paste-extract'}
            >
              <Text style={styles.primaryText}>{phase === 'error' && error?.retryable ? 'Try again' : 'Find places'}</Text>
            </Pressable>
          </View>
        ) : null}

        {phase === 'extracting' ? (
          <View style={styles.center} testID="paste-loading">
            <ActivityIndicator color={color.signal} />
            <Text style={styles.help}>Reading your paste…</Text>
          </View>
        ) : null}

        {(phase === 'review' || phase === 'applying') && extraction && summary ? (
          <>
            <ScrollView style={styles.list} contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}>
              <Text style={styles.help} testID="paste-summary">
                {summary.resolved} found
                {summary.noMatch ? ` · ${summary.noMatch} not matched` : ''}
                {summary.failed ? ` · ${summary.failed} couldn’t be checked` : ''}
                {summary.unsupported ? ` · ${summary.unsupported} unreadable link${summary.unsupported === 1 ? '' : 's'}` : ''}
              </Text>
              {extraction.truncated ? (
                <Text style={styles.warnText} testID="paste-truncated">Only the first {extraction.items.length} items were read.</Text>
              ) : null}
              {applyFailed > 0 ? (
                <View style={styles.errorBox} accessibilityRole="alert" testID="paste-apply-error">
                  <AlertTriangle size={iconToken.s16} color={color.signal} />
                  <Text style={styles.errorText}>
                    {plural(applyFailed)} couldn’t be added. The others were saved. Try again for these.
                  </Text>
                </View>
              ) : null}
              {extraction.items.map((item) => {
                const note = itemStatusCopy(item);
                const bad = item.status === 'failed' || item.status === 'unsupported';
                return (
                  <View key={item.index} style={styles.item} testID={`paste-item-${item.index}`}>
                    <View style={styles.itemHead}>
                      <Text style={styles.itemText} numberOfLines={2}>{item.query ?? item.raw}</Text>
                      {item.dayLabel || item.timeHint ? (
                        <Text style={styles.meta}>{[item.dayLabel, item.timeHint].filter(Boolean).join(' · ')}</Text>
                      ) : null}
                    </View>
                    {item.candidates.map((c, ci) => {
                      if (!destinationFromCandidate(c)) return null;
                      const checked = selection[item.index] === ci;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => setSelection((prev) => toggleSelection(prev, item.index, ci))}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked }}
                          accessibilityLabel={`${c.label}${c.subtitle ? `, ${c.subtitle}` : ''}`}
                          style={[styles.candidate, checked && styles.candidateOn]}
                          testID={`paste-candidate-${item.index}-${ci}`}
                        >
                          <View style={[styles.box, checked && styles.boxOn]}>
                            {checked ? <Check size={iconToken.s14} color={color.onInk} /> : null}
                          </View>
                          <MapPin size={iconToken.s16} color={color.mute} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.candidateLabel}>{c.label}</Text>
                            {c.subtitle ? <Text style={styles.meta}>{c.subtitle}</Text> : null}
                          </View>
                        </Pressable>
                      );
                    })}
                    {note ? (
                      <Text style={bad ? styles.errorText : styles.meta} testID={`paste-item-status-${item.index}`}>
                        {note}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
            <View style={styles.footer}>
              <Pressable onPress={() => setPhase('compose')} accessibilityRole="button" style={styles.secondary} testID="paste-edit">
                <Text style={styles.link}>Edit paste</Text>
              </Pressable>
              <Pressable
                onPress={confirm}
                disabled={chosen.length === 0 || phase === 'applying'}
                accessibilityRole="button"
                accessibilityState={{ disabled: chosen.length === 0 || phase === 'applying' }}
                style={[styles.primary, styles.grow, (chosen.length === 0 || phase === 'applying') && styles.disabled]}
                testID="paste-confirm"
              >
                {phase === 'applying' ? (
                  <ActivityIndicator color={color.onInk} />
                ) : (
                  <Text style={styles.primaryText}>
                    {applyFailed > 0 ? 'Try again' : chosen.length === 0 ? 'Tick what to add' : `Add ${plural(chosen.length)}`}
                  </Text>
                )}
              </Pressable>
            </View>
          </>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper, paddingTop: space.xxl, paddingHorizontal: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: space.md },
  title: { ...t.heading, color: color.ink, flex: 1 },
  body: { gap: space.md },
  help: { ...t.small, color: color.mute },
  warnText: { ...t.small, color: color.mute },
  inputRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  input: {
    flex: 1,
    minHeight: 140,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    textAlignVertical: 'top',
  },
  errorBox: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  errorText: { ...t.small, color: color.ink, flexShrink: 1 },
  primary: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  disabled: { opacity: 0.45 },
  grow: { flex: 1 },
  secondary: { paddingVertical: space.md, paddingHorizontal: space.md },
  link: { ...t.bodyStrong, color: color.deep },
  center: { alignItems: 'center', gap: space.sm, paddingTop: space.xl },
  list: { flex: 1 },
  item: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  itemText: { ...t.bodyStrong, color: color.ink, flexShrink: 1 },
  meta: { ...t.small, color: color.mute },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  candidateOn: { backgroundColor: `${color.signal}14` },
  candidateLabel: { ...t.body, color: color.ink },
  box: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.mute,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: color.signal, borderColor: color.signal },
  footer: { flexDirection: 'row', gap: space.sm, paddingVertical: space.md, alignItems: 'center' },
});
