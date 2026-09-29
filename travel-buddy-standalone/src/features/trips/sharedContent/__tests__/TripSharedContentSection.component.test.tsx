/**
 * TRIP-F24: TripSharedContentSection — each tab's three states and its writes.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripSharedContentSection, parseLocalDateTime } from '../TripSharedContentSection.tsx';
import * as real from '../tripSharedContent.ts';

function client(over: Partial<typeof real> = {}): typeof real {
  return {
    ...real,
    fetchNotes: jest.fn().mockResolvedValue({ state: 'ok', data: [] }),
    fetchDocuments: jest.fn().mockResolvedValue({ state: 'ok', data: [] }),
    fetchChecklists: jest.fn().mockResolvedValue({ state: 'ok', data: [] }),
    fetchTripReminders: jest.fn().mockResolvedValue({ state: 'ok', data: [] }),
    fetchActivity: jest.fn().mockResolvedValue({ state: 'ok', data: [] }),
    reminderAlertsHere: jest.fn().mockResolvedValue(new Set()),
    ...over,
  } as typeof real;
}

it('notes: an empty list says so; a new note is sent and the list re-read', async () => {
  const c = client({
    fetchNotes: jest.fn().mockResolvedValueOnce({ state: 'ok', data: [] })
      .mockResolvedValue({ state: 'ok', data: [{ id: 'n1', title: null, content: 'Bring adapters', is_private: false, author_id: 'u', created_at: '2026-09-01T00:00:00Z' }] }),
    createNote: jest.fn().mockResolvedValue({ state: 'done', data: {}, status: 201 }),
  });
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  await waitFor(() => screen.getByTestId('shared-notes-empty'));
  await fireEvent.changeText(screen.getByTestId('shared-note-input'), 'Bring adapters');
  await fireEvent.press(screen.getByTestId('shared-note-add'));
  await waitFor(() => screen.getByTestId('shared-note-n1'));
  expect(c.createNote).toHaveBeenCalledWith('t1', { title: null, content: 'Bring adapters', isPrivate: false });
});

it('a failed read is not an empty list: it says so and retries', async () => {
  const c = client({ fetchNotes: jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 500' }).mockResolvedValue({ state: 'ok', data: [] }) });
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  await waitFor(() => screen.getByTestId('shared-notes-unavailable'));
  expect(screen.queryByTestId('shared-notes-empty')).toBeNull();
  await fireEvent.press(screen.getByTestId('shared-notes-unavailable-retry'));
  await waitFor(() => screen.getByTestId('shared-notes-empty'));
});

it('documents: a write the server refused is shown, and a document body is read by id', async () => {
  const c = client({
    fetchDocuments: jest.fn().mockResolvedValue({ state: 'ok', data: [{ id: 'd1', title: 'Flight', document_type: 'itinerary', is_private: false, creator_id: 'u', created_at: 'x', updated_at: null }] }),
    fetchDocument: jest.fn().mockResolvedValue({ state: 'ok', data: { id: 'd1', title: 'Flight', content: 'TP 123', document_type: 'itinerary', is_private: false, creator_id: 'u', created_at: 'x', updated_at: null } }),
    createDocument: jest.fn().mockResolvedValue({ state: 'refused', status: 403, reason: 'not_member', detail: 'Not a trip member' }),
  });
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  await fireEvent.press(screen.getByTestId('shared-tab-documents'));
  await waitFor(() => screen.getByTestId('shared-doc-d1'));
  await fireEvent.press(screen.getByTestId('shared-doc-d1'));
  await waitFor(() => screen.getByTestId('shared-doc-body-d1'));
  await fireEvent.changeText(screen.getByTestId('shared-doc-title'), 'Visa');
  await fireEvent.press(screen.getByTestId('shared-doc-add'));
  await waitFor(() => screen.getByText('Not a trip member'));
});

it('checklists: an item is ticked only when the server answers', async () => {
  const list = { id: 'c1', title: 'Packing', createdBy: 'u', createdAt: 'x', items: [{ id: 'i1', label: 'Passport', is_done: false, assigned_to: null, due_date: null, sort_order: 0 }] };
  const c = client({
    fetchChecklists: jest.fn().mockResolvedValue({ state: 'ok', data: [list] }),
    setChecklistItemDone: jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'offline' }).mockResolvedValue({ state: 'done', data: {}, status: 200 }),
  });
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  await fireEvent.press(screen.getByTestId('shared-tab-checklists'));
  await waitFor(() => screen.getByTestId('shared-checklist-item-i1'));
  await fireEvent.press(screen.getByTestId('shared-checklist-item-i1'));
  await waitFor(() => screen.getByTestId('shared-write-error'));
  expect(screen.getByText('0 of 1 done')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('shared-checklist-item-i1'));
  await waitFor(() => screen.getByText('1 of 1 done'));
});

it('reminders: says which ring on this device; a bad time is refused before sending', async () => {
  const c = client({
    fetchTripReminders: jest.fn().mockResolvedValue({ state: 'ok', data: [
      { id: 'r1', title: 'Check in', remind_at: '2030-01-01T08:00:00Z', is_sent: false, created_at: 'x' },
      { id: 'r2', title: 'Taxi', remind_at: '2030-01-02T08:00:00Z', is_sent: false, created_at: 'x' },
    ] }),
    reminderAlertsHere: jest.fn().mockResolvedValue(new Set(['r1'])),
    createTripReminder: jest.fn(),
  });
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  await fireEvent.press(screen.getByTestId('shared-tab-reminders'));
  await waitFor(() => screen.getByText(/rings on this device/));
  expect(screen.getByText(/set on another device/)).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('shared-reminder-title'), 'x');
  await fireEvent.changeText(screen.getByTestId('shared-reminder-when'), 'tomorrow');
  await fireEvent.press(screen.getByTestId('shared-reminder-add'));
  await waitFor(() => screen.getByText('Give it a title and a time as YYYY-MM-DD HH:MM.'));
  expect(c.createTripReminder).not.toHaveBeenCalled();
});

it('activity is a host tab; a 403 is "hosts only", not an empty feed', async () => {
  const c = client({ fetchActivity: jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'forbidden', status: 403 }) });
  const r = await render(<TripSharedContentSection tripId="t1" isHost={false} client={c} />);
  expect(r.queryByTestId('shared-tab-activity')).toBeNull();
  const h = await render(<TripSharedContentSection tripId="t1" isHost client={c} />);
  await fireEvent.press(h.getByTestId('shared-tab-activity'));
  await waitFor(() => h.getByTestId('shared-activity-hosts-only'));
});

it('parses a local date-time and rejects anything else', () => {
  expect(parseLocalDateTime('2030-01-01 08:30')).toBe(new Date(2030, 0, 1, 8, 30).toISOString());
  expect(parseLocalDateTime('tomorrow')).toBeNull();
});
