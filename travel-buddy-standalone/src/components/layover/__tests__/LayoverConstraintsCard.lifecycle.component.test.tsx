import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverConstraintsCard } from '../LayoverConstraintsCard.tsx';

/** NOTE: exhaustive native boundary; loading real Supabase constructs SecureStore. */
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));
/** NOTE: exhaustive auth boundary; real apiToken imports the native Supabase module. */
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'synthetic-token') }));

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function answer(mode = 'CARRY_ON_ONLY', version = 1) {
  const unknown = mode === 'UNKNOWN';
  return {
    ok: true, storage: 'versioned',
    declarable: ['baggageMode', 'recheckRequired', 'airportChangeRequired'],
    constraints: { version, baggageMode: mode, recheckRequired: null, airportChangeRequired: null },
    baggageCharged: unknown,
    landsideGate: {
      open: !unknown, closedBy: unknown ? ['baggage_unknown'] : [], needsInfo: unknown ? 'baggageMode' : null,
      criticalUnknowns: unknown ? ['BAGGAGE_STATUS_CRITICAL_UNKNOWN'] : [],
      entryPermissionState: 'CONFIRMED_ALLOWED', constraintsRead: 'declared', constraintsVersion: version,
      entryForbidsLandside: false,
    },
    layoverState: unknown ? 'NEEDS_INFO' : 'LANDSIDE_AVAILABLE', layoverStateUnavailableReason: null,
    question: unknown ? {
      field: 'baggageMode', prompt: 'Is your checked bag tagged through to your final destination?',
      options: [{ value: 'CHECKED_THROUGH', label: 'Yes — tagged through' }],
    } : null,
    verdict: unknown ? 'no' : 'yes', confidence: unknown ? 'INSUFFICIENT' : 'ESTIMATED',
    reasonCodes: [], certification: {}, snapshotId: `snapshot-${version}`,
  };
}

function legacyAnswer(charged: boolean) {
  return {
    ...answer(), storage: 'session_booleans_only', declarable: ['baggageMode'], constraints: null,
    baggageCharged: charged,
    landsideGate: { ...answer().landsideGate, constraintsRead: 'legacy', constraintsVersion: null },
    snapshotId: charged ? 'legacy-counted-bag' : 'legacy-no-bag',
  };
}

function accepted(body: unknown = answer('CHECKED_THROUGH', 2), unsaved: string[] = []) {
  return reply({ ...(body as Record<string, unknown>), stored: 'versioned', unsaved, unchanged: false });
}

function refused(message = 'Current save refused') {
  return reply({ error: 'degraded_unavailable', message, retryable: true }, 503);
}

type CardProps = React.ComponentProps<typeof LayoverConstraintsCard>;
const reads: Array<Response | Promise<Response>> = [];
const writes: Array<{ url: string; body: unknown }> = [];
const readUrls: string[] = [];
const onChanged = jest.fn();
let pendingWrite: ReturnType<typeof deferred<Response>>;
let props: CardProps;
// The service builds `${EXPO_PUBLIC_API_BASE_URL}/api/...`; pin it so the suite does not
// depend on the ambient shell (unset, the URL is relative and `new URL` below throws).
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://example.invalid';
  reads.length = 0;
  writes.length = 0;
  readUrls.length = 0;
  reads.push(reply(answer()));
  pendingWrite = deferred<Response>();
  props = { sessionId: 'session-a', canEdit: true, onChanged };
  onChanged.mockReset();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (options.method === 'PUT') {
      writes.push({ url: url.pathname, body: JSON.parse(String(options.body)) });
      return pendingWrite.promise;
    }
    if (options.method && options.method !== 'GET') throw new Error(`Unexpected method ${options.method}`);
    readUrls.push(url.pathname);
    const next = reads.shift();
    if (!next) throw new Error(`Unexpected read ${url.pathname}`);
    return next;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
});

function expectSelected(mode: string) {
  expect(screen.getByTestId(`layover-constraints-baggage-${mode}`).props.accessibilityState.selected).toBe(true);
}

async function mount(overrides: Partial<CardProps> = {}) {
  props = { ...props, ...overrides };
  await render(<LayoverConstraintsCard {...props} />);
  await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
}

async function rerender(overrides: Partial<CardProps>) {
  props = { ...props, ...overrides };
  await screen.rerender(<LayoverConstraintsCard {...props} />);
}

async function startWrite() {
  await act(async () => { fireEvent.press(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH')); });
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ url: '/api/airport/sessions/session-a/constraints', body: { baggageMode: 'CHECKED_THROUGH' } });
}

async function finishWrite(response = accepted()) {
  await act(async () => { pendingWrite.resolve(response); });
}

it('hides the previous answer immediately while a different session read is pending', async () => {
  await mount({ creationNotice: 'not_stored' });
  const nextRead = deferred<Response>();
  reads.push(nextRead.promise);
  await rerender({ sessionId: 'session-b', creationNotice: null });
  expect(screen.queryByTestId('layover-constraints-baggage-current')).toBeNull();
  expect(screen.queryByTestId('layover-constraints-not-stored')).toBeNull();
  expect(screen.getByTestId('layover-constraints-loading')).toBeTruthy();
  await act(async () => { nextRead.resolve(reply(answer('UNKNOWN', 3))); });
  expectSelected('UNKNOWN');
  expect(readUrls).toEqual(['/api/airport/sessions/session-a/constraints', '/api/airport/sessions/session-b/constraints']);
});

it('preserves a newer read while an accepted same-session write still refreshes the latest parent', async () => {
  await mount();
  await startWrite();
  const currentChanged = jest.fn();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ refreshKey: 1, onChanged: currentChanged });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite();
  expectSelected('UNKNOWN');
  expect(screen.queryByTestId('layover-badge-open')).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect(currentChanged).toHaveBeenCalledTimes(1);
});

it('does not infer ordering from constraint versions or opaque snapshot IDs', async () => {
  await mount();
  await startWrite();
  reads.push(reply({ ...answer('UNKNOWN', 1), snapshotId: 'a-new-read' }));
  await rerender({ refreshKey: 1 });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite(accepted({ ...answer('CHECKED_THROUGH', 999), snapshotId: 'z-old-write' }));
  expectSelected('UNKNOWN');
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('ignores a previous-session accepted write and both obsolete and new parent callbacks', async () => {
  await mount();
  await startWrite();
  const nextChanged = jest.fn();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b', onChanged: nextChanged });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite();
  expectSelected('UNKNOWN');
  expect(onChanged).not.toHaveBeenCalled();
  expect(nextChanged).not.toHaveBeenCalled();
});

it('ignores a previous-session refusal', async () => {
  await mount();
  await startWrite();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b' });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite(refused('Previous session save failed'));
  expect(screen.queryByText('Previous session save failed')).toBeNull();
  expectSelected('UNKNOWN');
});

it('does not notify the parent after unmount', async () => {
  await mount();
  await startWrite();
  await screen.unmount();
  await finishWrite();
  expect(onChanged).not.toHaveBeenCalled();
});

it('preserves a newer storage-OFF boolean read without requiring a version', async () => {
  reads[0] = reply(legacyAnswer(false));
  await mount();
  await startWrite();
  reads.push(reply(legacyAnswer(true)));
  await rerender({ refreshKey: 1 });
  await waitFor(() => expect(screen.getByTestId('layover-constraints-baggage-legacy').props.children).toBe('Time to collect and re-check a bag is being counted.'));
  await finishWrite(reply({ ...legacyAnswer(false), stored: 'session_booleans_only', unsaved: ['recheckRequired'], unchanged: false }));
  expect(screen.getByTestId('layover-constraints-baggage-legacy').props.children).toBe('Time to collect and re-check a bag is being counted.');
  expect(screen.getByTestId('layover-constraints-unsaved')).toBeTruthy();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('publishes the current accepted server answer exactly once without optimistic selection', async () => {
  await mount();
  await startWrite();
  expectSelected('CARRY_ON_ONLY');
  expect(onChanged).not.toHaveBeenCalled();
  await finishWrite(accepted(answer('UNKNOWN', 2)));
  expectSelected('UNKNOWN');
  expect(screen.getByTestId('layover-constraints-question')).toBeTruthy();
  expect(screen.queryByTestId('layover-badge-open')).toBeNull();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('retains prior truth on refusal and retries only on an explicit second press', async () => {
  await mount();
  await startWrite();
  await finishWrite(refused());
  expect(screen.getByText('Current save refused')).toBeTruthy();
  expectSelected('CARRY_ON_ONLY');
  expect(writes).toHaveLength(1);
  expect(onChanged).not.toHaveBeenCalled();
  pendingWrite = deferred<Response>();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH')); });
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  await finishWrite();
  expectSelected('CHECKED_THROUGH');
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('renders current read-only truth without enabling declarations', async () => {
  await mount({ canEdit: false });
  expect(screen.getByTestId('layover-constraints-baggage-current')).toBeTruthy();
  expect(screen.queryByTestId('layover-constraints-baggage-CHECKED_THROUGH')).toBeNull();
  expect(screen.getByTestId('layover-constraints-recheckRequired-true').props.accessibilityState.disabled).toBe(true);
  expect(writes).toEqual([]);
});

it('does not revive a first-session write after A to B to A', async () => {
  await mount();
  await startWrite();
  reads.push(reply(answer('UNKNOWN', 3)), reply(answer('UNKNOWN', 4)));
  await rerender({ sessionId: 'session-b' });
  await rerender({ sessionId: 'session-a' });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite();
  expectSelected('UNKNOWN');
  expect(onChanged).not.toHaveBeenCalled();
});

it.each(['accept', 'refuse', 'reject'] as const)('ignores %s after canEdit is revoked and restored without clearing a new write', async (outcome) => {
  await mount();
  await startWrite();
  const oldWrite = pendingWrite;
  await rerender({ canEdit: false });
  expect(screen.queryByTestId('layover-constraints-baggage-CHECKED_THROUGH')).toBeNull();
  await rerender({ canEdit: true });
  expect(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH').props.accessibilityState.disabled).toBe(false);
  pendingWrite = deferred<Response>();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH')); });
  await waitFor(() => expect(writes).toHaveLength(2));
  await act(async () => {
    if (outcome === 'reject') oldWrite.reject(new Error('Old request rejected'));
    else oldWrite.resolve(outcome === 'accept' ? accepted() : refused('Old refusal'));
  });
  expectSelected('CARRY_ON_ONLY');
  expect(screen.queryByTestId('layover-constraints-save-error')).toBeNull();
  expect(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH').props.accessibilityState.busy).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  await finishWrite();
  expectSelected('CHECKED_THROUGH');
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('ignores an accepted write while canEdit remains false', async () => {
  await mount();
  await startWrite();
  await rerender({ canEdit: false });
  const priorText = screen.getByTestId('layover-constraints-baggage-current').props.children;
  await finishWrite();
  expect(screen.getByTestId('layover-constraints-baggage-current').props.children).toEqual(priorText);
  expect(onChanged).not.toHaveBeenCalled();
});

it('fences late write JSON rather than treating arrival of HTTP headers as completion', async () => {
  await mount();
  await startWrite();
  const body = deferred<unknown>();
  const parse = jest.fn(() => body.promise);
  await finishWrite({ ...reply(null), json: parse } as Response);
  expect(parse).toHaveBeenCalledTimes(1);
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b' });
  await act(async () => { body.resolve({ ...answer('CHECKED_THROUGH', 2), stored: 'versioned', unsaved: [], unchanged: false }); });
  expectSelected('UNKNOWN');
  expect(onChanged).not.toHaveBeenCalled();
});

it.each(['answer', 'refusal', 'rejection'] as const)('ignores an older read %s after a declaration starts', async (outcome) => {
  await mount();
  const oldRead = deferred<Response>();
  reads.push(oldRead.promise);
  await rerender({ refreshKey: 1 });
  await waitFor(() => expect(readUrls).toHaveLength(2));
  expectSelected('CARRY_ON_ONLY');
  await startWrite();
  await finishWrite();
  await act(async () => {
    if (outcome === 'rejection') oldRead.reject(new Error('Old read rejected'));
    else oldRead.resolve(outcome === 'answer' ? reply(answer('UNKNOWN', 4)) : refused('Old read refused'));
  });
  expectSelected('CHECKED_THROUGH');
  expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('keeps healthy prior truth during refresh then accepts the exact later read', async () => {
  await mount();
  const refresh = deferred<Response>();
  reads.push(refresh.promise);
  await rerender({ refreshKey: 1 });
  expectSelected('CARRY_ON_ONLY');
  expect(screen.queryByTestId('layover-constraints-loading')).toBeNull();
  await act(async () => { refresh.resolve(reply(answer('UNKNOWN', 2))); });
  expectSelected('UNKNOWN');
});

it('allows the accepted write while a later read is pending and lets that read land afterwards', async () => {
  await mount();
  await startWrite();
  const refresh = deferred<Response>();
  reads.push(refresh.promise);
  await rerender({ refreshKey: 1 });
  await finishWrite();
  expectSelected('CHECKED_THROUGH');
  expect(onChanged).toHaveBeenCalledTimes(1);
  await act(async () => { refresh.resolve(reply(answer('UNKNOWN', 3))); });
  expectSelected('UNKNOWN');
});

it.each(['refused', 'unsupported'] as const)('does not resurrect a write answer after a later read is %s', async (outcome) => {
  await mount();
  await startWrite();
  reads.push(outcome === 'refused' ? refused('Current read unavailable') : reply({ error: 'disabled' }, 404));
  await rerender({ refreshKey: 1 });
  await waitFor(() => expect(screen.queryByTestId('layover-constraints-card')).toBeNull());
  await finishWrite();
  expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
  if (outcome === 'refused') expect(screen.getByText('Current read unavailable')).toBeTruthy();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('does not hide a current write refusal merely because a newer same-session read landed', async () => {
  await mount();
  await startWrite();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ refreshKey: 1 });
  await waitFor(() => expectSelected('UNKNOWN'));
  await finishWrite(refused());
  expectSelected('UNKNOWN');
  expect(screen.getByText('Current save refused')).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
});

it('keeps partial-save metadata and resets creation acknowledgement for the next session', async () => {
  await mount({ creationNotice: 'not_stored' });
  expect(screen.getByTestId('layover-constraints-not-stored')).toBeTruthy();
  await startWrite();
  await finishWrite(accepted(answer('CHECKED_THROUGH', 2), ['recheckRequired']));
  expect(screen.getByTestId('layover-constraints-unsaved')).toBeTruthy();
  expect(screen.queryByTestId('layover-constraints-not-stored')).toBeNull();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b' });
  await waitFor(() => expectSelected('UNKNOWN'));
  expect(screen.queryByTestId('layover-constraints-unsaved')).toBeNull();
  expect(screen.getByTestId('layover-constraints-not-stored')).toBeTruthy();
});

it('cannot revive a previous read after A to B to A, including late JSON', async () => {
  const body = deferred<unknown>();
  const parse = jest.fn(() => body.promise);
  reads[0] = { ...reply(null), json: parse } as Response;
  await render(<LayoverConstraintsCard {...props} />);
  await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
  reads.push(reply(answer()), reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b' });
  await rerender({ sessionId: 'session-a' });
  await waitFor(() => expectSelected('UNKNOWN'));
  await act(async () => { body.resolve(answer('CHECKED_THROUGH', 2)); });
  expectSelected('UNKNOWN');
});

it('orders overlapping refresh reads and preserves current failure plus explicit read retry', async () => {
  await mount();
  const oldRead = deferred<Response>();
  reads.push(oldRead.promise);
  await rerender({ refreshKey: 1 });
  reads.push(refused('Current read failed'));
  await rerender({ refreshKey: 2 });
  await waitFor(() => expect(screen.getByText('Current read failed')).toBeTruthy());
  await act(async () => { oldRead.resolve(reply(answer('UNKNOWN', 5))); });
  expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
  expect(screen.getByText('Current read failed')).toBeTruthy();
  reads.push(reply(answer('UNKNOWN', 6)));
  await act(async () => { fireEvent.press(screen.getByTestId('layover-constraints-retry')); });
  await waitFor(() => expectSelected('UNKNOWN'));
  expect(readUrls).toHaveLength(4);
});

it('keeps an initial unsupported or disabled endpoint invisible without writing', async () => {
  reads[0] = reply({ error: 'disabled' }, 404);
  await render(<LayoverConstraintsCard {...props} />);
  await waitFor(() => expect(screen.queryByTestId('layover-constraints-loading')).toBeNull());
  expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
  expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
  expect(writes).toEqual([]);
});

it('keeps a pending read valid when editing is revoked without losing the read-only answer', async () => {
  const initialRead = deferred<Response>();
  reads[0] = initialRead.promise;
  await render(<LayoverConstraintsCard {...props} />);
  await rerender({ canEdit: false });
  await act(async () => { initialRead.resolve(reply(answer('UNKNOWN', 3))); });
  expect(screen.getByTestId('layover-constraints-baggage-current')).toBeTruthy();
  expect(screen.queryByTestId('layover-constraints-question')).toBeNull();
  expect(screen.queryByTestId('layover-constraints-baggage-CHECKED_THROUGH')).toBeNull();
  expect(writes).toEqual([]);
  expect(readUrls).toHaveLength(1);
});

it('starts only one declaration when two controls are pressed before the busy render', async () => {
  await mount();
  const first = screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH');
  const second = screen.getByTestId('layover-constraints-recheckRequired-true');
  await act(async () => { fireEvent.press(first); fireEvent.press(second); });
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body).toEqual({ baggageMode: 'CHECKED_THROUGH' });
  await finishWrite();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('does not let a previous-session response clear the next session pending write', async () => {
  await mount();
  await startWrite();
  const oldWrite = pendingWrite;
  const nextChanged = jest.fn();
  reads.push(reply(answer('UNKNOWN', 3)));
  await rerender({ sessionId: 'session-b', onChanged: nextChanged });
  await waitFor(() => expectSelected('UNKNOWN'));
  pendingWrite = deferred<Response>();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH')); });
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].url).toBe('/api/airport/sessions/session-b/constraints');
  await act(async () => { oldWrite.resolve(accepted()); });
  expectSelected('UNKNOWN');
  expect(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH').props.accessibilityState.busy).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  expect(nextChanged).not.toHaveBeenCalled();
  await finishWrite();
  expectSelected('CHECKED_THROUGH');
  expect(nextChanged).toHaveBeenCalledTimes(1);
});
