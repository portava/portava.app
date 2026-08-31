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

export function SuggestionList({ suggestions, onSelect, activeId, renderLeading, testID }: SuggestionListProps) {
  return (
    <View testID={testID}>
      {suggestions.map((s) =>
        s.type === 'action' ? (
          <ActionSuggestionRow
            key={s.id}
            suggestion={s}
            onAction={onSelect}
            active={activeId === s.id}
          />
        ) : s.type === 'ai_suggestion' ? (
          // §22 — an AI proposal is tap-to-insert (never auto-applied). In the
          // shared overlay the consumer's onSelect performs the editable insert.
          <AiSuggestionRow
            key={s.id}
            suggestion={s}
            onInsert={onSelect}
            active={activeId === s.id}
          />
        ) : (
          <EntitySuggestionRow
            key={s.id}
            suggestion={s}
            onPress={onSelect}
            active={activeId === s.id}
            leading={renderLeading?.(s)}
          />
        ),
      )}
    </View>
  );
}
