import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { RecordingStampBadge } from '../RecordingStamp.tsx';
import { readRecordingStamp } from '../recordingStamp.ts';
const mockOwner = { isCurrent: () => true, invalidate: jest.fn() };
// NOTE: control the live authorization boundary to verify the badge never promotes a pending or revoked stamp.
jest.mock('../../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => mockOwner }));
jest.mock('../recordingStamp.ts', () => ({ ...jest.requireActual('../recordingStamp.ts'), readRecordingStamp: jest.fn() }));
const stamp = { id: 'issued-id', code: 'PV-7A100A77', targetType: 'post' as const, targetId: 'id', kind: 'portava_recording' as const, issuedAt: new Date().toISOString() };
it('shows the actual issued mark only after the live read and rechecks permission when tapped', async () => {
 let resolve!: (stamp: any) => void;
 jest.mocked(readRecordingStamp).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(null);
 const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
 try {
  await render(<RecordingStampBadge targetType="post" targetId="id" />);
  expect(screen.queryByText(stamp.code)).toBeNull();
  await act(async () => resolve(stamp));
  await fireEvent.press(await screen.findByLabelText('Verify Portava recording stamp ' + stamp.code));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Recording stamp unavailable'));
  expect(screen.queryByLabelText('Verify Portava recording stamp ' + stamp.code)).toBeNull();
 } finally { alert.mockRestore(); }
});
