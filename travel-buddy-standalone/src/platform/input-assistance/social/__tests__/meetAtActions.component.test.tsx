/**
 * GII-F10 on the client: type "meet at …" in a Telegraph message → action
 * candidates → eligibility → tap → the LOCATION compose sheet opens PRE-FILLED
 * → the sender presses Send.
 *
 * Through the REAL action bar, hook, candidate parser, the REAL shared
 * `requestSuggestions` client and the REAL Telegraph `TypedComposePrompt`. Only
 * `fetch` (the gateway) and the device's location (an injected locator — the
 * OS, not our code) are faked. The harness wires the two components exactly
 * as `app/messages/[id].tsx` does, and the last test pins that wiring in the
 * screen's source.
 *
 * Run with: pnpm test:component
 */
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { MeetAtActionBar } from '../MeetAtActionBar.tsx';
import type { DeviceLocator } from '../deviceLocator.ts';
import type { TelegraphLocationDraft } from '../telegraphMeetAt.ts';
import { TypedComposePrompt, type TypedComposeKind } from '../../../../features/telegraph/composer/TypedComposePrompt.tsx';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

const ORIGIN = 'https://portava.test';
const row = (id: string, label: string, v: Record<string, unknown>) => ({
  id, type: 'action', context: 'telegraph_message', label, source: 'canonical', policyVersion: 'v',
  action: { type: 'set_structured_value', value: v }, structuredValue: v,
});
const MEET = row('telegraph-action:meeting_point:0', 'Share meeting point: Dragon Bridge', {
  telegraphShare: 'meeting_point', kind: 'LOCATION', eligible: true, ineligibleReason: null, requires: null,
  draft: { label: 'Dragon Bridge', placeId: 'place-dragon', precision: 'venue' },
});
const NO_STOPS = row('telegraph-action:trip_stop', 'Share Trip stop', {
  telegraphShare: 'trip_stop', kind: 'LOCATION', eligible: false, ineligibleReason: 'You have no upcoming Trip stops to share.', requires: null, draft: null,
});
const HERE = row('telegraph-action:current_place', 'Share current Place', {
  telegraphShare: 'current_place', kind: 'LOCATION', eligible: true, ineligibleReason: null, requires: 'device_location', draft: null,
});

let serve: () => { status: number; body: unknown };
let bodies: any[];
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  bodies = [];
  serve = () => ({ status: 200, body: { requestId: 'r', policyVersion: 'v', suggestions: [MEET, NO_STOPS, HERE] } });
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)) });
    const { status, body } = serve();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

const locator = (over: Partial<DeviceLocator> = {}): DeviceLocator => ({
  permission: async () => 'granted',
  request: async () => true,
  currentLabel: async () => 'Hai Chau, Da Nang',
  ...over,
});

/** The composer wiring from app/messages/[id].tsx, verbatim in shape. */
function Composer({ initial, loc = locator(), sent }: { initial: string; loc?: DeviceLocator; sent: jest.Mock }) {
  const [input, setInput] = useState(initial);
  const [typedCompose, setTypedCompose] = useState<TypedComposeKind | null>(null);
  const [locationDraft, setLocationDraft] = useState<TelegraphLocationDraft | null>(null);
  void setInput;
  return (
    <>
      <TypedComposePrompt
        kind={typedCompose} initialLocation={locationDraft}
        authorId="me"
        onCancel={() => { setTypedCompose(null); setLocationDraft(null); }}
        onSubmit={(kind, payload) => { setTypedCompose(null); setLocationDraft(null); sent(kind, payload); }}
      />
      <MeetAtActionBar draft={input} locator={loc} onPick={(d) => { setLocationDraft(d); setTypedCompose('LOCATION'); }} />
    </>
  );
}

test('a message that does not end in "meet at" sends NOTHING and shows nothing', async () => {
  await render(<Composer initial="running late, sorry" sent={jest.fn()} />);
  await new Promise((r) => setTimeout(r, 400));
  expect(bodies).toHaveLength(0);
  expect(screen.queryByTestId('meet-at-bar')).toBeNull();
});

test('"meet at Dragon Bridge": only the fragment leaves the phone; tap opens the share PRE-FILLED; nothing is sent until Send', async () => {
  const sent = jest.fn();
  await render(<Composer initial={'Landed!\nok, meet at Dragon Bridge'} sent={sent} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:meeting_point:0')).toBeTruthy());

  expect(bodies).toHaveLength(1);
  expect(bodies[0].url).toBe(`${ORIGIN}/api/input-assistance/suggest`);
  expect(bodies[0].body).toMatchObject({
    context: 'telegraph_message',
    fieldId: 'telegraph.message',
    text: 'meet at Dragon Bridge',
    client: { suggestionTypes: ['action'], actionTypes: ['set_structured_value'] },
  });
  expect(JSON.stringify(bodies[0].body)).not.toContain('Landed');

  // Eligibility: the Trip stop is shown DISABLED with its reason.
  expect(screen.getByTestId('meet-at-telegraph-action:trip_stop').props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByTestId('meet-at-why-trip_stop').props.children).toMatch(/no upcoming Trip stops/);

  await fireEvent.press(screen.getByTestId('meet-at-telegraph-action:meeting_point:0'));
  await waitFor(() => expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('Dragon Bridge'));
  expect(screen.getByTestId('telegraph-precision-venue').props.accessibilityState).toMatchObject({ selected: true });
  expect(sent).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
  expect(sent).toHaveBeenCalledWith('LOCATION', { label: 'Dragon Bridge', precision: 'venue', placeId: 'place-dragon' });
});

test('an edited label drops the place id — it no longer names that place', async () => {
  const sent = jest.fn();
  await render(<Composer initial="meet at Dragon Bridge" sent={sent} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:meeting_point:0')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('meet-at-telegraph-action:meeting_point:0'));
  await fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'The east end of Dragon Bridge');
  await fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
  expect(sent).toHaveBeenCalledWith('LOCATION', { label: 'The east end of Dragon Bridge', precision: 'venue' });
});

test('a failed request is an ERROR with Retry, never "no suggestions"', async () => {
  let fail = true;
  serve = () => (fail ? { status: 500, body: {} } : { status: 200, body: { requestId: 'r', policyVersion: 'v', suggestions: [MEET] } });
  await render(<Composer initial="meet at" sent={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-error')).toBeTruthy());
  fail = false;
  await fireEvent.press(screen.getByTestId('meet-at-error'));
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:meeting_point:0')).toBeTruthy());
});

test('a partial answer says a source could not be read', async () => {
  serve = () => ({ status: 200, body: { requestId: 'r', policyVersion: 'v', suggestions: [MEET, HERE], refusal: { class: 'transient_db', code: 'suggest_sources_unreadable', route: 'POST /input-assistance/suggest', coverage: 'partial', failedSources: ['trip_stops'] } } });
  await render(<Composer initial="meet at" sent={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-partial')).toBeTruthy());
});

test('current Place: the DEVICE decides eligibility, and a place it cannot name is a failure', async () => {
  const sent = jest.fn();
  const denied = await render(<Composer initial="meet at" sent={sent} loc={locator({ permission: async () => 'denied' })} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-why-current_place').props.children).toMatch(/Location access is off/));
  expect(screen.getByTestId('meet-at-telegraph-action:current_place').props.accessibilityState).toMatchObject({ disabled: true });
  await denied.unmount();

  const unnamed = await render(<Composer initial="meet at" sent={sent} loc={locator({ currentLabel: async () => null })} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:current_place')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('meet-at-telegraph-action:current_place'));
  await waitFor(() => expect(screen.getByTestId('meet-at-here-error')).toBeTruthy());
  expect(screen.queryByTestId('telegraph-typed-compose-input')).toBeNull();
  await unnamed.unmount();

  await render(<Composer initial="meet at" sent={sent} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:current_place')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('meet-at-telegraph-action:current_place'));
  await waitFor(() => expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('Hai Chau, Da Nang'));
  expect(screen.getByTestId('telegraph-precision-area').props.accessibilityState).toMatchObject({ selected: true });
  expect(sent).not.toHaveBeenCalled();
});

test('the Telegraph screen mounts the bar with this exact wiring (source fence)', () => {
  const src = readFileSync(join(__dirname, '../../../../../app/messages/[id].tsx'), 'utf8');
  expect(src).toMatch(/<MeetAtActionBar draft=\{input\} onPick=\{\(d\) => \{ setLocationDraft\(d\); setTypedCompose\('LOCATION'\); \}\} \/>/);
  expect(src).toMatch(/kind=\{typedCompose\} initialLocation=\{locationDraft\}/);
});
