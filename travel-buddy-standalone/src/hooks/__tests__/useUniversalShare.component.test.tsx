/**
 * useUniversalShare — share controller lifecycle.
 *
 * Run: pnpm test:component -- --testPathPattern=useUniversalShare
 *
 * ## What's covered (the §27 "Share controller" cases)
 *
 *  1. open   — starts closed; openShare exposes the entity and the source surface
 *  2. close  — closeShare clears everything; closing twice is a no-op
 *  3. replace— openShare while already open swaps the entity in place, keeps
 *              the sheet open, and updates the source surface
 *  4. clear  — no stale entity is readable after close, and reopening starts
 *              from a clean session
 *
 * ## Why this test needs no sheet
 *
 * The controller renders nothing and imports no UI, so renderHook alone
 * exercises it end to end. That is the whole reason the data layer was built
 * before the sheet.
 *
 * `sequence` is asserted because per-share UI state (recipient selection,
 * scroll position) will key off it: a replace must look different from a
 * re-render, or the sheet will keep the previous entity's selections.
 */
import { renderHook, act } from '@testing-library/react-native';
import { useUniversalShare } from '../useUniversalShare.ts';
import type { ShareableEntity } from '../../types/models.ts';

function makeEntity(overrides: Partial<ShareableEntity> = {}): ShareableEntity {
  return {
    entityType: 'event',
    entityId: 'ev-1',
    title: 'Jazz Night',
    subtitle: 'Lisbon',
    description: null,
    imageUrl: null,
    creator: null,
    location: null,
    canonicalUrl: 'https://portava.replit.app/event/ev-1',
    metadata: {},
    allowedDestinations: ['dm', 'external'],
    // Real ShareActionIds. 'send_in_app' is not one, and shareActionRegistry
    // silently ignores an id it does not know — so the fixture was asking for an
    // action that could never resolve.
    allowedActions: ['send_to_traveler', 'copy_link'],
    ...overrides,
  };
}

describe('useUniversalShare', () => {
  // ── 1. open ────────────────────────────────────────────────────────────────

  it('starts closed with no entity', async () => {
    const { result } = await renderHook(() => useUniversalShare());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeEntity).toBeNull();
    expect(result.current.activeSession).toBeNull();
  });

  it('openShare exposes the entity and the source surface', async () => {
    const { result } = await renderHook(() => useUniversalShare());
    const entity = makeEntity();

    await act(async () => { result.current.openShare(entity, { sourceSurface: 'event_detail_header' }); });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeEntity).toBe(entity);
    expect(result.current.activeSession?.sourceSurface).toBe('event_detail_header');
    expect(result.current.activeSession?.sequence).toBe(1);
  });

  // ── 2. close ───────────────────────────────────────────────────────────────

  it('closeShare clears the session', async () => {
    const { result } = await renderHook(() => useUniversalShare());

    await act(async () => { result.current.openShare(makeEntity(), { sourceSurface: 'pulse_card' }); });
    expect(result.current.isOpen).toBe(true);

    await act(async () => { result.current.closeShare(); });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeEntity).toBeNull();
    expect(result.current.activeSession).toBeNull();
  });

  it('closing an already-closed controller is a no-op', async () => {
    const { result } = await renderHook(() => useUniversalShare());
    await act(async () => { result.current.closeShare(); });
    await act(async () => { result.current.closeShare(); });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeSession).toBeNull();
  });

  // ── 3. replace while open ──────────────────────────────────────────────────

  it('replacing the active entity while open works and keeps the sheet open', async () => {
    const { result } = await renderHook(() => useUniversalShare());
    const first = makeEntity({ entityId: 'ev-1', title: 'Jazz Night' });
    const second = makeEntity({ entityType: 'trip', entityId: 'tr-9', title: 'Luzon loop' });

    await act(async () => { result.current.openShare(first, { sourceSurface: 'event_detail_header' }); });
    await act(async () => { result.current.openShare(second, { sourceSurface: 'trip_detail_header' }); });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeEntity).toBe(second);
    expect(result.current.activeEntity?.entityType).toBe('trip');
    expect(result.current.activeSession?.sourceSurface).toBe('trip_detail_header');
  });

  it('bumps sequence on every open, including a replace', async () => {
    const { result } = await renderHook(() => useUniversalShare());

    await act(async () => { result.current.openShare(makeEntity(), { sourceSurface: 'a' }); });
    expect(result.current.activeSession?.sequence).toBe(1);

    await act(async () => { result.current.openShare(makeEntity({ entityId: 'ev-2' }), { sourceSurface: 'b' }); });
    expect(result.current.activeSession?.sequence).toBe(2);

    await act(async () => { result.current.closeShare(); });
    await act(async () => { result.current.openShare(makeEntity({ entityId: 'ev-3' }), { sourceSurface: 'c' }); });
    expect(result.current.activeSession?.sequence).toBe(3);
  });

  it('replacing with the same entity still counts as a new share', async () => {
    const { result } = await renderHook(() => useUniversalShare());
    const entity = makeEntity();

    await act(async () => { result.current.openShare(entity, { sourceSurface: 'a' }); });
    await act(async () => { result.current.openShare(entity, { sourceSurface: 'a' }); });

    // Same entity object, but two distinct share attempts — analytics and any
    // per-share UI state must be able to tell them apart.
    expect(result.current.activeSession?.sequence).toBe(2);
  });

  // ── 4. clear ───────────────────────────────────────────────────────────────

  it('leaves no stale entity readable after close', async () => {
    const { result } = await renderHook(() => useUniversalShare());

    await act(async () => { result.current.openShare(makeEntity({ title: 'Secret trip' }), { sourceSurface: 'a' }); });
    await act(async () => { result.current.closeShare(); });

    // isOpen and the entity live in one object, so they cannot disagree.
    expect(result.current.activeSession).toBeNull();
    expect(result.current.activeEntity).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it('reopening after close starts a clean session', async () => {
    const { result } = await renderHook(() => useUniversalShare());

    await act(async () => { result.current.openShare(makeEntity({ entityId: 'first' }), { sourceSurface: 'a' }); });
    await act(async () => { result.current.closeShare(); });
    await act(async () => { result.current.openShare(makeEntity({ entityId: 'second' }), { sourceSurface: 'b' }); });

    expect(result.current.activeEntity?.entityId).toBe('second');
    expect(result.current.activeSession?.sourceSurface).toBe('b');
  });

  // ── identity ───────────────────────────────────────────────────────────────

  it('keeps openShare and closeShare stable across renders', async () => {
    const { result, rerender } = await renderHook(() => useUniversalShare());
    const open = result.current.openShare;
    const close = result.current.closeShare;

    rerender({});
    await act(async () => { result.current.openShare(makeEntity(), { sourceSurface: 'a' }); });

    // Stable identities let triggers pass these into memoized children without
    // re-rendering the whole screen on every share.
    expect(result.current.openShare).toBe(open);
    expect(result.current.closeShare).toBe(close);
  });
});
