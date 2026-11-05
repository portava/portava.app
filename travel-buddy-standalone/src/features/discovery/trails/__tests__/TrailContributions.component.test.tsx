import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { TrailContributionForm } from '../TrailContributionForm.tsx';
import { TrailSuggestionsView } from '../TrailSuggestionsView.tsx';
import { canonicalUrl } from '../../../../constants/canonicalUrl.ts';

const id = '11111111-1111-4111-8111-111111111111';
const suggestion = { id: 's1', trailId: 't1', sourceId: id, sourceType: 'post', relationship: 'supporting', signal: null, createdAt: '' };
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

it('rejects a foreign link without a write and distinguishes pending approval from added content', async () => {
  const contribute = jest.fn().mockResolvedValue({ state: 'suggested' });
  await render(<TrailContributionForm trailId="t1" onDone={jest.fn()} contribute={contribute} />);
  await fireEvent.changeText(screen.getByTestId('trail-contribution-link'), `https://unrelated.example/post/${id}`);
  await fireEvent.press(screen.getByTestId('trail-contribution-submit'));
  expect(screen.getByTestId('trail-contribution-error')).toBeTruthy();
  expect(contribute).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByTestId('trail-contribution-link'), canonicalUrl(`/post/${id}`));
  await fireEvent.press(screen.getByTestId('trail-contribution-submit'));
  await waitFor(() => screen.getByTestId('trail-contribution-success'));
  expect(screen.getByText(/content owner approves/)).toBeTruthy();
  expect(contribute).toHaveBeenCalledWith('t1', { sourceType: 'post', sourceId: id }, 'supporting');
});

it('keeps contribution input after failure, prevents duplicate writes, and permits retry', async () => {
  const answer = pending<any>();
  const contribute = jest.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValue(answer.promise);
  await render(<TrailContributionForm trailId="t1" onDone={jest.fn()} contribute={contribute} />);
  await fireEvent.changeText(screen.getByTestId('trail-contribution-link'), canonicalUrl(`/post/${id}`));
  await fireEvent.press(screen.getByTestId('trail-contribution-submit'));
  await waitFor(() => screen.getByTestId('trail-contribution-error'));
  expect(screen.getByTestId('trail-contribution-link').props.value).toContain(id);
  await fireEvent.press(screen.getByTestId('trail-contribution-submit'));
  await fireEvent.press(screen.getByTestId('trail-contribution-submit'));
  expect(contribute).toHaveBeenCalledTimes(2);
  await act(async () => { answer.resolve({ state: 'added' }); });
  await waitFor(() => screen.getByText('Added to this Trail.'));
});

it('does not call a failed suggestions read empty and retries it', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ state: 'ok', data: [] });
  await render(<TrailSuggestionsView onNavigate={jest.fn()} load={load} />);
  await waitFor(() => screen.getByTestId('trail-suggestions-retry'));
  expect(screen.queryByTestId('trail-suggestions-empty')).toBeNull();
  await fireEvent.press(screen.getByTestId('trail-suggestions-retry'));
  await waitFor(() => screen.getByTestId('trail-suggestions-empty'));
});

it('keeps a refused suggestion pending and shows accepted only after confirmation', async () => {
  const answer = pending<any>();
  const decide = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'not confirmed' }).mockReturnValue(answer.promise);
  const onNavigate = jest.fn();
  await render(<TrailSuggestionsView onNavigate={onNavigate} load={jest.fn().mockResolvedValue({ state: 'ok', data: [suggestion] })} decide={decide} />);
  await waitFor(() => screen.getByTestId('trail-suggestion-s1'));
  await fireEvent.press(screen.getByText('View your content'));
  expect(onNavigate).toHaveBeenCalledWith(`/post/${id}`);
  await fireEvent.press(screen.getByTestId('trail-suggestion-accept-s1'));
  await waitFor(() => screen.getByTestId('trail-suggestion-error-s1'));
  expect(screen.queryByTestId('trail-suggestion-result-s1')).toBeNull();
  await fireEvent.press(screen.getByTestId('trail-suggestion-accept-s1'));
  await fireEvent.press(screen.getByTestId('trail-suggestion-decline-s1'));
  expect(decide).toHaveBeenCalledTimes(2);
  await act(async () => { answer.resolve({ state: 'done', status: 200, data: { state: 'accepted' } }); });
  await waitFor(() => screen.getByText('Accepted. Your content is included in this Trail.'));
});
