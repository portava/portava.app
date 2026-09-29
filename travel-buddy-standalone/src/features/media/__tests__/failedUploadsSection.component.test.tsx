/**
 * FailedUploadsSection (testing-mode WP-17, flow MED-F25) — the real section
 * over the real service; only `fetch` and the token helper are stubbed.
 *
 * WHAT IS PINNED
 *   1. A failed read says it could not check — never "no failed uploads".
 *   2. Failed uploads are listed; Retry posts the ASSET id to /media/:id/retry
 *      and the row leaves only after the server queued it (202).
 *   3. A refused retry keeps the row and says why.
 *   4. With `retryAvailable: false` there is no Retry button, and the copy says
 *      the uploads are kept.
 *   5. No failures ⇒ the section renders nothing.
 *
 * Run: npx jest src/features/media/__tests__/failedUploadsSection
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('../../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../../services/apiToken.ts'),
  freshToken: jest.fn(async () => 'tok'),
}));

import { FailedUploadsSection } from '../components/FailedUploadsSection.tsx';

const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const realFetch = global.fetch;
let list: { status: number; body: unknown } | 'network';
let retryReply: { status: number; body: unknown };
let posts: string[];

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  posts = [];
  retryReply = { status: 202, body: { retryQueued: true, alreadyQueued: false } };
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/media/me/failed-uploads')) {
      if (list === 'network') throw new TypeError('Network request failed');
      return new Response(JSON.stringify(list.body), { status: list.status });
    }
    if (init?.method === 'POST') { posts.push(u.replace('http://api.test', '')); return new Response(JSON.stringify(retryReply.body), { status: retryReply.status }); }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(async () => { await act(async () => {}); global.fetch = realFetch; });

const one = { items: [{ id: A1, mediaType: 'video', thumbnailUrl: null, createdAt: '2026-09-28T10:00:00Z' }], retryAvailable: true };

describe('FailedUploadsSection', () => {
  it('a failed read says it could not check (with Try again), never "no failures"', async () => {
    list = { status: 500, body: { error: 'db_error' } };
    await render(<FailedUploadsSection />);
    await waitFor(() => expect(screen.getByTestId('failed-uploads-error')).toBeTruthy());
    list = { status: 200, body: one };
    await act(async () => { await fireEvent.press(screen.getByLabelText('Check failed uploads again')); });
    await waitFor(() => expect(screen.getByTestId(`failed-upload-${A1}`)).toBeTruthy());
  });

  it('Retry posts the asset id and the row leaves only after the server queued it', async () => {
    list = { status: 200, body: one };
    await render(<FailedUploadsSection />);
    await waitFor(() => expect(screen.getByText('1 upload failed')).toBeTruthy());
    await act(async () => { await fireEvent.press(screen.getByTestId(`failed-upload-retry-${A1}`)); });
    await waitFor(() => expect(screen.getByTestId('failed-uploads-queued')).toBeTruthy());
    expect(posts).toEqual([`/api/media/${A1}/retry`]);
  });

  it('a refused retry keeps the row and says why', async () => {
    list = { status: 200, body: one };
    retryReply = { status: 500, body: { error: 'db_error', message: 'Could not retry this upload right now' } };
    await render(<FailedUploadsSection />);
    await waitFor(() => expect(screen.getByText('1 upload failed')).toBeTruthy());
    await act(async () => { await fireEvent.press(screen.getByTestId(`failed-upload-retry-${A1}`)); });
    await waitFor(() => expect(screen.getByTestId(`failed-upload-notice-${A1}`)).toBeTruthy());
    expect(screen.getByTestId(`failed-upload-${A1}`)).toBeTruthy();
  });

  it('with the worker off there is no Retry button, and the uploads are said to be kept', async () => {
    list = { status: 200, body: { ...one, retryAvailable: false } };
    await render(<FailedUploadsSection />);
    await waitFor(() => expect(screen.getByText('1 upload failed')).toBeTruthy());
    expect(screen.queryByTestId(`failed-upload-retry-${A1}`)).toBeNull();
    expect(screen.getByText(/kept, not lost/)).toBeTruthy();
  });

  it('no failed uploads renders nothing', async () => {
    list = { status: 200, body: { items: [], retryAvailable: true } };
    await render(<FailedUploadsSection />);
    await act(async () => {});
    expect(screen.queryByTestId('failed-uploads')).toBeNull();
    expect(screen.queryByTestId('failed-uploads-error')).toBeNull();
  });
});
