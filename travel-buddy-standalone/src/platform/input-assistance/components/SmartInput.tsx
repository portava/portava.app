/**
 * SmartInput — the shared assisted TextInput primitive (spec §39, §27, §33, §46).
 *
 * A drop-in TextInput that consumes a registered field's POLICY (via fieldId)
 * and renders live suggestions through SuggestionOverlay. It is the single
 * primitive the app's ~25 assisted fields migrate onto in later phases; this
 * Phase-1 version is additive and wired to NO existing screen.
 *
 * What it wires for free:
 *   - policy resolution from the field registry (falls back to `context`);
 *   - the shared assistance hook (debounce/cancel/sequence guard/SWR, §33)
 *     with graceful degradation when the endpoint is unavailable (§38);
 *   - overlay visibility tied to focus + non-empty results;
 *   - keyboard navigation (Arrow/Enter/Escape) with an active-row highlight,
 *     and screen-reader announcement of field purpose, result count and the
 *     SELECTION RESULT (§46 — see `selectionAnnouncement` below);
 *   - suggestion selection: applies `replacementText` (never silently replaces
 *     more than the field text, §22) and reports the chosen suggestion up.
 *
 * `no_assistance` fields render a plain TextInput (no overlay) — the policy, not
 * the component, decides how much help a field gets (§2 "the field owns
 * behavior").
 */
import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  View,
  Text,
  TextInput,
  StyleSheet,
  type TextInputProps,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import type { InputContext } from '../types/inputContext.ts';
import type { InputSuggestion, InputSessionContext } from '../types/inputSuggestion.ts';
import { useInputAssistance } from '../hooks/useInputAssistance.ts';
import { SuggestionOverlay } from './SuggestionOverlay.tsx';
import {
  emitInputEvent,
  emitSuggestionsRendered,
  emitValidationShown,
  emitSuggestionsDismissed,
  emitManualValueKept,
  emitRawSearchSubmitted,
  emitCorrectionAccepted,
  emitDisambiguationSelected,
  type TelemetryField,
} from '../services/inputTelemetry.ts';
import { recordSuggestionSelection } from '../services/selectionRecorder.ts';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';

export interface SmartInputProps extends Omit<TextInputProps, 'onChange'> {
  /** Registered field id (or a to-be-registered id used with `context`). */
  fieldId: string;
  /** Fallback context when the field is not pre-registered. */
  context?: InputContext;
  value: string;
  onChangeText: (text: string) => void;
  /** Bounded task/session context forwarded to the server (§16). */
  sessionContext?: InputSessionContext;
  /** Called when a suggestion is accepted. Return false to suppress the default
   *  replacementText application (the caller handled it, e.g. inserted a chip). */
  onSelectSuggestion?: (s: InputSuggestion) => void | boolean;
  /** Accessible label describing the field's PURPOSE (§46). */
  label?: string;
  /** Show suggestions? Defaults to true; false forces plain-input behavior. */
  assist?: boolean;
  /** Max overlay height. */
  overlayMaxHeight?: number;
  /** Empty/no-match content (§37 fallback actions). */
  emptyState?: React.ReactNode;
  /** Optional leading renderer for entity rows (e.g. sanctioned avatar). */
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
}

/**
 * §46 — the sentence a screen reader hears when a suggestion is ACCEPTED.
 *
 * §46 asks for four announcements: field purpose, suggestion count, the active
 * suggestion, "and selection result". The first three were wired; the fourth was
 * not, and its absence is not cosmetic. `handleSelect` emits telemetry, applies
 * the replacement text and closes the overlay — three state changes, none of
 * which a screen-reader user can perceive. What they get is the suggestion list
 * disappearing and silence, with no confirmation that anything was chosen or
 * that the field they are sitting in now holds different text.
 *
 * `applied` is load-bearing rather than decorative: a row that carries
 * `replacementText` rewrites the field under the cursor, and a row that does not
 * (an action, a validation, a caller that handled insertion itself and returned
 * false) leaves it exactly as typed. Announcing "field updated" in the second
 * case would be a false statement about the user's own text, which is worse than
 * saying nothing.
 *
 * Pure and exported so the sentence is testable without a screen reader.
 */
export function selectionAnnouncement(s: InputSuggestion, applied: boolean): string {
  const what = (s.label ?? '').trim() || 'Suggestion';
  return applied ? `${what} selected. Field updated.` : `${what} selected.`;
}

export const SmartInput = forwardRef<TextInput, SmartInputProps>(function SmartInput(
  {
    fieldId,
    context,
    value,
    onChangeText,
    sessionContext,
    onSelectSuggestion,
    label,
    assist = true,
    overlayMaxHeight,
    emptyState,
    renderLeading,
    style,
    onFocus,
    onBlur,
    onKeyPress,
    ...textInputProps
  },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // ── §44/§45 funnel state ────────────────────────────────────────────────────
  // `shownRef` is what is currently in front of the user; `acceptedRef` says
  // whether they took any of it. Together they are what separates the IGNORED
  // arm from the ACCEPTED one — §45 requires both, and only acceptance was ever
  // recorded. Refs, not state: an analytics fact must not cause a re-render.
  const shownRef = useRef<{ signature: string; count: number } | null>(null);
  const acceptedRef = useRef(false);

  const { suggestions, loading, unavailable, policy } = useInputAssistance({
    fieldId,
    text: value,
    context,
    sessionContext,
    enabled: assist && focused,
  });

  const telemetryField: TelemetryField | null = useMemo(
    () => (policy ? { fieldId, context: policy.context, policy: policy.telemetryPolicy } : null),
    [fieldId, policy],
  );

  const assistEnabled = assist && !!policy && policy.mode !== 'no_assistance';
  const overlayVisible = assistEnabled && focused && (loading || suggestions.length > 0 || unavailable);
  const activeId = activeIndex >= 0 && activeIndex < suggestions.length ? suggestions[activeIndex].id : null;

  // ── §44 `suggestion_rendered` / `validation_shown` ──────────────────────────
  // Both were declared and never emitted. This is the funnel's denominator: an
  // impression, keyed by the id-signature of the list, so a re-render of the
  // SAME rows does not inflate the count and a genuinely new list does.
  const renderSignature =
    overlayVisible && suggestions.length > 0 ? suggestions.map((x) => x.id).join('|') : '';
  useEffect(() => {
    if (!telemetryField) return;
    if (renderSignature === '') {
      // A list that WAS shown has gone away. If nothing in it was taken, that is
      // §45's IGNORED arm — the signal the learning loop has never had.
      const prev = shownRef.current;
      if (prev && !acceptedRef.current) {
        emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur');
      }
      shownRef.current = null;
      acceptedRef.current = false;
      return;
    }
    if (shownRef.current?.signature === renderSignature) return;
    shownRef.current = { signature: renderSignature, count: suggestions.length };
    acceptedRef.current = false;
    emitSuggestionsRendered(telemetryField, suggestions);
    const validations = suggestions.filter((x) => x.type === 'validation').length;
    if (validations > 0) emitValidationShown(telemetryField, validations);
    // `suggestions` is addressed through renderSignature, which is its identity
    // for this purpose; depending on the array itself would re-fire on every
    // re-render that produced an equal list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSignature, telemetryField]);

  const handleSelect = useCallback(
    (s: InputSuggestion) => {
      if (policy) {
        emitInputEvent(
          'suggestion_selected',
          fieldId,
          policy.context,
          { suggestionType: s.type, source: s.source },
          policy.telemetryPolicy,
        );
      }
      // §44 — the per-KIND acceptance events, each declared and never emitted.
      // They are not redundant with `suggestion_selected`: §57 asks for a
      // wrong-selection reversal rate and a duplicate-prevention count, and both
      // need to know WHICH kind of row resolved the field, not merely that one
      // did. `acceptedRef` closes the impression so the dismissal branch above
      // cannot also count this list as ignored.
      acceptedRef.current = true;
      if (telemetryField) {
        if (s.type === 'correction') emitCorrectionAccepted(telemetryField, s);
        if (s.type === 'disambiguation') emitDisambiguationSelected(telemetryField, s);
        if (s.action?.type === 'submit_search') {
          emitRawSearchSubmitted(telemetryField, (s.replacementText ?? value ?? '').length, true);
        }
      }
      const result = onSelectSuggestion?.(s);
      // Default: apply replacementText to the field (never touches text outside
      // the field, §22). A caller returning false has handled insertion itself.
      const applied = result !== false && s.replacementText != null;
      if (applied) {
        onChangeText(s.replacementText as string);
      }
      // §46 — announce the SELECTION RESULT. The overlay is about to close; on a
      // screen reader that is the disappearance of the live region that had been
      // reading the list, and nothing replaces it. This is the replacement.
      // Wrapped because an announcement must never be able to break a selection:
      // `announceForAccessibility` is a native bridge call and a platform where
      // it is unavailable must cost the user nothing.
      try {
        AccessibilityInfo.announceForAccessibility(selectionAnnouncement(s, applied));
      } catch {
        // best-effort — assistive announcement failure is never a UX failure
      }
      // §35 Phase 8 — record this EXPLICIT accept as selection memory so the
      // gateway can personalize THIS user's future rank + zero-char recents. It
      // is a fire-and-forget, fail-soft SIDE-EFFECT: it runs only on an explicit
      // accept (never on view/hover/type), never awaits, never throws, and never
      // gates or changes the selection above. `value` is the query that led here.
      recordSuggestionSelection(s, { policy, query: value });
      setActiveIndex(-1);
    },
    [fieldId, policy, telemetryField, onSelectSuggestion, onChangeText, value],
  );

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      onKeyPress?.(e);
      if (!overlayVisible || suggestions.length === 0) return;
      const key = e.nativeEvent.key;
      if (key === 'ArrowDown') {
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (key === 'ArrowUp') {
        setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      } else if (key === 'Enter') {
        if (activeIndex >= 0 && activeIndex < suggestions.length) {
          handleSelect(suggestions[activeIndex]);
        }
      } else if (key === 'Escape') {
        if (telemetryField && shownRef.current && !acceptedRef.current) {
          emitSuggestionsDismissed(telemetryField, shownRef.current.count, 'escape');
          shownRef.current = null;
        }
        setActiveIndex(-1);
        setFocused(false);
      }
    },
    [onKeyPress, overlayVisible, suggestions, activeIndex, handleSelect, telemetryField],
  );

  const a11yLabel = label ?? textInputProps.placeholder ?? fieldId;

  const mergedSessionAnnounce = useMemo(
    () => (overlayVisible ? `${suggestions.length} suggestions available` : undefined),
    [overlayVisible, suggestions.length],
  );

  return (
    <View style={styles.wrap}>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        style={[styles.input, style]}
        placeholderTextColor={color.faint}
        accessibilityLabel={a11yLabel}
        accessibilityHint={mergedSessionAnnounce}
        // Suggestions come from the platform layer; suppress the OS autocomplete
        // bar so the two don't fight for the space above the keyboard.
        autoCorrect={textInputProps.autoCorrect ?? false}
        autoCapitalize={textInputProps.autoCapitalize ?? 'none'}
        onFocus={(e) => {
          setFocused(true);
          if (policy) emitInputEvent('input_opened', fieldId, policy.context, undefined, policy.telemetryPolicy);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          // §44 `manual_value_kept` — the EDITED arm of §45's loop: the field
          // had assistance in front of it and the user kept their own text. It
          // carries a LENGTH, never the text, so it is emittable on a caption or
          // a private message whose policy forbids raw capture.
          if (telemetryField && shownRef.current && !acceptedRef.current && value.trim().length > 0) {
            emitManualValueKept(telemetryField, value.trim().length);
          }
          setFocused(false);
          setActiveIndex(-1);
          onBlur?.(e);
        }}
        onSubmitEditing={(e) => {
          // §44 `raw_search_submitted` — submitted as typed, resolving nothing.
          if (telemetryField && value.trim().length > 0 && !acceptedRef.current) {
            emitRawSearchSubmitted(telemetryField, value.trim().length, false);
          }
          textInputProps.onSubmitEditing?.(e);
        }}
        onKeyPress={handleKeyPress}
        {...textInputProps}
      />

      {overlayVisible ? (
        <View style={styles.overlayHost}>
          <SuggestionOverlay
            visible
            loading={loading}
            unavailable={unavailable}
            suggestions={suggestions}
            onSelect={handleSelect}
            activeId={activeId}
            renderLeading={renderLeading}
            grouped={policy?.mode === 'search'}
            emptyState={emptyState}
            maxHeight={overlayMaxHeight}
          />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  input: {
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  overlayHost: {
    marginTop: space.xs,
  },
});
