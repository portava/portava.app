import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// NOTE: exhaustive explicit-erasure boundary; rendering and ordinary settings never perform network deletion.
jest.mock('../../../services/sensing/sensingErasure.ts', () => ({ eraseRecentSensingContributions: jest.fn(), isSensingErasurePending: jest.fn(async () => false), onSensingErasureChange: () => () => {} }));
import * as erasure from '../../../services/sensing/sensingErasure.ts';
import { SensingErasureControl } from '../SensingErasureControl.tsx';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
const erase = erasure.eraseRecentSensingContributions as jest.Mock;
let alert: jest.SpyInstance;
beforeEach(() => { jest.clearAllMocks(); setDiscoveryViewerFromSession('erase-ui'); alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
afterEach(() => { alert.mockRestore(); });
it('requires the explicit destructive action, then confirms the limited deletion without changing consent', async () => {
  erase.mockResolvedValue({ ok: true }); await render(<SensingErasureControl />);
  expect(erase).not.toHaveBeenCalled(); await fireEvent.press(screen.getByTestId('sensing-erase-recent'));
  expect(erase).not.toHaveBeenCalled(); expect(alert.mock.calls[0][1]).toContain('Your consent settings stay the same');
  const confirm = alert.mock.calls[0][2].find((button: { text: string }) => button.text === 'Delete');
  await act(async () => { confirm.onPress(); });
  await waitFor(() => expect(screen.getByText(/Previously published anonymous aggregates may remain/)).toBeTruthy()); expect(erase).toHaveBeenCalledTimes(1);
});
it('a failure reports a paused retry, never deletion success', async () => {
  erase.mockResolvedValue({ ok: false, reason: 'failed' }); await render(<SensingErasureControl />);
  await fireEvent.press(screen.getByTestId('sensing-erase-recent'));
  await act(async () => { alert.mock.calls[0][2][1].onPress(); });
  await waitFor(() => expect(screen.getByText(/Deletion could not be confirmed/)).toBeTruthy()); expect(screen.queryByText(/were removed/)).toBeNull();
});
