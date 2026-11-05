/**
 * census-telegraph T212 / T213 / T390 / T201 — "Add people" on a direct conversation, client side.
 *
 * Pins:
 *   - the sheet says, before anything is sent, that this starts a NEW group and the DM stays private;
 *   - it sends exactly the people picked, and only the plans/places TICKED, by kind and canonical id;
 *   - a refusal is the server's sentence and nothing navigates; success hands back the NEW group's id;
 *   - nothing can be created with nobody picked;
 *   - only plans (meetups) and places are offered to bring along, never anything past;
 *   - the body is shaped for the server's strict schema (no empty list, no blank title, no duplicates);
 *   - the projection offers the entry only on an affirmative, non-degraded canInvite;
 *   - the thread screen mounts the entry for a DM, gated on that projection, and opens the new group.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('../groups/addPeopleApi.ts', () => {
  const actual = jest.requireActual('../groups/addPeopleApi.ts');
  return { ...actual, addPeopleToConversation: jest.fn() };
});
jest.mock('../../../hooks/useTelegraphRecipients.ts', () => ({ ...jest.requireActual('../../../hooks/useTelegraphRecipients.ts'), useTelegraphRecipients: jest.fn() }));
jest.mock('../sharedContext/api.ts', () => ({ ...jest.requireActual('../sharedContext/api.ts'), fetchSharedContext: jest.fn() }));

import { AddPeopleSheet, ADD_PEOPLE_NEW_GROUP_COPY, carryForwardCandidates } from '../groups/AddPeopleSheet.tsx';
import { addPeopleToConversation, buildAddPeopleBody } from '../groups/addPeopleApi.ts';
import { useTelegraphRecipients } from '../../../hooks/useTelegraphRecipients.ts';
import { fetchSharedContext } from '../sharedContext/api.ts';
import { offersAddPeople, toProjectionState } from '../conversation/conversationProjection.ts';

const mockedAdd = addPeopleToConversation as jest.MockedFunction<typeof addPeopleToConversation>;
const mockedRecipients = useTelegraphRecipients as jest.MockedFunction<typeof useTelegraphRecipients>; const recordPick = jest.fn();
const mockedRail = fetchSharedContext as jest.MockedFunction<typeof fetchSharedContext>;

const DM = 'dm-1';
const CARA = { userId: 'u-cara', name: 'Cara', handle: 'cara', avatarUrl: null, subtitle: '@cara', reason: null, source: 'search' as any };
const DAN = { userId: 'u-dan', name: 'Dan', handle: 'dan', avatarUrl: null, subtitle: '@dan', reason: null, source: 'search' as any };

function item(objectType: string, objectId: string, title: string): any {
  return { objectType, objectId, title, relationship: 'BOTH', status: 'open', availableActions: [], orderBand: 'UPCOMING' };
}
function rail(over: Partial<Record<'now' | 'upcoming' | 'unresolved' | 'past', any[]>> = {}): any {
  return {
    ok: true,
    data: {
      sharedContext: { conversationId: DM, generatedAt: '', now: [], upcoming: [], unresolved: [], past: [], ...over },
      railMode: 'COMPACT_UPCOMING', collapsedSummary: '', incomplete: false, refusedCount: 0,
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockedAdd.mockReset();
  mockedRecipients.mockReset(); recordPick.mockReset();
  mockedRail.mockReset();
  mockedRail.mockResolvedValue(rail());
  mockedRecipients.mockImplementation((_q, o) => ({ recipients: o?.enabled ? [CARA, DAN] : [], loading: false, unavailable: false, recordPick }));
});
afterEach(() => {
  jest.useRealTimers();
});

async function settle() {
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
}

async function search(q: string) {
  await fireEvent.changeText(screen.getByTestId('add-people-search'), q);
  await act(async () => { await jest.advanceTimersByTimeAsync(350); });
}

describe('AddPeopleSheet', () => {
  it('says it starts a NEW group and the DM stays private, before anything is sent', async () => {
    await render(<AddPeopleSheet visible threadId={DM} partnerName="Bea" onClose={() => {}} onCreated={() => {}} />);
    await settle();
    const copy = screen.getByTestId('add-people-new-group-copy');
    expect(copy.props.children).toContain('new group');
    expect(copy.props.children).toContain('Your conversation with Bea stays private');
    expect(ADD_PEOPLE_NEW_GROUP_COPY).toContain('cannot read it');
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('nothing can be created with nobody picked', async () => {
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={() => {}} />);
    await settle();
    const create = screen.getByTestId('add-people-create');
    expect(create.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(create);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('sends exactly the people picked and only the ticked plans/places, then hands back the NEW group', async () => {
    mockedRail.mockResolvedValue(rail({ upcoming: [item('MEETUP', 'm-1', 'Dinner'), item('PLACE', 'p-1', 'Night market'), item('TRIP', 't-1', 'Hanoi')] }));
    mockedAdd.mockResolvedValue({ ok: true, data: { threadId: 'grp-9', memberUserIds: [], carriedForward: [], historyFrom: 'formation' } });
    const onCreated = jest.fn();
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={onCreated} />);
    await settle();
    await search('ca');
    await fireEvent.press(await screen.findByTestId('add-people-result-u-cara'));
    await fireEvent.press(await screen.findByTestId('add-people-carry-PLAN-m-1'));
    expect(screen.queryByTestId('add-people-carry-PLAN-t-1')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('add-people-title'), '  Hanoi crew  ');
    await fireEvent.press(screen.getByTestId('add-people-create'));
    expect(mockedAdd).toHaveBeenCalledTimes(1);
    expect(mockedAdd).toHaveBeenCalledWith(DM, { userIds: ['u-cara'], carryForward: [{ kind: 'PLAN', objectId: 'm-1' }], title: '  Hanoi crew  ' });
    expect(onCreated).toHaveBeenCalledWith('grp-9');
  });

  it('a refusal is the server sentence, and nothing navigates', async () => {
    mockedAdd.mockResolvedValue({ ok: false, error: 'forbidden', message: 'One of the people you picked cannot be added.' });
    const onCreated = jest.fn();
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={onCreated} />);
    await settle();
    await search('da');
    await fireEvent.press(await screen.findByTestId('add-people-result-u-dan'));
    await fireEvent.press(screen.getByTestId('add-people-create'));
    expect((await screen.findByTestId('add-people-error')).props.children).toBe('One of the people you picked cannot be added.');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('a failed search says so; it is never "nobody matched"', async () => {
    mockedRecipients.mockImplementation((_q, o) => ({ recipients: [], loading: false, unavailable: !!o?.enabled, recordPick }));
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={() => {}} />);
    await settle();
    await search('ca');
    expect(await screen.findByTestId('add-people-search-error')).toBeTruthy();
  });

  it('a second tap removes a person', async () => {
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={() => {}} />);
    await settle();
    await search('ca');
    await fireEvent.press(await screen.findByTestId('add-people-result-u-cara'));
    expect(screen.getByTestId('add-people-picked')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('add-people-result-u-cara'));
    expect(screen.queryByTestId('add-people-picked')).toBeNull();
  });
});

describe('what may be brought along', () => {
  it('plans (meetups) and places only, de-duplicated; never a trip, an event or a person', () => {
    const out = carryForwardCandidates([
      item('MEETUP', 'm-1', 'Dinner'), item('PLAN', 'm-1', 'Dinner again'), item('PLACE', 'p-1', 'Market'),
      item('TRIP', 't-1', 'Trip'), item('EVENT', 'e-1', 'Gig'),
    ]);
    expect(out).toEqual([
      { kind: 'PLAN', objectId: 'm-1', title: 'Dinner' },
      { kind: 'PLACE', objectId: 'p-1', title: 'Market' },
    ]);
  });
});

describe('the request body', () => {
  it('matches the strict schema: de-duplicated people, no empty carry list, no blank title', () => {
    expect(buildAddPeopleBody({ userIds: ['a', 'a', 'b'], carryForward: [], title: '   ' })).toEqual({ userIds: ['a', 'b'] });
    expect(buildAddPeopleBody({
      userIds: ['a'], carryForward: [{ kind: 'PLACE', objectId: 'p' }, { kind: 'PLACE', objectId: 'p' }], title: ' Crew ',
    })).toEqual({ userIds: ['a'], carryForward: [{ kind: 'PLACE', objectId: 'p' }], title: 'Crew' });
  });
});

describe('the projection offers it only on an affirmative, non-degraded canInvite', () => {
  const wire = (canInvite: boolean, degraded = false): any => ({
    conversationId: DM, conversationType: 'direct', capabilities: { canSendMessage: true, canInvite }, reasons: {}, degraded,
  });
  it('yes, no, degraded, unknown', () => {
    expect(offersAddPeople(toProjectionState(wire(true)))).toBe(true);
    expect(offersAddPeople(toProjectionState(wire(false)))).toBe(false);
    expect(offersAddPeople(toProjectionState(wire(true, true)))).toBe(false);
    expect(offersAddPeople(toProjectionState(null))).toBe(false);
    expect(offersAddPeople({ status: 'loading' })).toBe(false);
  });
});

describe('the thread screen', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('offers Add people on a DM only when the projection says so, and opens the NEW group', () => {
    expect(src).toMatch(/\{isDirect && threadType === 'direct' && offersAddPeople\(conversationProjection\) \? \(<Pressable[^>]*testID="thread-add-people"[^>]*onPress=\{\(\) => setShowAddPeople\(true\)\}/);
    expect(src).toMatch(/<AddPeopleSheet visible=\{showAddPeople\} threadId=\{id \?\? null\}/);
    expect(src).toMatch(/onCreated=\{\(groupId\) => \{ setShowAddPeople\(false\); router\.push\(\{ pathname: '\/messages\/\[id\]' as any, params: \{ id: groupId, threadType: 'group'/);
  });
});

describe('the people search is the input-assistance gateway (G359), never an engine of its own', () => {
  it('asks the telegraph_recipient gateway for this surface, only from two characters, and records an explicit pick', async () => {
    await render(<AddPeopleSheet visible threadId={DM} onClose={() => {}} onCreated={() => {}} />);
    await settle();
    expect(mockedRecipients).toHaveBeenLastCalledWith('', { surface: 'telegraph_add_people', enabled: false });
    await search('c');
    expect(mockedRecipients).toHaveBeenLastCalledWith('', { surface: 'telegraph_add_people', enabled: false });
    await search('ca');
    expect(mockedRecipients).toHaveBeenLastCalledWith('ca', { surface: 'telegraph_add_people', enabled: true });
    await fireEvent.press(await screen.findByTestId('add-people-result-u-cara'));
    expect(recordPick).toHaveBeenCalledTimes(1);
    expect(recordPick).toHaveBeenCalledWith(CARA);
    await fireEvent.press(screen.getByTestId('add-people-result-u-cara'));
    expect(recordPick).toHaveBeenCalledTimes(1);
  });
});
