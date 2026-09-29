/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-96): the "Suggested for your Circle" rail
 * over GET /circle/compass-suggestions' refusal.
 *
 * The route now builds a card only over reads that succeeded and names the rest in `refusal`
 * (`circle_suggestions_unread`, partial or nothing). The rail states no absence — it is a list of
 * prompts, each true on its own, and it never says "no suggestions" — so the honest rendering of a
 * refusal is: draw exactly the cards the server built, and never a card it did not send. A failed
 * request draws nothing (the rail was never a claim that there is nothing to suggest).
 *
 *   CS-R1  a partial refusal with one card → exactly that card, no "No meeting point" line from a failed read
 *   CS-R2  a `nothing` refusal with no card → no rail, and no card text
 *   CS-R3  a transport failure → no rail
 *   CS-Rc  CONTROL: a healthy body with a set_meeting_point card → its line is drawn
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetCompassSuggestions = jest.fn();
// NOTE: intentionally exhaustive — the rail imports only getCompassSuggestions, and the real service reaches Supabase on import.
jest.mock('../../services/circle.ts', () => ({
  getCompassSuggestions: (...args: unknown[]) => mockGetCompassSuggestions(...args),
}));
// NOTE: intentionally exhaustive — SessionContext reaches supabase auth on import; the rail reads only `isAuthed`.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ isAuthed: true }) }));
// NOTE: intentionally exhaustive — the rail uses only `router.push`, and nothing here navigates.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import { CircleCompassSuggestions } from '../CircleCompassSuggestions.tsx';

function allText(tree: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const children = (node as { children?: unknown[] }).children;
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out.join(' ');
}

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<CircleCompassSuggestions />); });
  await act(async () => { await Promise.resolve(); });
  return tree;
}

const card = (cardType: string, metadata: Record<string, unknown> = {}) => ({ cardType, contextType: 'trip', contextId: 't1', contextTitle: 'Lisbon crew', metadata });
const refusal = (coverage: 'partial' | 'nothing', failedSources: string[]) => ({ class: 'transient_db', code: 'circle_suggestions_unread', route: 'GET /circle/compass-suggestions', coverage, failedSources });

describe('CircleCompassSuggestions over a refused read (§110, D-W11X2-96)', () => {
  beforeEach(() => mockGetCompassSuggestions.mockReset());

  it('CS-R1 a partial refusal with one card → exactly that card, no line from the failed read', async () => {
    mockGetCompassSuggestions.mockResolvedValue({ ok: true, data: { cards: [card('circle_active', { activeCount: 2 })], refusal: refusal('partial', ['circle_meeting_points']) } });
    const text = allText(await render());
    expect(text).toContain('2 members sharing now');
    expect(text).not.toContain('No meeting point set yet');
    expect(text).not.toContain('Enable location sharing');
  });

  it("CS-R2 a 'nothing' refusal with no card → no rail, and no card text", async () => {
    mockGetCompassSuggestions.mockResolvedValue({ ok: true, data: { cards: [], refusal: refusal('nothing', ['trip_members']) } });
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });

  it('CS-R3 a transport failure → no rail', async () => {
    mockGetCompassSuggestions.mockResolvedValue({ ok: false, error: 'network_error' });
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });

  it('CS-Rc CONTROL: a healthy set_meeting_point card → its line is drawn', async () => {
    mockGetCompassSuggestions.mockResolvedValue({ ok: true, data: { cards: [card('set_meeting_point')] } });
    const text = allText(await render());
    expect(text).toContain('Suggested for your Circle');
    expect(text).toContain('No meeting point set yet');
  });
});
