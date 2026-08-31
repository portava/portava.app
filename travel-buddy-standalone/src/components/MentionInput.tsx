/**
 * MentionInput — TextInput wrapper with @ and # trigger detection.
 *
 * Detects trigger characters as the user types, debounces 200 ms,
 * fetches suggestions from the tagging service, and fires callbacks
 * so the parent can render a suggestion list above the composer.
 *
 * When the parent selects a suggestion it calls
 * `mentionRef.current?.insertTag(suggestion)` which replaces the trigger
 * token in the text and records the tag span.
 *
 * Usage:
 *   const mentionRef = useRef<MentionInputHandle>(null);
 *   <MentionInput ref={mentionRef} value={text} onChangeText={setText}
 *     onSuggestionsChange={(items, loading) => {...}}
 *     onTagsChange={setTags}
 *     surface="message"
 *   />
 */
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
  useCallback,
  useState,
} from 'react';
import {
  TextInput,
  TextInputProps,
  Text,
  View,
  StyleSheet,
} from 'react-native';
import {
  fetchMentionSuggestions,
  buildDisplayText,
  type AnyMentionSuggestion,
  type TagSpan,
  type MentionSurface,
} from '../services/tagging.ts';
import { shouldApplyMentionResponse } from './mentionRace.ts';
import { color, space, type as t } from '../theme/tokens.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_HASHTAG_CAP: Record<MentionSurface, number> = {
  post: 10,
  comment: 5,
  message: 5,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActiveTrigger {
  char: '@' | '#';
  startIndex: number;
  query: string;
}

export interface MentionInputHandle {
  /** Insert a selected suggestion — replaces the active trigger token. */
  insertTag(suggestion: AnyMentionSuggestion): void;
  /** Dismiss the suggestion list without inserting. */
  dismiss(): void;
  /** Imperative focus. */
  focus(): void;
}

export interface MentionInputProps extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  value: string;
  onChangeText: (text: string) => void;
  /** Fired whenever the suggestions or loading state changes.
   *  Parent should render a MentionSuggestionList based on these. */
  onSuggestionsChange?: (
    suggestions: AnyMentionSuggestion[],
    loading: boolean,
    trigger: ActiveTrigger | null,
  ) => void;
  /** Fired whenever the confirmed tag spans in the draft change. */
  onTagsChange?: (tags: TagSpan[]) => void;
  surface?: MentionSurface;
  /** Override default hashtag cap for this surface. */
  hashtagCap?: number;
}

// ── Trigger detection ─────────────────────────────────────────────────────────

function detectTrigger(text: string, cursor: number): ActiveTrigger | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@' || ch === '#') {
      const query = text.slice(i + 1, cursor);
      if (!/[\s\n]/.test(query)) {
        return { char: ch as '@' | '#', startIndex: i, query };
      }
      return null;
    }
    if (/[\s\n]/.test(ch)) return null;
    i--;
  }
  return null;
}

/** Remove tags whose display text is no longer present in text. */
function reconcileTags(tags: TagSpan[], text: string): TagSpan[] {
  return tags.filter((tag) => text.includes(tag.displayText));
}

// ── Component ─────────────────────────────────────────────────────────────────

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    {
      value,
      onChangeText,
      onSuggestionsChange,
      onTagsChange,
      surface = 'post',
      hashtagCap,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const cap = hashtagCap ?? DEFAULT_HASHTAG_CAP[surface];

    const inputRef = useRef<TextInput>(null);
    const cursorRef = useRef<number>(value.length);
    const activeTriggerRef = useRef<ActiveTrigger | null>(null);
    const insertedTagsRef = useRef<TagSpan[]>([]);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // §33 request cancellation: the in-flight suggestion fetch is aborted when a
    // newer keystroke lands (or the trigger is dismissed), so an older response
    // can never clobber the current one — matching useSearchSuggestions. This is
    // in addition to the start-index stale check below (belt and suspenders).
    const abortRef = useRef<AbortController | null>(null);

    const [capWarning, setCapWarning] = useState(false);

    // ── Imperative handle ──────────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      insertTag(suggestion: AnyMentionSuggestion) {
        const trigger = activeTriggerRef.current;
        if (!trigger) return;

        const displayText = buildDisplayText(suggestion);
        const before = value.slice(0, trigger.startIndex);
        const after = value.slice(cursorRef.current);
        const newText = `${before}${displayText} ${after}`;

        const newTag: TagSpan = { type: suggestion.type, id: suggestion.id, displayText };
        const merged = [...insertedTagsRef.current, newTag];
        const reconciled = reconcileTags(merged, newText);
        insertedTagsRef.current = reconciled;
        onTagsChange?.(reconciled);

        activeTriggerRef.current = null;
        onSuggestionsChange?.([], false, null);

        setCapWarning(
          reconciled.filter((t) => t.type === 'hashtag').length >= cap,
        );
        onChangeText(newText);
      },
      dismiss() {
        activeTriggerRef.current = null;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortRef.current?.abort();
        onSuggestionsChange?.([], false, null);
      },
      focus() {
        inputRef.current?.focus();
      },
    }));

    // ── Fetch ──────────────────────────────────────────────────────────────────

    const scheduleFetch = useCallback(
      (trigger: ActiveTrigger) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        // Cancel any request from an earlier keystroke before the next one starts.
        abortRef.current?.abort();

        const hashtagCount = insertedTagsRef.current.filter((t) => t.type === 'hashtag').length;
        if (trigger.char === '#' && hashtagCount >= cap) {
          onSuggestionsChange?.([], false, null);
          return;
        }

        onSuggestionsChange?.([], true, trigger);

        debounceRef.current = setTimeout(async () => {
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          const results = await fetchMentionSuggestions(trigger, surface, ctrl.signal);
          // Drop a superseded response (a newer keystroke moved the trigger, or
          // the request was aborted) — never let it replace the current list.
          if (
            shouldApplyMentionResponse({
              aborted: ctrl.signal.aborted,
              responseStartIndex: trigger.startIndex,
              activeStartIndex: activeTriggerRef.current?.startIndex ?? null,
            })
          ) {
            onSuggestionsChange?.(results, false, trigger);
          }
        }, 200);
      },
      [cap, surface, onSuggestionsChange],
    );

    // ── Text change handler ────────────────────────────────────────────────────

    function handleChangeText(text: string) {
      onChangeText(text);

      const cursor = cursorRef.current;
      const trigger = detectTrigger(text, cursor);
      activeTriggerRef.current = trigger;

      const reconciled = reconcileTags(insertedTagsRef.current, text);
      if (reconciled.length !== insertedTagsRef.current.length) {
        insertedTagsRef.current = reconciled;
        onTagsChange?.(reconciled);
      }

      const hashtagCount = reconciled.filter((t) => t.type === 'hashtag').length;
      setCapWarning(hashtagCount >= cap);

      if (!trigger) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortRef.current?.abort();
        onSuggestionsChange?.([], false, null);
        return;
      }

      scheduleFetch(trigger);
    }

    // ── Blur: dismiss suggestions ──────────────────────────────────────────────

    function handleBlur(e: any) {
      activeTriggerRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
      onSuggestionsChange?.([], false, null);
      onBlur?.(e);
    }

    // ── Cleanup on unmount ─────────────────────────────────────────────────────

    useEffect(() => {
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortRef.current?.abort();
      };
    }, []);

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
      <View style={styles.wrapper}>
        {capWarning && (
          <Text style={styles.capWarning} numberOfLines={1}>
            Max {cap} hashtag{cap === 1 ? '' : 's'} reached
          </Text>
        )}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          onBlur={handleBlur}
          onSelectionChange={(e) => {
            cursorRef.current = e.nativeEvent.selection.end;
          }}
          {...rest}
        />
      </View>
    );
  },
);

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  capWarning: {
    ...t.small,
    color: color.signal,
    paddingHorizontal: space.sm,
    paddingBottom: 2,
  },
});
