/**
 * LayoverPinnedTerminalCard — census-layover L143 ("terminal/gate context is
 * pinned") and L120 ("prioritize airport route/gate"), LAYOVER 165 lane
 * B2-CURATE. The server publishes `airport.terminalInfo` only for a curated,
 * validated, unexpired topology (3874); this card draws exactly that.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - a terminal, gate, checkpoint or link the topology does not state drawn as if it did;
 *   - a gate or link naming an undeclared terminal drawn anyway;
 *   - no topology rendered as an empty panel instead of the one honest sentence.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverPinnedTerminalCard, NO_CHECKED_TERMINAL, pinnedTerminalLines } from '../LayoverPinnedTerminalCard.tsx';

const TOPOLOGY = {
  terminals: [{ id: 'T1', name: 'Terminal 1', serves: ['international'] }, { id: 'T2', name: 'Terminal 2' }],
  gates: [{ terminalId: 'T1', label: 'Gates A1-A20' }, { terminalId: 'T9', label: 'Ghost gates' }],
  checkpoints: [{ id: 'S1', terminalId: 'T1', kind: 'security' }],
  walkingLinks: [{ fromTerminalId: 'T1', toTerminalId: 'T2', minutes: 12, mode: 'train' }],
};

describe('LayoverPinnedTerminalCard', () => {
  it('pins the curated terminals, gates, checkpoints and links — and nothing the topology does not declare', async () => {
    await render(<LayoverPinnedTerminalCard terminalInfo={TOPOLOGY} airportCode="ZZT" />);
    expect(screen.getByText('ZZT terminals')).toBeTruthy();
    expect(screen.getByText('Terminal 1 — international flights')).toBeTruthy();
    expect(screen.getByText('Terminal 2')).toBeTruthy();
    expect(screen.getByText('Gates A1-A20 — Terminal 1')).toBeTruthy();
    expect(screen.getByText('Security check — Terminal 1')).toBeTruthy();
    expect(screen.getByText('Terminal 1 → Terminal 2 by train, about 12 min')).toBeTruthy();
    expect(screen.queryByText(/Ghost gates/)).toBeNull();
    expect(screen.queryByTestId('layover-pinned-terminal-none')).toBeNull();
  });

  it('says plainly that there is no checked topology rather than drawing an empty panel', async () => {
    await render(<LayoverPinnedTerminalCard terminalInfo={null} airportCode="ZZU" />);
    expect(screen.getByTestId('layover-pinned-terminal-none').props.children).toBe(NO_CHECKED_TERMINAL);
  });

  it('skips malformed entries instead of guessing them into lines', () => {
    expect(pinnedTerminalLines({ terminals: [{ name: 'No id' }, 7, { id: 'T1' }], walkingLinks: [{ fromTerminalId: 'T1', toTerminalId: 'TX' }] }))
      .toEqual([{ key: 't:T1', text: 'T1' }]);
    expect(pinnedTerminalLines('nope')).toEqual([]);
  });
});
