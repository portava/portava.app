/**
 * census-trips TR256: PrivatePlacesCard — the owner's private places, the crew
 * switch per person, and places shared with the viewer.
 *
 * SHOWN RED FIRST: the component does not exist on `2e46835263`. The rules it
 * draws from are pinned in privateAnchors.test.ts; this file pins that the
 * card shows a grant only on the server's read-back, names failures, offers
 * revoke with sharing off, and draws nothing it was not told was the viewer's.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { PrivatePlacesCard, OWN_PLACE_DETAIL } from '../PrivatePlacesCard.tsx';

const layer = (items: unknown[]) => ({ status: 'ok', items });
const anchor = (id: string, relation: string, label: string | null = null) =>
  ({ id, kind: 'private_anchor', lat: 1, lng: 1, label, privateAnchor: true, meta: { relation } });
const proj = (privateAnchors: unknown) => jest.fn().mockResolvedValue({ state: 'ok', projection: { privateAnchors } });
const members = jest.fn().mockResolvedValue({ ok: true, data: { members: [
  { id: 'me', handle: 'me', name: 'Me', avatarUrl: null },
  { id: 'ben', handle: 'ben', name: 'Ben', avatarUrl: null },
] } });

it('shows the viewer\'s own and shared places, and nothing for an unscoped point', async () => {
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj(layer([anchor('h1', 'own', 'Hotel'), anchor('h2', 'shared_with_me'), { ...anchor('h3', 'own'), meta: {} }]))} loadMembers={members} />);
  await waitFor(() => screen.getByTestId('private-places'));
  expect(screen.getByTestId('private-place-h1')).toBeTruthy();
  expect(screen.getByTestId('shared-place-h2')).toBeTruthy();
  expect(screen.queryByTestId('private-place-h3')).toBeNull();
  expect(screen.queryByTestId('shared-place-h3')).toBeNull();
});

it('a grant shows as made only from the server\'s read-back; a refusal is said and changes nothing', async () => {
  const loadShares = jest.fn().mockResolvedValue({ state: 'ok', data: { sharingEnabled: true, memberIds: [] } });
  const grant = jest.fn()
    .mockResolvedValueOnce({ state: 'refused', status: 403, reason: 'forbidden', detail: 'Only the person who added a private place can share it' })
    .mockResolvedValueOnce({ state: 'done', status: 201, data: { ok: true, sharingEnabled: true, memberIds: ['ben'] } });
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj(layer([anchor('h1', 'own')]))} loadMembers={members} loadShares={loadShares} grant={grant} />);
  await waitFor(() => screen.getByTestId('private-place-h1'));
  await fireEvent.press(screen.getByTestId('private-place-h1'));
  await waitFor(() => screen.getByTestId('anchor-share-toggle-ben'));
  expect(screen.queryByTestId('anchor-share-toggle-me')).toBeNull();
  await fireEvent(screen.getByTestId('anchor-share-toggle-ben'), 'valueChange', true);
  await waitFor(() => screen.getByTestId('anchor-share-failure'));
  expect(screen.getByTestId('anchor-share-toggle-ben').props.value).toBe(false);
  await fireEvent(screen.getByTestId('anchor-share-toggle-ben'), 'valueChange', true);
  await waitFor(() => expect(screen.getByTestId('anchor-share-toggle-ben').props.value).toBe(true));
  expect(grant).toHaveBeenCalledWith('t1', 'h1', 'ben');
});

it('with sharing off the card says so, cannot grant, and still lets the owner take a grant back', async () => {
  const loadShares = jest.fn().mockResolvedValue({ state: 'ok', data: { sharingEnabled: false, memberIds: ['ben'] } });
  const revoke = jest.fn().mockResolvedValue({ state: 'done', status: 200, data: { ok: true, sharingEnabled: false, memberIds: [] } });
  const twoMembers = jest.fn().mockResolvedValue({ ok: true, data: { members: [
    { id: 'ben', handle: 'ben', name: 'Ben', avatarUrl: null },
    { id: 'cleo', handle: 'cleo', name: 'Cleo', avatarUrl: null },
  ] } });
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj(layer([anchor('h1', 'own')]))} loadMembers={twoMembers} loadShares={loadShares} revoke={revoke} />);
  await waitFor(() => screen.getByTestId('private-place-h1'));
  await fireEvent.press(screen.getByTestId('private-place-h1'));
  await waitFor(() => screen.getByTestId('anchor-share-off'));
  expect(screen.getByTestId('anchor-share-toggle-cleo').props.disabled).toBe(true);
  await fireEvent(screen.getByTestId('anchor-share-toggle-ben'), 'valueChange', false);
  await waitFor(() => expect(screen.getByTestId('anchor-share-toggle-ben').props.value).toBe(false));
  expect(revoke).toHaveBeenCalledWith('t1', 'h1', 'ben');
});

it('an unreadable layer or grant list is named, never shown as "nothing shared"', async () => {
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj({ status: 'unread', reason: 'down' })} loadMembers={members} />);
  await waitFor(() => screen.getByTestId('private-places-unread'));
  const loadShares = jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 503' });
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj(layer([anchor('h1', 'own')]))} loadMembers={members} loadShares={loadShares} />);
  await waitFor(() => screen.getByTestId('private-place-h1'));
  await fireEvent.press(screen.getByTestId('private-place-h1'));
  await waitFor(() => screen.getByTestId('anchor-share-unread'));
});

it('census-trips §81: an own place says what the crew sees — a slot, not the place — and promises no choice the picker has not offered', async () => {
  // Was "Only you, and anyone you choose, can see this place": the crew sees a
  // "Private plan" slot at that time, and with sharing off no one can be chosen.
  await render(<PrivatePlacesCard tripId="t1" currentUserId="me" load={proj(layer([anchor('h1', 'own', 'Hotel')]))} loadMembers={members} />);
  await waitFor(() => screen.getByTestId('private-places'));
  expect(screen.getByText(OWN_PLACE_DETAIL)).toBeTruthy();
  expect(OWN_PLACE_DETAIL).toMatch(/private plan at this time/);
  expect(screen.queryByText(/anyone you choose/)).toBeNull();
  expect(screen.getByTestId('private-place-h1').props.accessibilityLabel).not.toMatch(/Only you can see it/);
});
