/**
 * Discovery Trails, user-facing (owner decision 2026-10-04): browse, open,
 * follow, report, start. SHOWN RED FIRST: none of these components existed at
 * `2e46835263`. Each case asserts what the person SEES for each server answer —
 * in particular that a failure is never drawn as "no Trails" / "not following".
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TrailsBrowser } from '../TrailsBrowser.tsx';
import { TrailDetailView } from '../TrailDetailView.tsx';
import { TrailCreateForm } from '../TrailCreateForm.tsx';

const T = { id: 't1', slug: 's', title: 'Bangkok After Dark', description: 'Night markets and rooftops', destination: 'bangkok', parentTrailId: null, lifecycle: 'active', createdAt: '2026-09-01T00:00:00Z' };
const ok = <D,>(data: D) => ({ state: 'ok' as const, data });
const placeName = jest.fn().mockResolvedValue({ state: 'ok', data: { name: 'Talad Rot Fai', category: 'market' } });

describe('TrailsBrowser', () => {
  it('lists Trails and opens one; a failed read is said with Retry, never "no Trails"', async () => {
    const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' }).mockResolvedValue(ok([T]));
    const onOpen = jest.fn();
    await render(<TrailsBrowser initialDestination="Bangkok" onOpen={onOpen} onCreate={jest.fn()} load={load} />);
    await waitFor(() => screen.getByTestId('trails-unavailable'));
    expect(screen.queryByTestId('trails-empty')).toBeNull();
    expect(load).toHaveBeenCalledWith({ q: '', destination: 'Bangkok', limit: 50 });
    await fireEvent.press(screen.getByTestId('trails-retry'));
    await waitFor(() => screen.getByTestId('trail-row-t1'));
    await fireEvent.press(screen.getByTestId('trail-row-t1'));
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('switched off says so; an empty answer offers to start one', async () => {
    await render(<TrailsBrowser onOpen={jest.fn()} onCreate={jest.fn()} load={jest.fn().mockResolvedValue({ state: 'off' })} />);
    await waitFor(() => screen.getByTestId('trails-off'));
    const onCreate = jest.fn();
    await render(<TrailsBrowser initialDestination="Kyoto" onOpen={jest.fn()} onCreate={onCreate} load={jest.fn().mockResolvedValue(ok([]))} />);
    await waitFor(() => screen.getByTestId('trails-empty'));
    await fireEvent.press(screen.getByTestId('trails-create'));
    expect(onCreate).toHaveBeenCalledWith('Kyoto');
  });
});

describe('TrailDetailView', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    loadTrail: jest.fn().mockResolvedValue(ok({ trail: T, status: 'healthy', memberCount: 2 })),
    loadModules: jest.fn().mockResolvedValue(ok([
      { key: 'trending_now', objective: 'momentum', horizonMs: null, items: [{ id: 'c1', sourceType: 'place', sourceId: 'p1' }, { id: 'c2', sourceType: 'itinerary', sourceId: 'i1' }], moreFromThisPlace: {}, explorationSlots: null },
    ])),
    loadRelated: jest.fn().mockResolvedValue(ok([])),
    loadFollow: jest.fn().mockResolvedValue(ok(false)),
    follow: jest.fn().mockResolvedValue({ state: 'done', status: 200, data: { following: true } }),
    report: jest.fn().mockResolvedValue({ state: 'done', status: 202, data: { reported: true } }),
    loadPlaceName: placeName,
    ...over,
  });

  it('shows the Trail, its modules with resolved place names, and links only what the app can open', async () => {
    const onNavigate = jest.fn();
    await render(<TrailDetailView trailId="t1" onNavigate={onNavigate} {...deps()} />);
    await waitFor(() => screen.getByTestId('trail-detail'));
    await waitFor(() => screen.getByText('Talad Rot Fai'));
    expect(screen.getByText('Trending now')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('trail-item-c1'));
    expect(onNavigate).toHaveBeenCalledWith('/place/p1');
    expect(screen.getByText('Not viewable in the app')).toBeTruthy();
  });

  it('Follow shows the server\'s state, flips only on its answer, and an unreadable state is said — never "Follow"', async () => {
    const d = deps();
    await render(<TrailDetailView trailId="t1" onNavigate={jest.fn()} {...d} />);
    await waitFor(() => screen.getByTestId('trail-follow'));
    expect(screen.getByText('Follow')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('trail-follow'));
    await waitFor(() => screen.getByText('Following'));
    expect(d.follow).toHaveBeenCalledWith('t1', true);

    await render(<TrailDetailView trailId="t1" onNavigate={jest.fn()} {...deps({ loadFollow: jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 500' }) })} />);
    await waitFor(() => screen.getByTestId('trail-follow-unknown'));
    expect(screen.queryByTestId('trail-follow')).toBeNull();
  });

  it('a refused follow stays as it was and says why', async () => {
    await render(<TrailDetailView trailId="t1" onNavigate={jest.fn()} {...deps({ follow: jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'network error' }) })} />);
    await waitFor(() => screen.getByTestId('trail-follow'));
    await fireEvent.press(screen.getByTestId('trail-follow'));
    await waitFor(() => screen.getByTestId('trail-follow-error'));
    expect(screen.getByText('Follow')).toBeTruthy();
  });

  it('a report is "sent" only when the server accepted it', async () => {
    const report = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValue({ state: 'done', status: 202, data: { reported: true } });
    await render(<TrailDetailView trailId="t1" onNavigate={jest.fn()} {...deps({ report })} />);
    await waitFor(() => screen.getByTestId('trail-report-open'));
    await fireEvent.press(screen.getByTestId('trail-report-open'));
    await fireEvent.press(screen.getByTestId('trail-report-stale'));
    await waitFor(() => screen.getByTestId('trail-report-error'));
    expect(screen.queryByTestId('trail-report-sent')).toBeNull();
    await fireEvent.press(screen.getByTestId('trail-report-stale'));
    await waitFor(() => screen.getByTestId('trail-report-sent'));
    expect(report).toHaveBeenLastCalledWith('t1', 'stale');
  });

  it('unreadable modules are said — never "nothing has been added"', async () => {
    await render(<TrailDetailView trailId="t1" onNavigate={jest.fn()} {...deps({ loadModules: jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 503' }) })} />);
    await waitFor(() => screen.getByTestId('trail-modules-unavailable'));
    expect(screen.queryByTestId('trail-modules-empty')).toBeNull();
  });
});

describe('TrailCreateForm', () => {
  it('a §5 refusal names its check and offers to start under the suggested parent', async () => {
    const propose = jest.fn()
      .mockResolvedValueOnce({ state: 'canonicalization_refused', checks: [{ check: 'semantic_overlap', conflictsWith: 't9' }], suggestedParentTrailId: 't9' })
      .mockResolvedValue({ state: 'created', trail: { ...T, id: 't2', parentTrailId: 't9' } });
    const onCreated = jest.fn();
    await render(<TrailCreateForm initialDestination="Bangkok" onCreated={onCreated} propose={propose} />);
    await fireEvent.changeText(screen.getByTestId('trail-create-title'), 'Bangkok nightlife');
    await fireEvent.press(screen.getByTestId('trail-create-submit'));
    await waitFor(() => screen.getByTestId('trail-create-refused'));
    expect(screen.getByText('This overlaps an existing Trail.')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('trail-create-as-child'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(propose.mock.calls[1][0].parentTrailId).toBe('t9');
  });

  it('nothing is sent for a too-short name; a failed start is said and nothing is "created"', async () => {
    const propose = jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 503' });
    const onCreated = jest.fn();
    await render(<TrailCreateForm onCreated={onCreated} propose={propose} />);
    await fireEvent.changeText(screen.getByTestId('trail-create-title'), 'x');
    await fireEvent.press(screen.getByTestId('trail-create-submit'));
    expect(propose).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('trail-create-title'), 'Kyoto Hidden Temples');
    await fireEvent.press(screen.getByTestId('trail-create-submit'));
    await waitFor(() => screen.getByTestId('trail-create-error'));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
