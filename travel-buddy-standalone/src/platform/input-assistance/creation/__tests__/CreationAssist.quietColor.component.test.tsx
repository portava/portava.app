/**
 * CreationAssist's optional `quietColor` (census-media §31.13).
 *
 * The creation notice draws two tertiary marks in `faint`: the correction
 * banner's dismiss icon, and a duplicate row's "why this matched" reason. On
 * the add-gem sheet's `paperRaised` card both read 2.88:1. Without the prop
 * nothing changes for any screen. The add-gem sheet passes `mute` (5.55:1),
 * which CreationAssist hands to CorrectionBanner as `dismissColor` and to
 * EntitySuggestionRow as `reasonColor`.
 *
 * The lucide stand-in drops `color` from the rendered tree, so the icon's
 * colour is read from the component instance instead.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { CreationAssist } from '../CreationAssist.tsx';
import { CorrectionBanner } from '../../components/CorrectionBanner.tsx';
import { EntitySuggestionRow } from '../../components/EntitySuggestionRow.tsx';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { DuplicateCandidate } from '../duplicateDetection.ts';
import type { CreationValidationView } from '../creationValidation.ts';
import { color } from '../../../../theme/tokens.ts';

const REASON = 'Same name, 40 m away';
const suggestion: InputSuggestion = {
  id: 's1', type: 'entity', context: 'place_picker', label: 'Warung Bu Oka', entityType: 'place', entityId: 's1',
  subtitle: 'Ubud', reason: REASON, source: 'canonical', policyVersion: 'test',
};
const duplicate: DuplicateCandidate = {
  entityId: 's1', entityType: 'place', label: suggestion.label, subtitle: 'Ubud', reason: REASON,
  confidence: null, route: null, source: suggestion.source, suggestion,
};
const validation = {
  kind: 'duplicate_warning', tone: 'warning', message: 'A gem with this name exists nearby.',
  correctionText: null, acceptLabel: null, suggestion,
} as unknown as CreationValidationView;

async function mount(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  await act(async () => { tr = TestRenderer.create(el); });
  const dismiss = tr.root.findAll((n) => n.props.accessibilityLabel === 'Dismiss' && n.props.accessibilityRole === 'button')[0];
  const xIcon = dismiss?.findAll((n) => typeof n.type === 'function' && n.props.size !== undefined && 'color' in n.props)[0];
  const isText = (n: ReactTestInstance) => (n.type as unknown) === 'Text';
  const reason = tr.root.findAll((n) => isText(n) && n.props.children === REASON)[0];
  const message = tr.root.findAll((n) => isText(n) && n.props.children === validation.message)[0];
  return {
    dismissColor: xIcon?.props.color as string | undefined,
    reasonColor: reason ? StyleSheet.flatten(reason.props.style).color : undefined,
    messageColor: message ? StyleSheet.flatten(message.props.style).color : undefined,
  };
}

describe('CreationAssist quietColor', () => {
  it('without it, the dismiss icon and the reason stay `faint`', async () => {
    const m = await mount(<CreationAssist duplicates={[duplicate]} validation={validation} />);
    expect(m).toEqual({ dismissColor: color.faint, reasonColor: color.faint, messageColor: color.ink });
  });
  it('with it, both take the given colour and nothing else changes', async () => {
    const m = await mount(<CreationAssist duplicates={[duplicate]} validation={validation} quietColor={color.mute} />);
    expect(m).toEqual({ dismissColor: color.mute, reasonColor: color.mute, messageColor: color.ink });
  });
  it('CorrectionBanner and EntitySuggestionRow take the colour directly, and keep `faint` without it', async () => {
    expect((await mount(<CorrectionBanner message={validation.message} onDismiss={() => {}} />)).dismissColor).toBe(color.faint);
    expect((await mount(<CorrectionBanner message={validation.message} onDismiss={() => {}} dismissColor={color.mute} />)).dismissColor).toBe(color.mute);
    expect((await mount(<EntitySuggestionRow suggestion={suggestion} onPress={() => {}} />)).reasonColor).toBe(color.faint);
    expect((await mount(<EntitySuggestionRow suggestion={suggestion} onPress={() => {}} reasonColor={color.mute} />)).reasonColor).toBe(color.mute);
  });
});
