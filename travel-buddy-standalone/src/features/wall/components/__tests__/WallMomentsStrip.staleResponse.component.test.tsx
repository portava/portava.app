/**
 * census-wall §19 — the moments strip shows the answer for the places the Live
 * strip shows NOW, not whichever request happened to finish last.
 *
 * The Live strip refreshes on its own clock, so the set of places asked about
 * changes under the moments strip. `run` awaited `load(...)` and called
 * `setRead` unconditionally: a slow answer for the OLD places that resolved
 * after the answer for the new ones overwrote it, and the strip showed changes
 * at places no longer on screen, labelled "A place near you" because their
 * names had left with them.
 *
 * Uses the component's own `load` seam so the two answers can be resolved in
 * the order that exposes the race.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

import { WallMomentsStrip } from '../WallMomentsStrip.tsx';
import type { MomentsRead, WallMomentView } from '../../services/wallMoments.ts';

const OLD = '11111111-aaaa-4aaa-8aaa-111111111111';
const NEW = '22222222-bbbb-4bbb-8bbb-222222222222';

function moment(id: string, subject: string): WallMomentView {
  return {
    id,
    subject: { kind: 'place', id: subject },
    transition: { kind: 'crowd_shift', claimType: 'crowd.level', from: 'busy', to: 'packed' },
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    reason: { code: 'crowd_shift', text: `changed at ${id}` },
    truthClass: 'corroborated',
    freshness: 'fresh',
    expiresAt: '',
    attention: { route: 'WALL', reasons: [], factors: {} },
  } as unknown as WallMomentView;
}

function okRead(m: WallMomentView): MomentsRead {
  return {
    state: 'ok',
    moments: [m],
    subjects: [{ subjectId: m.subject.id, refusal: null, moments: 1 }],
    liveIntelligenceReadable: true,
  };
}

it("a slow answer for the PREVIOUS places does not overwrite the current places' answer", async () => {
  let resolveOld: (r: MomentsRead) => void = () => {};
  const load = jest.fn((ids: string[]) =>
    ids.includes(OLD)
      ? new Promise<MomentsRead>((r) => { resolveOld = r; })
      : Promise.resolve(okRead(moment('m-new', NEW))),
  );

  const view = await render(
    <WallMomentsStrip liveItems={[{ subjectId: OLD, subject: { name: 'Old Place' } }]} load={load} />,
  );
  // The Live strip moves on before the first answer arrives.
  await view.rerender(
    <WallMomentsStrip liveItems={[{ subjectId: NEW, subject: { name: 'New Place' } }]} load={load} />,
  );
  expect(await view.findByTestId('wall-moment-m-new')).toBeTruthy();

  // …and only now does the answer about the old place come back.
  await act(async () => {
    resolveOld(okRead(moment('m-old', OLD)));
  });

  expect(view.queryByTestId('wall-moment-m-old')).toBeNull();
  expect(view.getByTestId('wall-moment-m-new')).toBeTruthy();
  expect(view.getByText('New Place')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

