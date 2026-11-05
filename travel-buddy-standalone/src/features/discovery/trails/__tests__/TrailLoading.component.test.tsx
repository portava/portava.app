import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { TrailDetailView } from '../TrailDetailView.tsx';
import { TrailsBrowser } from '../TrailsBrowser.tsx';

const trail = (id: string) => ({ id, title: `Trail ${id}`, slug: id, description: null, destination: null, parentTrailId: null, lifecycle: 'active', createdAt: '' });
const ok = <T,>(data: T) => ({ state: 'ok' as const, data });
function pending<T>() { let resolve!: (answer: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const detail = (id: string) => ok({ trail: trail(id), status: null, memberCount: 0 });
const deps = () => ({ loadTrail: jest.fn().mockResolvedValue(detail('a')), loadModules: jest.fn().mockResolvedValue(ok([])), loadRelated: jest.fn().mockResolvedValue(ok([])), loadFollow: jest.fn().mockResolvedValue(ok(false)), follow: jest.fn(), report: jest.fn(), loadPlaceName: jest.fn(), onNavigate: jest.fn() });

it('shows Trail identity before slow sections finish and exposes section loading', async () => {
  const modules = pending<any>(); const related = pending<any>(); const follow = pending<any>();
  await render(<TrailDetailView trailId="a" {...deps()} loadModules={() => modules.promise} loadRelated={() => related.promise} loadFollow={() => follow.promise} />);
  await waitFor(() => screen.getByText('Trail a'));
  expect(screen.getByTestId('trail-modules-loading')).toBeTruthy();
  await act(async () => { modules.resolve(ok([])); related.resolve(ok([])); follow.resolve(ok(false)); });
  await waitFor(() => screen.getByTestId('trail-modules-empty'));
});

it('never lets an old Trail response replace the Trail opened next', async () => {
  const old = pending<any>(); const d = deps();
  d.loadTrail.mockImplementation((id: string) => id === 'a' ? old.promise : Promise.resolve(detail(id)));
  const view = await render(<TrailDetailView trailId="a" {...d} />);
  await view.rerender(<TrailDetailView trailId="b" {...d} />);
  await waitFor(() => screen.getByText('Trail b'));
  await act(async () => { old.resolve(detail('a')); });
  expect(screen.queryByText('Trail a')).toBeNull();
  expect(screen.getByText('Trail b')).toBeTruthy();
});

it('a rejected section read leaves identity visible and can be retried', async () => {
  const d = deps(); d.loadModules.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok([]));
  d.loadRelated.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok([]));
  await render(<TrailDetailView trailId="a" {...d} />);
  await waitFor(() => screen.getByTestId('trail-modules-retry'));
  expect(screen.getByText('Trail a')).toBeTruthy();
  expect(screen.getByTestId('trail-related-unavailable')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('trail-modules-retry'));
  await waitFor(() => screen.getByTestId('trail-modules-empty'));
});

it('a failed follow clears busy state and allows another attempt', async () => {
  const d = deps(); d.follow.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ state: 'done', status: 200, data: { following: true } });
  await render(<TrailDetailView trailId="a" {...d} />);
  await waitFor(() => screen.getByTestId('trail-follow'));
  await fireEvent.press(screen.getByTestId('trail-follow'));
  await waitFor(() => screen.getByTestId('trail-follow-error'));
  await fireEvent.press(screen.getByTestId('trail-follow'));
  await waitFor(() => screen.getByText('Following'));
});

it('a late Trail search cannot overwrite a newer search', async () => {
  const old = pending<any>(); const load = jest.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok([trail('b')]));
  await render(<TrailsBrowser onOpen={jest.fn()} onCreate={jest.fn()} load={load} loadMine={jest.fn().mockResolvedValue(ok([]))} />);
  await fireEvent.changeText(screen.getByTestId('trails-search'), 'new');
  await fireEvent.press(screen.getByTestId('trails-search-go'));
  await waitFor(() => screen.getByTestId('trail-row-b'));
  await act(async () => { old.resolve(ok([trail('a')])); });
  expect(screen.queryByTestId('trail-row-a')).toBeNull();
});

it('pages Trail content without duplicates, keeps loaded items on failure, and retries the same cursor', async () => {
  const item = (id: string) => ({ id, sourceType: 'post', sourceId: id });
  const loadMore = jest.fn().mockResolvedValueOnce(ok({ lists: [{ key: 'more', byPlace: {}, unplaced: [item('first'), item('second')] }], next: 'page-2' }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(ok({ lists: [{ key: 'more', byPlace: { place: [item('second'), item('third')] }, unplaced: [] }], next: null }));
  const onNavigate = jest.fn();
  await render(<TrailDetailView trailId="a" {...deps()} onNavigate={onNavigate} loadMore={loadMore}
    loadModules={jest.fn().mockResolvedValue(ok([{ key: 'local_picks', items: [item('first')] }]))} />);
  await waitFor(() => screen.getByTestId('trail-more'));
  await fireEvent.press(screen.getByTestId('trail-more'));
  await waitFor(() => screen.getByTestId('trail-more-content'));
  expect(screen.getAllByTestId('trail-item-first')).toHaveLength(1);
  await fireEvent.press(screen.getByTestId('trail-more'));
  await waitFor(() => screen.getByTestId('trail-more-error'));
  expect(screen.getByTestId('trail-item-second')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('trail-more'));
  await waitFor(() => expect(screen.queryByTestId('trail-more')).toBeNull());
  expect(loadMore.mock.calls).toEqual([['a', null], ['a', 'page-2'], ['a', 'page-2']]);
  expect(screen.getAllByTestId('trail-item-second')).toHaveLength(1);
  await fireEvent.press(screen.getByTestId('trail-item-third'));
  expect(onNavigate).toHaveBeenCalledWith('/post/third');
});

it('does not put a late More response into a different Trail', async () => {
  const old = pending<any>(); const d = deps();
  d.loadTrail.mockImplementation((id: string) => Promise.resolve(detail(id)));
  const view = await render(<TrailDetailView trailId="a" {...d} loadMore={() => old.promise} />);
  await waitFor(() => screen.getByTestId('trail-more'));
  await fireEvent.press(screen.getByTestId('trail-more'));
  await view.rerender(<TrailDetailView trailId="b" {...d} loadMore={() => old.promise} />);
  await waitFor(() => screen.getByText('Trail b'));
  await act(async () => { old.resolve(ok({ lists: [{ key: 'more', byPlace: {}, unplaced: [{ id: 'old', sourceType: 'post', sourceId: 'old' }] }], next: null })); });
  expect(screen.queryByTestId('trail-item-old')).toBeNull();
});
