/**
 * PostcardComposer mounts the G141 caption assist (census-input-intelligence
 * G141; B58 IN-G141). Drives the real composer through pick → caption → Post:
 *
 *   - flag OFF: no "Suggest with AI", no suggestion request, and the Postcard
 *     posts the caption as typed — the composer is unchanged;
 *   - flag ON: one tap sends the caption as `postcard.caption` with the opt-in
 *     and the AI-only declaration (no Memory id, no draft, no city); a proposal
 *     reaches the caption only when tapped, and the Postcard posts what the
 *     caption then holds.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import type * as ImagePickerNS from 'expo-image-picker';

let resolvePick: ((assets: ImagePickerNS.ImagePickerAsset[] | null) => void) | null = null;
const mockPickMedia = jest.fn(() =>
  new Promise<ImagePickerNS.ImagePickerAsset[] | null>((resolve) => {
    resolvePick = resolve;
  }),
);

// NOTE: intentionally exhaustive — useMediaPicker is the only export used.
jest.mock('../../hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({ pickMedia: mockPickMedia }),
}));

// NOTE: intentionally exhaustive — useSafeAreaInsets is the only export used.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — a pass-through scroll wrapper.
jest.mock('../ui/KeyboardSafeView', () => ({
  KeyboardSafeView: ({ children }: any) => children,
}));

const mockCompleteUpload = jest.fn(async (..._args: unknown[]) => ({ ok: true, data: { ok: true, mediaCount: 1, hasVideo: true } }));
const mockDiscard = jest.fn(async (..._args: unknown[]) => undefined);
// NOTE: intentionally exhaustive — every postcards export the composer calls
// is stubbed so the upload path runs with no network.
jest.mock('../../services/postcards.ts', () => ({
  validatePostcardMedia: jest.fn(() => ({ ok: true })),
  createPostcard: jest.fn(async () => ({ ok: true, data: { id: 'post-1' } })),
  discardPostcardShell: (...args: unknown[]) => mockDiscard(...args),
  getUploadUrl: jest.fn(async () => ({ ok: true, data: { mediaId: 'media-1', uploadUrl: 'https://storage.test/u', path: 'u/post-1/media-1.mp4' } })),
  uploadToSignedUrl: jest.fn(async () => ({ ok: true })),
  completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
}));

const mockUploadVideoPoster = jest.fn(async (..._args: unknown[]) => 'u/post-1/media-1.mp4.poster.jpg');
// NOTE: intentionally exhaustive — the two uploadHttp exports the composer uses.
jest.mock('../../services/media/uploadHttp.ts', () => ({
  uploadVideoPoster: (...args: unknown[]) => mockUploadVideoPoster(...args),
  readFileBlob: async () => ({ size: 3_300_000 }),
}));

type Prepared = { ok: true; resized: boolean; asset: Record<string, unknown> } | { ok: false; message: string };
const mockPrepare = jest.fn(async (a: Record<string, unknown>): Promise<Prepared> => ({ ok: true, resized: false, asset: a }));
jest.mock('../../services/media/mediaProcessing.ts', () => ({
  ...jest.requireActual('../../services/media/mediaProcessing.ts'),
  prepareImageForUpload: (a: Record<string, unknown>) => mockPrepare(a),
}));

// NOTE: intentionally exhaustive — validateMedia gates video duration at pick time.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
}));

// NOTE: intentionally exhaustive — the place picker is a full modal.
jest.mock('../selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: intentionally exhaustive — the stamp sheet queries stamps.
jest.mock('../StampPickerSheet', () => ({
  StampPickerSheet: () => null,
}));

// NOTE: intentionally exhaustive — SVG overlay never shown for a video.
jest.mock('../StampOverlayBadge', () => ({
  StampOverlayBadge: () => null,
}));

// NOTE: intentionally exhaustive — layout math and constants only.
jest.mock('../../lib/stampOverlay.ts', () => ({
  clamp: jest.fn((v: number, min: number, max: number) => Math.min(Math.max(v, min), max)),
  clampOverlayPosition: jest.fn((x: number, y: number) => ({ x, y })),
  completePayloadFromDraft: jest.fn(() => ({})),
  draftFromOption: jest.fn((opt: any) => ({ ...opt, x: 0.5, y: 0.5, scale: 1, style: 'default' })),
  draftToRenderData: jest.fn(() => ({ label: '', x: 0.5, y: 0.5, scale: 1, style: 'default' })),
  overlayLayout: jest.fn(() => ({ left: 0, top: 0, size: 40 })),
  STAMP_OVERLAY_CORNERS: [],
  STAMP_OVERLAY_MAX_SCALE: 2,
  STAMP_OVERLAY_MIN_SCALE: 0.5,
  STAMP_OVERLAY_SCALE_STEP: 0.1,
  STAMP_OVERLAY_STYLES: [],
}));

// NOTE: intentionally exhaustive — a SENTINEL place, so a layover postcard that
// leaked the picker's mapping into its body is visible.
jest.mock('../../lib/location/locationPayload.ts', () => ({
  placeToLocationFields: jest.fn(() => ({ locationCity: 'PICKED', locationLat: 1, placeId: 'picked:1' })),
}));


// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load.
jest.mock('../../platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));

const mockFlags: Record<string, boolean> = {};
// NOTE: intentionally exhaustive — the caption assist reads only `isEnabled`;
// the real provider fetches /api/feature-flags.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

import { PostcardComposer } from '../PostcardComposer.tsx';
import { requestSuggestions } from '../../platform/input-assistance/services/inputAssistance.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../platform/input-assistance/services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, { caption: { debounceMs: 0, privacyClass: 'public', allowAI: true, allowedSuggestionTypes: ['entity', 'ai_suggestion', 'validation'] } });

const postcards = require('../../services/postcards.ts');
const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const PROPOSAL = 'What a great dinner tonight!';

function photo(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///photo.jpg', type: 'image', mimeType: 'image/jpeg', width: 1080, height: 1440,
    fileName: 'photo.jpg', fileSize: 2_000_000, duration: null, assetId: null, base64: null, exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

async function pickAndCaption(caption: string) {
  const view = await render(<PostcardComposer visible onClose={jest.fn()} onSuccess={jest.fn()} />);
  await act(async () => { fireEvent.press(view.getByText('Library')); });
  await waitFor(() => expect(resolvePick).not.toBeNull());
  await act(async () => { resolvePick!([photo()]); });
  await waitFor(() => expect(view.getByText('Post')).toBeTruthy());
  await act(async () => { fireEvent.changeText(view.getByPlaceholderText('Where did you go? What did you do?'), caption); });
  return view;
}

beforeEach(() => {
  resolvePick = null;
  postcards.createPostcard.mockClear();
  for (const k of Object.keys(mockFlags)) delete mockFlags[k];
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => Promise.resolve({
    ok: true as const, requestId: 'r', policyVersion: 'test-policy-v1',
    suggestions: [{ id: 'caption:aiwrite:0', type: 'ai_suggestion', context: 'caption', label: PROPOSAL, replacementText: PROPOSAL,
      action: { type: 'replace_text', text: PROPOSAL }, confidence: 0.4, source: 'ai', reason: 'AI-suggested draft', policyVersion: 'test-policy-v1' }] as any,
  }));
});

test('flag OFF: no assist, no request, and the caption is posted as typed', async () => {
  const view = await pickAndCaption('great dinner tonight');
  expect(view.queryByTestId('postcard-caption-ai-button')).toBeNull();
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  expect(postcards.createPostcard.mock.calls[0][0].caption).toBe('great dinner tonight');
  expect(mockRequest).not.toHaveBeenCalled();
});

test('flag ON: one tap sends postcard.caption alone; a tapped proposal is what the Postcard posts', async () => {
  mockFlags.compass_ai_writing_enabled = true;
  const view = await pickAndCaption('great dinner tonight');
  await act(async () => { fireEvent.press(view.getByTestId('postcard-caption-ai-button')); });
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  const req = mockRequest.mock.calls[0]![0] as any;
  expect(req).toMatchObject({ context: 'caption', fieldId: 'postcard.caption', text: 'great dinner tonight', aiAssist: true });
  expect(req.sessionContext).toBeUndefined();
  expect(req.draft).toBeUndefined();
  expect(req.city).toBeUndefined();
  expect(req.client).toMatchObject({ suggestionTypes: ['ai_suggestion'], actionTypes: ['replace_text'] });
  await waitFor(() => expect(view.getByText(PROPOSAL)).toBeTruthy());
  expect(postcards.createPostcard).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(view.getByText(PROPOSAL)); });
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  expect(postcards.createPostcard.mock.calls[0][0].caption).toBe(PROPOSAL);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
