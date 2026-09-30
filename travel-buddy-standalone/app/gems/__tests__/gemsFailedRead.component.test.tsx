/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-123, D-W11X2-124; D-W11X2-111's client leg
 * corrected): the Hidden Gems screens never render a failed read as empty, and no hook holds a stale answer.
 *
 * The round-14 verifier's probes, copied in (V14-GL0, GL1, GL2; the service mock also stubs getGem and
 * getTripcityGems for this lane's cases), and this lane's:
 *   GL3  the Layover tab over a failed read → the error and a Retry; Retry reads again and draws the gems
 *   GL4  useLayoverGems: the 2 h answer lands after the 3 h one → the 3 h gems are held, and an error is kept
 *   GL5  useGemList: a new query shows nothing of the old one while it is read
 *   GL6  useGemDetail: gem A answers after gem B → B is held; B's own read failing never shows A
 *   GL7  useTripCityGems: trip A answers after trip B → B's gems are held
 *   GL8  useSavedGems: the first of two refreshes answers last → the second's gems are held
 *   GLc  CONTROL: a healthy Layover read draws its gems with no error
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act, renderHook, cleanup } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// NOTE: exhaustive on purpose — the Gems screen imports only getCurrentGps from here (the round-14 verifier's probe, copied in).
jest.mock('../../../src/services/location', () => ({ getCurrentGps: jest.fn(async () => null) }));
jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  listGems: jest.fn(async () => []), getSavedGems: jest.fn(async () => []), getLayoverGems: jest.fn(async () => []),
  getGem: jest.fn(), getTripcityGems: jest.fn(async () => []),
}));
import GemsScreen from '../index.tsx';
import { listGems, getLayoverGems, getGem, getSavedGems, getTripcityGems } from '../../../src/services/hiddenGems';
import { useGemList, useGemDetail, useSavedGems, useTripCityGems, useLayoverGems } from '../../../src/hooks/useHiddenGems';

const gem = (id: string, city: string) => ({ id, name: `Gem ${id}`, category: 'food', city, country: null, neighborhood: null, description: null, latitude: null, longitude: null, approxLatitude: null, approxLongitude: null, vibeTags: [], priceRange: null, safetyNotes: null, bestTimeToGo: null, localEtiquette: null, layoverSafe: true, minimumLayoverMinutes: 60, sensitivityLevel: 'public', verificationLevel: 'unverified', status: 'active', submittedBy: null, imageUrl: null, canonicalPlaceId: null, saveCount: 0, visitCount: 0, createdAt: '', updatedAt: '', gemState: null, gemConfidence: null, visitOutcomes: null });
afterEach(() => { cleanup(); jest.clearAllMocks(); });

describe('v14: the Hidden Gems screens over a failed read', () => {
  it('V14-GL0 CONTROL: Layover tab, a healthy empty answer → "No quick gems nearby"', async () => {
    (getLayoverGems as jest.Mock).mockResolvedValue([]);
    await render(<GemsScreen />);
    await act(async () => { fireEvent.press(screen.getByText('Layover')); });
    await waitFor(() => expect(screen.getByText('No quick gems nearby')).toBeTruthy());
  });
  it('V14-GL1 Layover tab, the read FAILS (503 flag_unreadable) → never "No quick gems nearby"', async () => {
    (getLayoverGems as jest.Mock).mockRejectedValue(Object.assign(new Error('Hidden gems could not be checked right now. Please try again shortly.'), { status: 503, code: 'degraded_unavailable' }));
    await render(<GemsScreen />);
    await act(async () => { fireEvent.press(screen.getByText('Layover')); });
    await waitFor(() => expect((getLayoverGems as jest.Mock).mock.calls.length).toBeGreaterThan(0));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const saysEmpty = screen.queryByText('No quick gems nearby') !== null;
    console.log('V14-GL1 says "No quick gems nearby" over a failed read:', saysEmpty);
    expect(saysEmpty).toBe(false);
  });
  it("V14-GL2 useGemList: city A answers after city B → the hook holds city B's gems", async () => {
    let releaseA: (v: unknown) => void = () => {};
    (listGems as jest.Mock).mockImplementation((o: any) => (o.city === 'Lisbon' ? new Promise((r) => { releaseA = r; }) : Promise.resolve([gem('b1', 'Porto')])));
    const { result, rerender } = await renderHook((p: { city: string }) => useGemList({ city: p.city }), { initialProps: { city: 'Lisbon' } });
    await rerender({ city: 'Porto' });
    await waitFor(() => expect(result.current.gems.map((g: any) => g.id)).toEqual(['b1']));
    await act(async () => { releaseA([gem('a1', 'Lisbon')]); await new Promise((r) => setTimeout(r, 10)); });
    console.log('V14-GL2 gems after the late Lisbon answer, query Porto:', JSON.stringify(result.current.gems.map((g: any) => `${g.id}@${g.city}`)));
    expect(result.current.gems.map((g: any) => g.city)).toEqual(['Porto']);
  });
});

const deferred = () => { let resolve: (v: any) => void = () => {}; let reject: (e: any) => void = () => {}; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('§112: the Hidden Gems hooks and the Layover tab (D-W11X2-123, D-W11X2-124)', () => {
  it('GL3 the Layover tab over a failed read → the error and a Retry; Retry reads again and draws the gems', async () => {
    (getLayoverGems as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('Hidden gems could not be checked right now. Please try again shortly.'), { status: 503 }));
    await render(<GemsScreen />);
    await act(async () => { fireEvent.press(screen.getByText('Layover')); });
    await waitFor(() => expect(screen.getByText('Hidden gems could not be checked right now. Please try again shortly.')).toBeTruthy());
    expect(screen.queryByText('No quick gems nearby')).toBeNull();
    (getLayoverGems as jest.Mock).mockResolvedValueOnce([gem('l1', 'Lisbon')]);
    await act(async () => { fireEvent.press(screen.getByText('Retry')); });
    await waitFor(() => expect(screen.getByText('Gem l1')).toBeTruthy());
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('GL4 useLayoverGems: a late answer for an older window is not held; a failure is an error, not an empty list', async () => {
    const two = deferred();
    (getLayoverGems as jest.Mock).mockImplementation((m: number) => (m === 120 ? two.promise : Promise.resolve([gem('t3', 'Lisbon')])));
    const { result, rerender } = await renderHook((p: { m: number }) => useLayoverGems(p.m), { initialProps: { m: 120 } });
    await rerender({ m: 180 });
    await waitFor(() => expect(result.current.gems.map((g: any) => g.id)).toEqual(['t3']));
    await act(async () => { two.resolve([gem('t2', 'Lisbon')]); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.gems.map((g: any) => g.id)).toEqual(['t3']);
    (getLayoverGems as jest.Mock).mockImplementation(() => Promise.reject(new Error('offline')));
    await rerender({ m: 300 });
    await waitFor(() => expect((result.current as any).error).toBe('offline'));
    expect(result.current.gems).toEqual([]);
  });

  it('GL5 useGemList: a new query shows nothing of the old one while it is read', async () => {
    const porto = deferred();
    (listGems as jest.Mock).mockImplementation((o: any) => (o.city === 'Porto' ? porto.promise : Promise.resolve([gem('a1', 'Lisbon')])));
    const { result, rerender } = await renderHook((p: { city: string }) => useGemList({ city: p.city }), { initialProps: { city: 'Lisbon' } });
    await waitFor(() => expect(result.current.gems.map((g: any) => g.id)).toEqual(['a1']));
    await rerender({ city: 'Porto' });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.gems).toEqual([]);
    await act(async () => { porto.resolve([gem('b1', 'Porto')]); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.gems.map((g: any) => g.id)).toEqual(['b1']);
  });

  it("GL6 useGemDetail: gem A answers after gem B → B is held; B's read failing never shows A", async () => {
    const a = deferred();
    (getGem as jest.Mock).mockImplementation((id: string) => (id === 'A' ? a.promise : Promise.resolve({ gem: gem('B', 'Porto'), savedByMe: false, guideProfile: null })));
    const { result, rerender } = await renderHook((p: { id: string }) => useGemDetail(p.id), { initialProps: { id: 'A' } });
    await rerender({ id: 'B' });
    await waitFor(() => expect(result.current.gem?.id).toBe('B'));
    await act(async () => { a.resolve({ gem: gem('A', 'Lisbon'), savedByMe: true, guideProfile: null }); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.gem?.id).toBe('B');
    expect(result.current.savedByMe).toBe(false);
    (getGem as jest.Mock).mockImplementation((id: string) => (id === 'A' ? Promise.resolve({ gem: gem('A', 'Lisbon'), savedByMe: false, guideProfile: null }) : Promise.reject(new Error('offline'))));
    const second = await renderHook((p: { id: string }) => useGemDetail(p.id), { initialProps: { id: 'A' } });
    await waitFor(() => expect(second.result.current.gem?.id).toBe('A'));
    await second.rerender({ id: 'B' });
    await waitFor(() => expect(second.result.current.error).toBe('offline'));
    expect(second.result.current.gem).toBeNull();
  });

  it("GL7 useTripCityGems: trip A answers after trip B → B's gems are held", async () => {
    const a = deferred();
    (getTripcityGems as jest.Mock).mockImplementation((t: string) => (t === 'tA' ? a.promise : Promise.resolve([gem('b1', 'Porto')])));
    const { result, rerender } = await renderHook((p: { t: string }) => useTripCityGems(p.t), { initialProps: { t: 'tA' } });
    await rerender({ t: 'tB' });
    await waitFor(() => expect(result.current.gems.map((g: any) => g.id)).toEqual(['b1']));
    await act(async () => { a.resolve([gem('a1', 'Lisbon')]); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.gems.map((g: any) => g.id)).toEqual(['b1']);
  });

  it("GL8 useSavedGems: the first of two refreshes answers last → the second's gems are held", async () => {
    const first = deferred();
    (getSavedGems as jest.Mock).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => Promise.resolve([gem('s2', 'Porto')]));
    const { result } = await renderHook(() => useSavedGems());
    await act(async () => { void result.current.refresh(); });
    await waitFor(() => expect(result.current.gems.map((g: any) => g.id)).toEqual(['s2']));
    await act(async () => { first.resolve([gem('s1', 'Lisbon')]); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.gems.map((g: any) => g.id)).toEqual(['s2']);
    expect(result.current.loading).toBe(false);
  });

  it('GLc CONTROL: a healthy Layover read draws its gems with no error or Retry', async () => {
    (getLayoverGems as jest.Mock).mockResolvedValue([gem('l9', 'Lisbon')]);
    await render(<GemsScreen />);
    await act(async () => { fireEvent.press(screen.getByText('Layover')); });
    await waitFor(() => expect(screen.getByText('Gem l9')).toBeTruthy());
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('No quick gems nearby')).toBeNull();
  });
});
