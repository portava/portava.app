/**
 * SuggestionList — renders a flat list of InputSuggestions, dispatching each to
 * the correct row primitive by assistance type (spec §13 "typed objects, no
 * dead rows"). Entity/recent/personalized/disambiguation → EntitySuggestionRow;
 * action → ActionSuggestionRow; ai_suggestion → AiSuggestionRow (§22 opt-in,
 * provenance-marked, tap-to-insert). `activeId` drives the keyboard-active
 * highlight (§46). A single `onSelect` receives the chosen suggestion; the
 * consumer maps it to a SuggestionAction / entity open / editable-text insert.
 */
import React from 'react';
import { View } from 'react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { EntitySuggestionRow } from './EntitySuggestionRow.tsx';
import { ActionSuggestionRow } from './ActionSuggestionRow.tsx';
import { AiSuggestionRow } from './AiSuggestionRow.tsx';

export interface SuggestionListProps {
  suggestions: InputSuggestion[];
  onSelect: (s: InputSuggestion) => void;
  /** id of the currently keyboard-active suggestion, if any. */
  activeId?: string | null;
  /** Optional per-suggestion leading renderer (e.g. hydrated avatar). */
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
  testID?: string;
}

export interface SuggestionRowProps {
  suggestion: InputSuggestion;
  onSelect: (s: InputSuggestion) => void;
  activeId?: string | null;
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
}

/**
 * A SINGLE suggestion row, dispatched by assistance type.
 *
 * Extracted from `SuggestionList`'s map so that a VIRTUALIZED container can
 * render one row at a time without re-implementing the type dispatch (§33
 * "virtualize large suggestion groups"). `SuggestionList` below is now this
 * component mapped — the two can never disagree about what an `action` or an
 * `ai_suggestion` row looks like, because there is only one answer.
 */
export function SuggestionRow({ suggestion: s, onSelect, activeId, renderLeading }: SuggestionRowProps) {
  if (s.type === 'action') {
    return <ActionSuggestionRow suggestion={s} onAction={onSelect} active={activeId === s.id} />;
  }
  if (s.type === 'ai_suggestion') {
    // §22 — an AI proposal is tap-to-insert (never auto-applied). In the
    // shared overlay the consumer's onSelect performs the editable insert.
    return <AiSuggestionRow suggestion={s} onInsert={onSelect} active={activeId === s.id} />;
  }
  return (
    <EntitySuggestionRow
      suggestion={s}
      onPress={onSelect}
      active={activeId === s.id}
      leading={renderLeading?.(s)}
    />
  );
}

export function SuggestionList({ suggestions, onSelect, activeId, renderLeading, testID }: SuggestionListProps) {
  return (
    <View testID={testID}>
      {suggestions.map((s) => (
        <SuggestionRow
          key={s.id}
          suggestion={s}
          onSelect={onSelect}
          activeId={activeId}
          renderLeading={renderLeading}
        />
      ))}
    </View>
  );
}
