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
 *     and screen-reader announcement of field purpose + result count (§46);
 *   - suggestion selection: applies `replacementText` (never silently replaces
 *     more than the field text, §22) and reports the chosen suggestion up.
 *
 * `no_assistance` fields render a plain TextInput (no overlay) — the policy, not
 * the component, decides how much help a field gets (§2 "the field owns
 * behavior").
 */
import React, { forwardRef, useCallback, useMemo, useState } from 'react';
import {
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
import { emitInputEvent } from '../services/inputTelemetry.ts';
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

  const { suggestions, loading, unavailable, policy } = useInputAssistance({
    fieldId,
    text: value,
    context,
    sessionContext,
    enabled: assist && focused,
  });

  const assistEnabled = assist && !!policy && policy.mode !== 'no_assistance';
  const overlayVisible = assistEnabled && focused && (loading || suggestions.length > 0 || unavailable);
  const activeId = activeIndex >= 0 && activeIndex < suggestions.length ? suggestions[activeIndex].id : null;

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
      const result = onSelectSuggestion?.(s);
      // Default: apply replacementText to the field (never touches text outside
      // the field, §22). A caller returning false has handled insertion itself.
      if (result !== false && s.replacementText != null) {
        onChangeText(s.replacementText);
      }
      // §35 Phase 8 — record this EXPLICIT accept as selection memory so the
      // gateway can personalize THIS user's future rank + zero-char recents. It
      // is a fire-and-forget, fail-soft SIDE-EFFECT: it runs only on an explicit
      // accept (never on view/hover/type), never awaits, never throws, and never
      // gates or changes the selection above. `value` is the query that led here.
      recordSuggestionSelection(s, { policy, query: value });
      setActiveIndex(-1);
    },
    [fieldId, policy, onSelectSuggestion, onChangeText, value],
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
        setActiveIndex(-1);
        setFocused(false);
      }
    },
    [onKeyPress, overlayVisible, suggestions, activeIndex, handleSelect],
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
          setFocused(false);
          setActiveIndex(-1);
          onBlur?.(e);
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
