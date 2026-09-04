/**
 * MapContributionSheet — §22's eighth prompt, driven through the real sheet.
 *
 * The unit tests in features/map/truth/__tests__/contributionFlow.test.ts pin
 * the rules on the pure flow. This file pins that the SHIPPING COMPONENT
 * actually performs them: that tapping an answer and then "Add a photo" makes
 * the two contribution calls in §21's order, that the media call carries the
 * observation id the first call returned, and that the two failure paths a
 * contributor can land in are on screen rather than swallowed.
 *
 * The services are mocked because the assertion is about WHICH CALLS the
 * component makes and IN WHAT ORDER — a shared log records them.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { MapContributionSheet } from '../MapContributionSheet.tsx';
import { submitMapObservation } from '../../../services/mapObservations.ts';
import { uploadMedia } from '../../../services/media.ts';
import type { MapObject } from '../../../types/mapObjects.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const OBSERVATION_ID = 'a3f7f6f2-0f2a-4a2b-9f4a-6d3f9c1b2e10';
/** What POST /api/media/upload returns — a storage reference, not a device URI. */
const STORAGE_REF = 'post-media/user-1/1785413296467.jpg';
const DEVICE_URI = 'file:///var/mobile/tmp/IMG_0042.HEIC';

/** Ordered record of every network call the component made. */
const callLog: string[] = [];
/** Every contribution the component posted, in order. */
const posted: any[] = [];

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — this module reaches lib/supabase and the
// network, and recording the calls it would make IS the assertion here.
jest.mock('../../../services/mapObservations.ts', () => ({
  submitMapObservation: jest.fn(),
}));

// NOTE: intentionally exhaustive — services/media pulls expo-video-thumbnails
// and the upload endpoint; the test asserts the component reuses this exact
// upload seam rather than uploading some other way.
jest.mock('../../../services/media.ts', () => ({
  uploadMedia: jest.fn(),
}));

const mockSubmit = submitMapObservation as unknown as jest.Mock;
const mockUpload = uploadMedia as unknown as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE: MapObject = {
  id: 'place-1',
  kind: 'place',
  geometry: { type: 'Point', coordinates: [108.22, 16.06] },
  title: 'Bamboo 2',
  privacyClass: 'place_level',
  renderingPriority: 40,
};

const ASSET = { uri: DEVICE_URI, mimeType: 'image/jpeg', type: 'image' as const };

function acceptedObservation() {
  return { ok: true, enabled: true, accepted: 1, observationId: OBSERVATION_ID, deduped: false };
}

async function renderSheet(over: Partial<React.ComponentProps<typeof MapContributionSheet>> = {}) {
  const onClose = jest.fn();
  const onSubmit = jest.fn();
  const onRequestMedia = jest.fn(async () => ASSET);
  const utils = await render(
    <MapContributionSheet
      visible
      object={PLACE}
      onClose={onClose}
      onSubmit={onSubmit}
      onRequestMedia={onRequestMedia as any}
      {...(over as any)}
    />,
  );
  return { ...utils, onClose, onSubmit, onRequestMedia };
}

/** Answer "How busy is it?" with "Busy" and wait for the observation to land. */
async function answerBusy() {
  fireEvent.press(screen.getByLabelText('How busy is it? Busy'));
  await waitFor(() => expect(screen.getByText('Report recorded.')).toBeTruthy());
}

beforeEach(() => {
  callLog.length = 0;
  posted.length = 0;
  mockSubmit.mockReset();
  mockUpload.mockReset();
  mockSubmit.mockImplementation(async (_objectId: string, _objectKind: string, c: any) => {
    callLog.push(`submit:${c.kind}`);
    posted.push(c);
    return c.kind === 'media'
      ? { ok: true, enabled: true, accepted: 1, observationId: OBSERVATION_ID, evidenceId: 'ev-1', deduped: false }
      : acceptedObservation();
  });
  mockUpload.mockImplementation(async () => {
    callLog.push('upload');
    return { ok: true, url: STORAGE_REF, mediaType: 'image/jpeg' };
  });
});

// ── §21 · the order, through the shipping component ───────────────────────────

describe('MapContributionSheet — a photo attaches to the report just made', () => {
  test('makes the observation call, then the upload, then the media call', async () => {
    await renderSheet();

    // The eighth prompt is not a row: it is announced as something that
    // follows an answer, because §21 gives it nowhere else to stand.
    expect(screen.getByText('Answer one of these, then you can add a photo to it.')).toBeTruthy();
    expect(screen.queryByLabelText('Show what it looks like')).toBeNull();

    await answerBusy();
    expect(callLog).toEqual(['submit:crowd_level']);

    fireEvent.press(screen.getByLabelText('Add a photo to this report'));
    await waitFor(() => expect(screen.getByText('Photo attached to your report.')).toBeTruthy());

    // THE ORDER, not merely that both happened.
    expect(callLog).toEqual(['submit:crowd_level', 'upload', 'submit:media']);
  });

  test('the media call carries the observation id the first call returned', async () => {
    mockSubmit.mockImplementation(async (_objectId: string, _objectKind: string, c: any) => {
      callLog.push(`submit:${c.kind}`);
      posted.push(c);
      // An id nobody could have guessed: the media call must carry THIS one.
      return c.kind === 'media'
        ? { ok: true, enabled: true, accepted: 1, evidenceId: 'ev-1', deduped: false }
        : { ok: true, enabled: true, accepted: 1, observationId: 'obs-from-the-server-9', deduped: false };
    });
    await renderSheet();
    await answerBusy();

    fireEvent.press(screen.getByLabelText('Add a photo to this report'));
    await waitFor(() => expect(screen.getByText('Photo attached to your report.')).toBeTruthy());

    expect(posted[1].kind).toBe('media');
    expect(posted[1].observationId).toBe('obs-from-the-server-9');
    // The uploaded reference travels; the device URI does not.
    expect(posted[1].mediaUri).toBe(STORAGE_REF);
    expect(posted[1].mediaUri).not.toBe(DEVICE_URI);
    // A photo asserts nothing, so it carries nothing a claim would.
    expect(Object.keys(posted[1]).sort()).toEqual([
      'kind', 'mediaUri', 'objectId', 'objectKind', 'observationId', 'observedAt', 'value',
    ]);
  });

  test('the sheet says what it is doing while the observation is in flight', async () => {
    let release: (v: any) => void = () => {};
    mockSubmit.mockImplementation(
      (_objectId: string, _objectKind: string, c: any) =>
        new Promise((resolve) => {
          callLog.push(`submit:${c.kind}`);
          posted.push(c);
          release = resolve;
        }),
    );
    await renderSheet();

    fireEvent.press(screen.getByLabelText('How busy is it? Busy'));
    await waitFor(() => expect(screen.getByText('Recording your report…')).toBeTruthy());
    // Nothing may be offered against an observation that does not exist yet.
    expect(screen.queryByLabelText('Add a photo to this report')).toBeNull();
    // And the answer is echoed, so the photo has a visible subject.
    expect(screen.getByText('How busy is it? · Busy')).toBeTruthy();

    release(acceptedObservation());
    await waitFor(() => expect(screen.getByText('Report recorded.')).toBeTruthy());
  });
});

// ── The half-landed act ───────────────────────────────────────────────────────

describe('MapContributionSheet — a failed photo is shown, and never re-reports', () => {
  test('a failed upload states both halves and retries only the photo', async () => {
    mockUpload.mockImplementation(async () => {
      callLog.push('upload');
      return { ok: false, url: null, message: 'Upload failed (HTTP 500)' };
    });
    await renderSheet();
    await answerBusy();

    fireEvent.press(screen.getByLabelText('Add a photo to this report'));
    await waitFor(() =>
      expect(
        screen.getByText('Your report was recorded. The photo could not be uploaded.'),
      ).toBeTruthy(),
    );
    // The server's own words are shown, not replaced by a generic apology.
    expect(screen.getByText('Upload failed (HTTP 500)')).toBeTruthy();

    // The retry re-runs the PHOTO. It cannot re-run the report: there is no
    // path from here back into a second observation.
    fireEvent.press(screen.getByLabelText('Try attaching it again'));
    await waitFor(() => expect(callLog.filter((c) => c === 'upload').length).toBe(2));

    expect(callLog).toEqual(['submit:crowd_level', 'upload', 'upload']);
    expect(callLog.filter((c) => c === 'submit:crowd_level').length).toBe(1);
  });

  test('a refused media contribution is rendered as a refusal, not a success', async () => {
    mockSubmit.mockImplementation(async (_objectId: string, _objectKind: string, c: any) => {
      callLog.push(`submit:${c.kind}`);
      posted.push(c);
      return c.kind === 'media'
        ? { ok: false, error: 'a photo is evidence, not a claim', errorCode: 'invalid_payload' }
        : acceptedObservation();
    });
    await renderSheet();
    await answerBusy();

    fireEvent.press(screen.getByLabelText('Add a photo to this report'));
    await waitFor(() =>
      expect(screen.getByText('Your report was recorded. The photo was not recorded.')).toBeTruthy(),
    );
    expect(screen.queryByText('Photo attached to your report.')).toBeNull();
    expect(screen.getByText('a photo is evidence, not a claim')).toBeTruthy();
  });

  test('a refused observation offers no photo to attach to it', async () => {
    mockSubmit.mockImplementation(async (_objectId: string, _objectKind: string, c: any) => {
      callLog.push(`submit:${c.kind}`);
      return { ok: false, error: 'Consent required', errorCode: 'forbidden' };
    });
    await renderSheet();

    fireEvent.press(screen.getByLabelText('How busy is it? Busy'));
    await waitFor(() => expect(screen.getByText('Your report was not recorded.')).toBeTruthy());

    expect(screen.queryByLabelText('Add a photo to this report')).toBeNull();
    expect(screen.getByLabelText('Try again')).toBeTruthy();
    expect(callLog).toEqual(['submit:crowd_level']);
  });

  test('backing out of the picker leaves the report standing and sends nothing', async () => {
    const onRequestMedia = jest.fn(async () => null);
    await render(
      <MapContributionSheet
        visible
        object={PLACE}
        onClose={jest.fn()}
        onSubmit={jest.fn()}
        onRequestMedia={onRequestMedia as any}
      />,
    );
    await answerBusy();

    fireEvent.press(screen.getByLabelText('Add a photo to this report'));
    await waitFor(() => expect(onRequestMedia).toHaveBeenCalledTimes(1));

    expect(callLog).toEqual(['submit:crowd_level']);
    expect(screen.getByText('Report recorded.')).toBeTruthy();
  });
});
