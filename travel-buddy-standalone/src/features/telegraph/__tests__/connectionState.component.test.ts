/**
 * Telegraph §30A.15 — "Truthful ONLINE / POOR_CONNECTION / OFFLINE /
 * RECONNECTING" (`connection/connectionState.ts`).
 *
 * Pins what each state may be inferred from, and — the point of "truthful" —
 * what it may NOT: a refusal (4xx) is a server that was reached, so it is not a
 * connection problem; a run of 5xx is a server failing, so it is never
 * "can't reach Portava"; and nothing at all is said while the connection is
 * fine.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { connectionCopy, deriveConnectionState, OFFLINE_AFTER } from '../connection/connectionState.ts';

const base = { realtime: 'open' as const, everOpen: true, outcomes: [] as Array<'ok' | 'network' | 'server'> };

describe('deriveConnectionState', () => {
  it('ONLINE when requests are answered and the stream is open — and says nothing', () => {
    const v = deriveConnectionState({ ...base, outcomes: ['ok', 'ok', 'ok'] });
    expect(v).toEqual({ state: 'ONLINE', cause: null });
    expect(connectionCopy(v)).toBeNull();
  });

  it(`OFFLINE after ${OFFLINE_AFTER} unanswered requests in a row — "can't reach Portava", not "you are offline"`, () => {
    const v = deriveConnectionState({ ...base, outcomes: ['ok', 'network', 'network'] });
    expect(v.state).toBe('OFFLINE');
    expect(connectionCopy(v)).toMatch(/Can't reach Portava/);
    expect(connectionCopy(v)).not.toMatch(/you are offline/i);
  });

  it('a single unanswered request is an unstable connection, not an outage', () => {
    expect(deriveConnectionState({ ...base, outcomes: ['ok', 'network'] })).toEqual({ state: 'POOR_CONNECTION', cause: 'network' });
  });

  it('a run of server errors is the SERVER failing — never "offline"', () => {
    const v = deriveConnectionState({ ...base, outcomes: ['server', 'server', 'server'] });
    expect(v).toEqual({ state: 'POOR_CONNECTION', cause: 'server' });
    expect(connectionCopy(v)).toMatch(/Portava is having trouble/);
  });

  it('a REFUSAL is an answer: recorded as ok, it is not a connection problem', () => {
    // The transport records any HTTP answer below 500 as `ok`.
    expect(deriveConnectionState({ ...base, outcomes: ['ok', 'ok'] }).state).toBe('ONLINE');
  });

  it('failures still inside the window keep it POOR after a recovery', () => {
    expect(deriveConnectionState({ ...base, outcomes: ['network', 'ok'] }).state).toBe('POOR_CONNECTION');
    // ...and it clears once they have aged out of the window.
    expect(deriveConnectionState({ ...base, outcomes: ['network', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'] }).state).toBe('ONLINE');
  });

  it('RECONNECTING when the stream re-opens after it had been open', () => {
    expect(deriveConnectionState({ ...base, realtime: 'connecting', outcomes: ['ok'] })).toEqual({ state: 'RECONNECTING', cause: 'realtime' });
  });

  it('the FIRST connect is not a reconnect', () => {
    expect(deriveConnectionState({ realtime: 'connecting', everOpen: false, outcomes: ['ok'] }).state).toBe('ONLINE');
  });

  it('coming back from OFFLINE: the first answered request says RECONNECTING until the stream is open', () => {
    expect(deriveConnectionState({ ...base, realtime: 'polling', outcomes: ['network', 'network', 'ok'], previous: 'OFFLINE' }).state)
      .toBe('RECONNECTING');
    expect(deriveConnectionState({ ...base, realtime: 'open', outcomes: ['network', 'network', 'ok'], previous: 'RECONNECTING' }).state)
      .toBe('POOR_CONNECTION'); // open again, the failures are still in the window
  });

  it('live updates that fell back to polling are said to be delayed', () => {
    const v = deriveConnectionState({ ...base, realtime: 'polling', outcomes: ['ok', 'ok'] });
    expect(v).toEqual({ state: 'POOR_CONNECTION', cause: 'realtime' });
    expect(connectionCopy(v)).toMatch(/Live updates are paused/);
  });
});
