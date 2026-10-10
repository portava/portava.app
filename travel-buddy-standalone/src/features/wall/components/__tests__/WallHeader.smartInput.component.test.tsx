/**
 * Component test: the Wall steer bar consumes Global Input Intelligence and
 * submits the RESOLVED intent (Wall spec §17).
 *
 * A canonical entity chosen from typeahead becomes a STRUCTURED filter (not a
 * raw string); a query completion / free text submits the resolved text. This
 * mocks SmartInput to a thin stub that drives the two handlers WallHeader wires
 * (onSelectSuggestion, onSubmitEditing) so the resolution + submission logic is
 * exercised without the full input-assistance runtime.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — SmartInput's full assistance runtime is not
// needed to prove WallHeader's resolution/submission wiring. The stub renders
// the field plus two "pick" buttons that invoke the real onSelectSuggestion with
// a canonical-entity and a query-completion suggestion.
jest.mock('../../../../platform/input-assistance/components/SmartInput.tsx', () => {
  const ReactLocal = require('react');
  const { View, TextInput, Pressable, Text } = require('react-native');
  const entitySuggestion = {
    id: 's1',
    type: 'entity',
    context: 'global_search',
    label: 'Bangkok',
    entityType: 'city',
    entityId: 'city-bkk',
    source: 'canonical',
    policyVersion: '1',
  };
  const actionSuggestion = {
    // §21 "Open on map" — an ACTION row whose entityId is its target (G134).
    id: 's3',
    type: 'action',
    context: 'global_search',
    label: 'Open on map',
    entityType: 'place',
    entityId: 'p1',
    action: { type: 'open_entity', entityType: 'place', entityId: 'p1' },
    source: 'canonical',
    policyVersion: '1',
  };
  const querySuggestion = {
    id: 's2',
    type: 'completion',
    context: 'global_search',
    label: 'funny travel stories',
    replacementText: 'funny travel stories',
    source: 'local',
    policyVersion: '1',
  };
  return {
    SmartInput: (props: {
      testID?: string;
      value: string;
      onChangeText: (t: string) => void;
      onSubmitEditing?: () => void;
      onSelectSuggestion?: (s: unknown) => void | boolean;
      capabilities?: unknown;
    }) => {
      (globalThis as any).__wallSmartInputCapabilities = props.capabilities;
      return ReactLocal.createElement(
        View,
        null,
        ReactLocal.createElement(TextInput, {
          testID: props.testID,
          value: props.value,
          onChangeText: props.onChangeText,
          onSubmitEditing: props.onSubmitEditing,
        }),
        ReactLocal.createElement(
          Pressable,
          { testID: 'pick-entity', onPress: () => props.onSelectSuggestion?.(entitySuggestion) },
          ReactLocal.createElement(Text, null, 'entity'),
        ),
        ReactLocal.createElement(
          Pressable,
          { testID: 'pick-query', onPress: () => props.onSelectSuggestion?.(querySuggestion) },
          ReactLocal.createElement(Text, null, 'query'),
        ),
        ReactLocal.createElement(
          Pressable,
          { testID: 'pick-action', onPress: () => props.onSelectSuggestion?.(actionSuggestion) },
          ReactLocal.createElement(Text, null, 'action'),
        ),
      );
    },
  };
});

import { WallHeader } from '../WallHeader.tsx';
import { resolveWallIntent } from '../../services/wallSessionIntent.ts';
import type { InputSuggestion } from '../../../../platform/input-assistance/types/inputSuggestion.ts';
import type { ResolvedWallIntent } from '../../services/wallSessionIntent.ts';

describe('WallHeader steer bar → resolved intent (§17)', () => {
  it('submits a canonical entity as a STRUCTURED filter, not a raw string', async () => {
    const onSetIntent = jest.fn();
    await render(<WallHeader onSetIntent={onSetIntent} />);

    fireEvent.press(screen.getByTestId('pick-entity'));

    expect(onSetIntent).toHaveBeenCalledTimes(1);
    const arg = onSetIntent.mock.calls[0][0] as ResolvedWallIntent;
    expect(arg.text).toBe('Bangkok');
    expect(arg.filter).toEqual({
      kind: 'city',
      entityId: 'city-bkk',
      label: 'Bangkok',
      value: 'city',
    });
  });

  it('submits a query completion as resolved text with no filter', async () => {
    const onSetIntent = jest.fn();
    await render(<WallHeader onSetIntent={onSetIntent} />);

    fireEvent.press(screen.getByTestId('pick-query'));

    expect(onSetIntent).toHaveBeenCalledTimes(1);
    const arg = onSetIntent.mock.calls[0][0] as ResolvedWallIntent;
    expect(arg.text).toBe('funny travel stories');
    expect(arg.filter).toBeUndefined();
  });

  it('G134 review: an ACTION row is never read as a feed filter, and the Wall declares it takes no action rows', async () => {
    // MUTATION-PROOF: drop the `type === 'action'` guard in resolveWallIntent →
    // the Open-on-map row becomes a place filter → onSetIntent is called → RED;
    // drop `capabilities={WALL_STEER_CAPABILITIES}` in WallHeader → the declared
    // capabilities are undefined → RED.
    const onSetIntent = jest.fn();
    await render(<WallHeader onSetIntent={onSetIntent} />);
    fireEvent.press(screen.getByTestId('pick-action'));
    expect(onSetIntent).not.toHaveBeenCalled();
    const caps = (globalThis as any).__wallSmartInputCapabilities as { suggestionTypes?: string[] } | undefined;
    expect(caps?.suggestionTypes).toBeDefined();
    expect(caps?.suggestionTypes).not.toContain('action');
    expect(caps?.suggestionTypes).toContain('entity');
  });

  it('submits free text on return with no filter', async () => {
    const onSetIntent = jest.fn();
    await render(<WallHeader onSetIntent={onSetIntent} />);

    // Two act steps: the changeText re-render must commit (so the input's
    // onSubmitEditing closes over the new draft) BEFORE submit fires.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wall-intent-input'), '  food  ');
    });
    await act(async () => {
      fireEvent(screen.getByTestId('wall-intent-input'), 'submitEditing');
    });

    expect(onSetIntent).toHaveBeenCalledWith({ text: 'food' });
  });
});

describe('resolveWallIntent (pure §17)', () => {
  const base = {
    id: 'x',
    context: 'global_search' as const,
    source: 'canonical' as const,
    policyVersion: '1',
  };

  it('maps a canonical place entity to a place filter with the canonical label', () => {
    const s: InputSuggestion = {
      ...base,
      type: 'entity',
      label: 'Sky Bar',
      entityType: 'place',
      entityId: 'pl-1',
    };
    expect(resolveWallIntent(s)).toEqual({
      text: 'Sky Bar',
      filter: { kind: 'place', entityId: 'pl-1', label: 'Sky Bar', value: 'place' },
    });
  });

  it('maps a user entity to a person filter', () => {
    const s: InputSuggestion = {
      ...base,
      type: 'entity',
      label: 'Maya',
      entityType: 'user',
      entityId: 'u-1',
    };
    expect(resolveWallIntent(s).filter?.kind).toBe('person');
  });

  it('returns text-only for a query completion (no entityId)', () => {
    const s: InputSuggestion = {
      ...base,
      source: 'local',
      type: 'completion',
      label: 'random',
      replacementText: 'random',
    };
    expect(resolveWallIntent(s)).toEqual({ text: 'random' });
  });
});

describe('resolveWallIntent — action rows (G134 review)', () => {
  it('an Open-on-map or Add-to-Trip row sets no intent, whatever entity it targets', () => {
    for (const action of [
      { type: 'open_entity', entityType: 'place', entityId: 'p1' },
      { type: 'add_to_trip', entityId: 'city-bkk' },
    ] as const) {
      const s = {
        id: 'a', type: 'action', context: 'global_search', label: 'x', entityType: 'city', entityId: 'city-bkk',
        action, source: 'canonical', policyVersion: '1',
      } as unknown as InputSuggestion;
      expect(resolveWallIntent(s)).toEqual({ text: '' });
    }
  });
});
