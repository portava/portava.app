/**
 * CaptionAiAssist — census-input-intelligence G141, the client half: the opt-in
 * writing help under a Postcard or Memory caption, through the REAL
 * useAiWritingAssist → useInputAssistance chain with only the network stubbed.
 *
 *   F  `compass_ai_writing_enabled` OFF: nothing renders and nothing is sent,
 *      whatever is typed;
 *   O  ON: a button, and NOTHING is sent until it is tapped;
 *   1  one tap sends the caption as it was at the tap, once — the field id the
 *      screen named, `aiAssist: true`, the AI-only capability declaration, and
 *      the Memory id when there is one; typing afterwards sends nothing until
 *      the next tap;
 *   I  a proposal is inserted only when tapped, into the editable caption, and
 *      the panel closes;
 *   N  an empty answer says so (after the request, never before it);
 *   P  the two field ids resolve to `caption` and are NOT cacheable.
 *
 * Run with: pnpm test:component
 */
import React, { useState } from 'react';
import { TextInput } from 'react-native';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load.
jest.mock('../../platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));

const mockFlags: Record<string, boolean> = {};
// NOTE: intentionally exhaustive — the component reads only `isEnabled`; the
// real provider fetches /api/feature-flags.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

import { requestSuggestions } from '../../platform/input-assistance/services/inputAssistance.ts';
import { CaptionAiAssist, CAPTION_AI_FLAG } from '../CaptionAiAssist.tsx';
import { AI_WRITING_FIELD_IDS } from '../../platform/input-assistance/compass/compassFields.ts';
import { AI_WRITING_ONLY_CAPABILITIES } from '../../platform/input-assistance/contexts/clientCapabilities.ts';
import { resolveFieldPolicy } from '../../platform/input-assistance/contexts/fieldRegistry.ts';
import { isCacheablePrivacyClass } from '../../platform/input-assistance/services/suggestionCache.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../platform/input-assistance/services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, { caption: { debounceMs: 0, privacyClass: 'public', allowAI: true, allowedSuggestionTypes: ['entity', 'ai_suggestion', 'validation'] } });

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const MEM = '55555555-5555-4555-8555-555555555555';

function aiRow(text: string, i = 0) {
  return {
    id: `caption:aiwrite:${i}`, type: 'ai_suggestion', context: 'caption', label: text, replacementText: text,
    action: { type: 'replace_text', text }, confidence: 0.4, source: 'ai', reason: 'AI-suggested draft', policyVersion: 'input-2026-08',
  };
}

/** A caption field with the assist under it, as the screens mount it. */
function Composer({ initial, memoryId, fieldId = AI_WRITING_FIELD_IDS.memoryCaption }: { initial: string; memoryId?: string; fieldId?: string }) {
  const [caption, setCaption] = useState(initial);
  return (
    <>
      <TextInput testID="caption" value={caption} onChangeText={setCaption} />
      <CaptionAiAssist fieldId={fieldId} text={caption} onInsert={setCaption} memoryId={memoryId} testID="cap-ai" />
    </>
  );
}

beforeEach(() => {
  for (const k of Object.keys(mockFlags)) delete mockFlags[k];
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => Promise.resolve({
    ok: true as const, requestId: 'r', policyVersion: 'input-2026-08',
    suggestions: [aiRow('What a great dinner tonight!')] as any,
  }));
});

describe('G141 CaptionAiAssist', () => {
  it('F — flag OFF: no button, and nothing is sent however much is typed', async () => {
    await render(<Composer initial="great dinner tonight" />);
    expect(screen.queryByTestId('cap-ai-button')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('caption'), 'great dinner tonight with views');
    await new Promise((r) => setTimeout(r, 30));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('O — flag ON: the button shows for a non-empty caption, and nothing is sent before the tap', async () => {
    mockFlags[CAPTION_AI_FLAG] = true;
    await render(<Composer initial="" />);
    expect(screen.queryByTestId('cap-ai-button')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('caption'), 'great dinner tonight');
    expect(await screen.findByTestId('cap-ai-button')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('1 — one tap sends that caption once, with the field id, the opt-in, the AI-only declaration and the Memory id', async () => {
    mockFlags[CAPTION_AI_FLAG] = true;
    await render(<Composer initial="great dinner tonight" memoryId={MEM} />);
    await fireEvent.press(await screen.findByTestId('cap-ai-button'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    const req = mockRequest.mock.calls[0]![0] as any;
    expect(req).toMatchObject({
      context: 'caption', fieldId: 'memory.caption', text: 'great dinner tonight', aiAssist: true,
      sessionContext: { memoryId: MEM },
    });
    expect(req.client).toEqual(AI_WRITING_ONLY_CAPABILITIES);
    expect(req.draft).toBeUndefined();
    expect(req.city).toBeUndefined();
    // Typing after the tap sends nothing; the button comes back as "Suggest again".
    await fireEvent.changeText(screen.getByTestId('caption'), 'great dinner tonight!!');
    expect(await screen.findByText('Suggest again')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // …and a second tap asks again, with the new text.
    await fireEvent.press(screen.getByTestId('cap-ai-button'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
    expect((mockRequest.mock.calls[1]![0] as any).text).toBe('great dinner tonight!!');
  });

  it('1b — a Postcard caption names its own field and sends no Memory id', async () => {
    mockFlags[CAPTION_AI_FLAG] = true;
    await render(<Composer initial="great dinner tonight" fieldId={AI_WRITING_FIELD_IDS.postcardCaption} />);
    await fireEvent.press(await screen.findByTestId('cap-ai-button'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    const req = mockRequest.mock.calls[0]![0] as any;
    expect(req.fieldId).toBe('postcard.caption');
    expect(req.sessionContext).toBeUndefined();
  });

  it('I — a proposal goes into the editable caption only when tapped, and the panel closes', async () => {
    mockFlags[CAPTION_AI_FLAG] = true;
    await render(<Composer initial="great dinner tonight" />);
    await fireEvent.press(await screen.findByTestId('cap-ai-button'));
    const proposal = await screen.findByText('What a great dinner tonight!');
    expect(screen.getByTestId('caption').props.value).toBe('great dinner tonight'); // shown, not applied
    await fireEvent.press(proposal);
    expect(screen.getByTestId('caption').props.value).toBe('What a great dinner tonight!');
    expect(screen.queryByTestId('cap-ai-proposals')).toBeNull();
    expect(screen.getByText('Suggest with AI')).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('N — an empty answer says so, and not before the request has run', async () => {
    mockFlags[CAPTION_AI_FLAG] = true;
    let release: (() => void) | null = null;
    mockRequest.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] });
    }));
    await render(<Composer initial="great dinner tonight" memoryId={MEM} />);
    await fireEvent.press(await screen.findByTestId('cap-ai-button'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cap-ai-none')).toBeNull();
    expect(screen.getByText('Drafting a suggestion…')).toBeTruthy();
    release!();
    expect(await screen.findByTestId('cap-ai-none')).toBeTruthy();
  });
});

describe('G141 field registration', () => {
  it('P — postcard.caption and memory.caption resolve to caption and are never cached (owner_only)', () => {
    for (const id of [AI_WRITING_FIELD_IDS.postcardCaption, AI_WRITING_FIELD_IDS.memoryCaption]) {
      const p = resolveFieldPolicy(id);
      expect(p?.context).toBe('caption');
      expect(p?.privacyClass).toBe('owner_only');
      expect(isCacheablePrivacyClass(p?.privacyClass)).toBe(false);
    }
    // post.caption is unchanged: the context's own class.
    expect(resolveFieldPolicy(AI_WRITING_FIELD_IDS.caption)?.privacyClass).toBe('public');
  });
});
