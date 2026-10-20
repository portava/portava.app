import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverObjectiveIntentCard } from '../LayoverObjectiveIntentCard.tsx';
import { budgetAmount, emptyObjectiveIntent } from '../../../services/layoverObjectiveIntent.ts';
// NOTE: intentionally exhaustive — apiToken imports native SecureStore through Supabase.
// The real intent transport runs; requireActual would initialize unavailable native modules.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'owner-token') }));
const placeId = '11111111-1111-4111-8111-111111111111';
const onChanged = jest.fn();
function fetcher(failSave = false, failRead = false) {
  const spy = jest.fn(async (_url: string, init: RequestInit) => {
    const failed = init.method === 'PUT' ? failSave : failRead;
    const body = failed ? { ok: false, reason: 'unavailable' } : { ok: true, intent: init.method === 'PUT' ? JSON.parse(String(init.body)) : emptyObjectiveIntent() };
    return { ok: !failed, status: failed ? 503 : 200, json: async () => body } as Response;
  }); global.fetch = spy as typeof fetch; return spy;
}
async function mount() {
  await render(<LayoverObjectiveIntentCard sessionId="session-one" places={[{ placeId, title: 'Local museum' }]} editable onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByLabelText('Budget currency').props.editable).toBe(true));
}
beforeEach(() => jest.clearAllMocks());
it('no intent is invented or written on load; explicit choices save through the real owned API', async () => {
  const spy = fetcher(); await mount(); expect(spy).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Social')); await fireEvent.press(screen.getByText('Low energy'));
  await fireEvent.changeText(screen.getByLabelText('Budget currency'), 'sgd');
  await fireEvent.changeText(screen.getByLabelText('Outing budget'), '50');
  await fireEvent.press(screen.getByText('Meaningful to me: Local museum'));
  await fireEvent.press(screen.getByText('Save preferences'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  const [url, input] = spy.mock.calls[1]!; expect(url).toContain('/airport/sessions/session-one/objective-intent');
  expect(input.method).toBe('PUT'); expect(JSON.parse(String(input.body))).toEqual({ socialPreference: 'social', availableEnergy: 'low', budget: { currency: 'SGD', amountMinor: 5000 }, meaningfulPlaces: [{ placeId, importance: 'high' }] });
  expect(screen.getByText(/intention, not a past memory/)).toBeTruthy();
});
it('a failed save is visible and cannot announce confirmed preferences', async () => {
  fetcher(true); await mount(); await fireEvent.press(screen.getByText('Save preferences'));
  await waitFor(() => expect(screen.getByText('Your preferences were not confirmed. Try saving again.')).toBeTruthy());
  expect(onChanged).not.toHaveBeenCalled();
});
it('invalid or incomplete budget is refused before a write', async () => {
  const spy = fetcher(); await mount(); await fireEvent.changeText(screen.getByLabelText('Outing budget'), '10');
  await fireEvent.press(screen.getByText('Save preferences'));
  expect(screen.getByText(/valid amount, or clear both/)).toBeTruthy(); expect(spy).toHaveBeenCalledTimes(1);
});
it('an unreadable intent stays disabled and offers a genuine reload', async () => {
  const spy = fetcher(false, true);
  await render(<LayoverObjectiveIntentCard sessionId="session-one" places={[]} editable onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText('Reload preferences')).toBeTruthy());
  await fireEvent.press(screen.getByText('Save preferences')); expect(spy.mock.calls.every(c => c[1].method === 'GET')).toBe(true);
  fetcher(); await fireEvent.press(screen.getByText('Reload preferences'));
  await waitFor(() => expect(screen.getByLabelText('Budget currency').props.editable).toBe(true));
});
it('budget conversion respects currency minor units and rejects unsupported precision', () => {
  expect(budgetAmount('SGD', '12.34')).toEqual({ currency: 'SGD', amountMinor: 1234 });
  expect(budgetAmount('JPY', '1200')).toEqual({ currency: 'JPY', amountMinor: 1200 });
  expect(budgetAmount('JPY', '12.34')).toBeNull(); expect(budgetAmount('USD', '1e6')).toBeNull();
});
