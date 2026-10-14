/**
 * memorySegmentsApi / MemoryVideoSegments — the app's half of census-highlights-
 * memories H184 (§20 "Video scenes as logical segments without duplicating
 * originals"; server: routes/memorySegments.ts, migration 3809).
 *
 * Pins:
 *   - the reads map to states, never a bare list: ok (available or not),
 *     not_found, error — a malformed segment is an error, never repaired;
 *   - every write sends exactly its body to exactly its route, and only a 201
 *     carrying the segment / a 204 is success; the server's refusals map by code;
 *   - marking a part calls NOTHING but the segments route — no upload;
 *   - the chips render for whoever the server serves them to; a press plays
 *     that window of the SAME video reference through SharedVideoPlayer;
 *   - the owner's in/out editor refuses a malformed clock and a reversed window
 *     before any request, and shows the server's refusal;
 *   - nothing renders for a photo, while 3809 is unapplied, for a Memory the
 *     server will not show, or for a viewer when the video has no parts; a
 *     failed read is shown with a retry.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert, View } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

let mockPlayerProps: Array<Record<string, unknown>> = [];
jest.mock('../../../../components/ui/SharedVideoPlayer.tsx', () => ({
  ...jest.requireActual('../../../../components/ui/SharedVideoPlayer.tsx'),
  SharedVideoPlayer: (props: Record<string, unknown>) => {
    mockPlayerProps.push(props);
    const { View: V } = jest.requireActual('react-native');
    return <V testID="mock-segment-player" />;
  },
}));

import {
  fetchMemorySegments, formatClock, loadMemorySegments, markVideoSegment, parseClock, removeVideoSegment, segmentTitle, toVideoSegment,
} from '../memorySegmentsApi.ts';
import { MemoryVideoSegments } from '../MemoryVideoSegments.tsx';

const MID = '11111111-1111-4111-8111-111111111111';
const VIDEO = '21111111-1111-4111-8111-111111111111';
const PHOTO = '21111111-1111-4111-8111-111111111113';
const OTHER_VIDEO = '21111111-1111-4111-8111-111111111114';
const VIDEO_URL = 'post-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1760000000000.mp4';
const SEGMENTS_URL = `https://api.test/api/memories/${MID}/segments`;

const seg = (id: string, startMs: number, endMs: number, label: string | null, itemId = VIDEO) =>
  ({ id, itemId, startMs, endMs, label, mediaUrl: VIDEO_URL, mediaType: 'video/mp4' });

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
type Reply = { status: number; body: unknown } | Error;
let replies: Reply[] = [];
function serve(...r: Reply[]) {
  replies = r;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
}
const listing = (segments: unknown[], available = true) => ({ status: 200, body: { memoryId: MID, available, segments } });

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  calls = []; mockPlayerProps = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = realFetch; alertSpy.mockRestore(); });

describe('fetchMemorySegments', () => {
  it('reads GET /memories/:id/segments, authenticated, into ok', async () => {
    serve(listing([seg('s1', 1000, 5000, 'Sunset')]));
    const r = await fetchMemorySegments(MID);
    expect(r).toEqual({ state: 'ok', available: true, segments: [seg('s1', 1000, 5000, 'Sunset')] });
    expect(calls[0]!.url).toBe(SEGMENTS_URL);
    expect(calls[0]!.init?.method).toBe('GET');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('3809 not applied is ok with available false; a 404 is not_found', async () => {
    serve(listing([], false));
    expect(await fetchMemorySegments(MID)).toEqual({ state: 'ok', available: false, segments: [] });
    serve({ status: 404, body: { error: 'not_found', message: 'Memory not found' } });
    expect(await fetchMemorySegments(MID)).toEqual({ state: 'not_found' });
  });
  it('a 503, a malformed segment, a missing list, a missing availability and a network failure are errors, never "no parts"', async () => {
    for (const reply of [
      { status: 503, body: { error: 'degraded_unavailable', message: 'down' } },
      listing([{ ...seg('s1', 5000, 5000, null) }]),
      listing([{ ...seg('s1', 0, 10, '') }]),
      listing([{ ...seg('s1', 0, 10, null), mediaUrl: '' }]),
      { status: 200, body: { memoryId: MID, available: true } },
      { status: 200, body: { memoryId: MID, segments: [seg('s1', 0, 10, null)] } },
      new Error('offline'),
    ] as Reply[]) {
      serve(reply);
      expect((await fetchMemorySegments(MID)).state).toBe('error');
    }
  });
  it('callers that ask while a read is in flight share ONE request', async () => {
    serve(listing([]));
    const [a, b] = await Promise.all([loadMemorySegments(MID), loadMemorySegments(MID)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
    await loadMemorySegments(MID);
    expect(calls).toHaveLength(2);
  });
});

describe('markVideoSegment / removeVideoSegment', () => {
  it('POSTs exactly { startMs, endMs, label } to the item route; only a 201 with the segment is success', async () => {
    serve({ status: 201, body: { segment: seg('s9', 1000, 5000, 'Sunset') } });
    const r = await markVideoSegment(MID, VIDEO, { startMs: 1000, endMs: 5000, label: 'Sunset' });
    expect(r).toEqual({ ok: true, value: seg('s9', 1000, 5000, 'Sunset') });
    expect(calls[0]!.url).toBe(`https://api.test/api/memories/${MID}/items/${VIDEO}/segments`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ startMs: 1000, endMs: 5000, label: 'Sunset' });
    serve({ status: 201, body: { segment: { id: 's9' } } });
    expect((await markVideoSegment(MID, VIDEO, { startMs: 0, endMs: 1, label: null })).ok).toBe(false);
  });
  it("maps the server's refusals by code", async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 404, body: { error: 'feature_disabled', message: 'not yet' } }, 'unavailable'],
      [{ status: 404, body: { error: 'not_found', message: 'Memory not found' } }, 'not_found'],
      [{ status: 422, body: { error: 'duration_unknown', message: "This video's length hasn't been measured" } }, 'duration_unknown'],
      [{ status: 422, body: { error: 'segment_out_of_range', message: 'past the end' } }, 'out_of_range'],
      [{ status: 422, body: { error: 'not_a_video', message: 'photo' } }, 'not_a_video'],
      [{ status: 409, body: { error: 'conflict', message: 'already' } }, 'conflict'],
      [{ status: 400, body: { error: 'invalid_payload', message: 'bad' } }, 'invalid'],
      [{ status: 503, body: { error: 'degraded_unavailable', message: 'down' } }, 'error'],
      [new Error('offline'), 'error'],
    ];
    for (const [reply, reason] of cases) {
      serve(reply);
      const r = await markVideoSegment(MID, VIDEO, { startMs: 0, endMs: 1000, label: null });
      expect(r.ok ? 'ok' : r.reason).toBe(reason);
    }
  });
  it('DELETEs the segment route; only a 204 is success', async () => {
    serve({ status: 204, body: null });
    expect(await removeVideoSegment(MID, 's1')).toEqual({ ok: true, value: null });
    expect(calls[0]!.url).toBe(`https://api.test/api/memories/${MID}/segments/s1`);
    expect(calls[0]!.init?.method).toBe('DELETE');
    serve({ status: 200, body: {} });
    expect((await removeVideoSegment(MID, 's1')).ok).toBe(false);
  });
});

describe('the clock', () => {
  it('parses minutes:seconds, plain seconds and tenths; refuses the rest', () => {
    expect(parseClock('0:05')).toBe(5000);
    expect(parseClock('1:05.5')).toBe(65500);
    expect(parseClock(' 65 ')).toBe(65000);
    expect(parseClock('0:00.25')).toBe(250);
    for (const bad of ['', '1:60', '-1', 'abc', '1:2:3', '0:5x']) expect(parseClock(bad)).toBeNull();
  });
  it('formats a window, and a chip without a label shows its window', () => {
    expect(formatClock(5000)).toBe('0:05');
    expect(formatClock(65500)).toBe('1:05.5');
    expect(segmentTitle({ label: null, startMs: 1000, endMs: 5000 })).toBe('0:01–0:05');
    expect(segmentTitle({ label: 'Sunset', startMs: 1000, endMs: 5000 })).toBe('Sunset');
  });
  it('toVideoSegment keeps a served segment exactly and refuses a reversed window', () => {
    expect(toVideoSegment(seg('s1', 0, 10, null))).toEqual(seg('s1', 0, 10, null));
    expect(toVideoSegment(seg('s1', 10, 0, null))).toBeNull();
  });
});

describe('MemoryVideoSegments', () => {
  const video = { id: VIDEO, mediaUrl: VIDEO_URL, mediaType: 'video/mp4' };

  it('a photo renders nothing and never asks', async () => {
    serve(listing([seg('s1', 0, 1000, 'x', PHOTO)]));
    await render(<MemoryVideoSegments memoryId={MID} item={{ id: PHOTO, mediaUrl: 'post-media/x.jpg', mediaType: 'image/jpeg' }} isOwner />);
    await act(async () => {});
    expect(calls).toHaveLength(0);
    expect(screen.queryByTestId(`memory-segments-${PHOTO}`)).toBeNull();
  });

  it('a viewer sees this video\'s chips (not another video\'s), and a press plays THAT window of the SAME video', async () => {
    serve(listing([seg('s1', 1000, 5000, 'Sunset'), seg('s2', 6000, 9500, null), seg('s3', 0, 10, 'elsewhere', OTHER_VIDEO)]));
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner={false} />);
    expect(await screen.findByText('Sunset')).toBeTruthy();
    expect(screen.getByText('0:06–0:09.5')).toBeTruthy();
    expect(screen.queryByText('elsewhere')).toBeNull();
    expect(screen.queryByTestId(`memory-segment-add-${VIDEO}`)).toBeNull();
    expect(screen.queryByTestId('memory-segment-remove-s1')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId('memory-segment-chip-s1')); });
    expect(screen.getByTestId('mock-segment-player')).toBeTruthy();
    const props = mockPlayerProps[mockPlayerProps.length - 1]!;
    expect(props.uri).toBe(VIDEO_URL);
    expect(props.segment).toEqual({ startMs: 1000, endMs: 5000 });
    expect(props.autoplay).toBe(true);
  });

  it('while 3809 is unapplied, and for a Memory the server will not show, it renders nothing — for the owner too', async () => {
    serve(listing([], false));
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => {});
    expect(screen.queryByTestId(`memory-segments-${VIDEO}`)).toBeNull();
    expect(screen.queryByTestId(`memory-segment-add-${VIDEO}`)).toBeNull();
    serve({ status: 404, body: { error: 'not_found' } });
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => {});
    expect(screen.queryByTestId(`memory-segments-${VIDEO}`)).toBeNull();
  });

  it('a viewer sees nothing for a video with no parts; the owner sees the way to mark one', async () => {
    serve(listing([]));
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner={false} />);
    await act(async () => {});
    expect(screen.queryByTestId(`memory-segments-${VIDEO}`)).toBeNull();
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    expect(await screen.findByTestId(`memory-segment-add-${VIDEO}`)).toBeTruthy();
  });

  it('a failed read is shown with a retry, never as "no parts"', async () => {
    serve({ status: 503, body: { error: 'degraded_unavailable' } }, listing([seg('s1', 0, 1000, 'Back')]));
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner={false} />);
    expect(await screen.findByTestId(`memory-segments-error-${VIDEO}`)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId(`memory-segments-retry-${VIDEO}`)); });
    expect(await screen.findByText('Back')).toBeTruthy();
  });

  it('the owner marks a part: exactly one POST to the segments route, NO upload, and the chip appears', async () => {
    serve(listing([]), { status: 201, body: { segment: seg('s9', 1000, 5000, 'Sunset') } });
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => { fireEvent.press(await screen.findByTestId(`memory-segment-add-${VIDEO}`)); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-start'), '0:01'); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-end'), '0:05'); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-label'), '  Sunset '); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-segment-save')); });
    expect(await screen.findByText('Sunset')).toBeTruthy();
    const posts = calls.filter((c) => c.init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]!.init?.body))).toEqual({ startMs: 1000, endMs: 5000, label: 'Sunset' });
    expect(calls.every((c) => /\/api\/memories\/[^/]+\/(items\/[^/]+\/)?segments$/.test(c.url))).toBe(true);
    expect(calls.some((c) => /media\/upload|storage/.test(c.url))).toBe(false);
  });

  it('a malformed clock and a reversed window are refused before any request', async () => {
    serve(listing([]));
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => { fireEvent.press(await screen.findByTestId(`memory-segment-add-${VIDEO}`)); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-start'), 'soon'); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-end'), '0:05'); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-segment-save')); });
    expect(screen.getByTestId('memory-segment-message')).toBeTruthy();
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-start'), '0:09'); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-segment-save')); });
    expect(screen.getByText('A part must start before it ends.')).toBeTruthy();
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });

  it("the server's refusal (an unmeasured video) is shown and no chip appears", async () => {
    serve(listing([]), { status: 422, body: { error: 'duration_unknown', message: "This video's length hasn't been measured, so a part of it can't be marked yet." } });
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => { fireEvent.press(await screen.findByTestId(`memory-segment-add-${VIDEO}`)); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-start'), '0:00'); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('memory-segment-end'), '0:03'); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-segment-save')); });
    expect(await screen.findByText("This video's length hasn't been measured, so a part of it can't be marked yet.")).toBeTruthy();
    expect(screen.queryByTestId(/memory-segment-chip-/)).toBeNull();
  });

  it('the owner removes a part after confirming; a refused removal keeps the chip and says so', async () => {
    serve(listing([seg('s1', 1000, 5000, 'Sunset')]), { status: 204, body: null });
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => { fireEvent.press(await screen.findByTestId('memory-segment-remove-s1')); });
    const buttons = alertSpy.mock.calls[0]![2] as Array<{ text: string; onPress?: () => Promise<void> }>;
    await act(async () => { await buttons.find((b) => b.text === 'Remove')!.onPress!(); });
    await waitFor(() => expect(screen.queryByText('Sunset')).toBeNull());
    expect(calls.some((c) => c.init?.method === 'DELETE' && c.url.endsWith(`/memories/${MID}/segments/s1`))).toBe(true);

    alertSpy.mockClear();
    serve(listing([seg('s1', 1000, 5000, 'Sunset')]), { status: 503, body: { error: 'degraded_unavailable' } });
    await render(<MemoryVideoSegments memoryId={MID} item={video} isOwner />);
    await act(async () => { fireEvent.press(await screen.findByTestId('memory-segment-remove-s1')); });
    const again = alertSpy.mock.calls[0]![2] as Array<{ text: string; onPress?: () => Promise<void> }>;
    await act(async () => { await again.find((b) => b.text === 'Remove')!.onPress!(); });
    expect(screen.getByText('Sunset')).toBeTruthy();
    expect(alertSpy.mock.calls.some((c) => c[0] === 'Could not remove')).toBe(true);
  });

  it('two videos of one Memory share one read', async () => {
    serve(listing([seg('s1', 0, 1000, 'A'), seg('s3', 0, 1000, 'B', OTHER_VIDEO)]));
    await render(
      <View>
        <MemoryVideoSegments memoryId={MID} item={video} isOwner={false} />
        <MemoryVideoSegments memoryId={MID} item={{ id: OTHER_VIDEO, mediaUrl: VIDEO_URL, mediaType: 'video/quicktime' }} isOwner={false} />
      </View>,
    );
    expect(await screen.findByText('A')).toBeTruthy();
    expect(await screen.findByText('B')).toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});
