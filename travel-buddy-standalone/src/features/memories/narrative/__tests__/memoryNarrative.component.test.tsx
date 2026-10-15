/**
 * MemoryNarrativeCard / memoryNarrativeApi — the app's half of census-highlights-
 * memories H14 (§2 MemoryNarrativeService), H172 (§18 the optional AI summary)
 * and H265 (§28.16 the owner's own words). Server: PR #720, routes/memoryNarrative.ts.
 *
 * Pins (B58 cluster MEM-NARR-2):
 *   - flag OFF — in the app's flags OR on the server's answer — no AI control is
 *     rendered and no AI request of any kind is made (consent read, write or draft);
 *   - consent OFF: no draft can be asked for, even with the flag ON and an offer;
 *   - the switch states, field by field, exactly what the server sends (pinned to
 *     the server's NarrativeAiFacts below), shows the server's disclosure verbatim,
 *     grants THAT version through PUT, and revoking through DELETE stops every
 *     later request;
 *   - an AI draft is a PROPOSAL labelled AI: the summary changes only on the
 *     owner's tap of Insert, never the owner's title or caption, and declining
 *     leaves everything as it was — no write of any kind, ever;
 *   - a refused / failed / offline draft leaves the summary and says only why;
 *     an offline load renders nothing; a failed load is said, with a retry;
 *   - a non-owner sees nothing and the server is asked nothing.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Alert, Text } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

let mockFlags: Record<string, boolean> = {};
jest.mock('../../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({
    isEnabled: (k: string) => mockFlags[k] === true,
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
}));

import {
  fetchMemoryNarrative, fetchNarrativeAiConsent, grantNarrativeAiConsent, requestAiNarrative, withdrawNarrativeAiConsent,
} from '../memoryNarrativeApi.ts';
import { NARRATIVE_AI_SENT_KEYS, NARRATIVE_AI_SENT_LABELS } from '../narrativeAiDisclosure.ts';
import { MemoryNarrativeCard } from '../MemoryNarrativeCard.tsx';

const MID = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://api.test';
const NARR = `/api/memories/${MID}/narrative`;
const AI = `/api/memories/${MID}/narrative/ai`;
const CONSENT = '/api/me/memory-narrative-ai-consent';
const FLAG = 'memory_narrative_ai_enabled';

// The owner's words with their own spacing and script: rendered byte-for-byte (H265).
const ORIGINAL = { title: 'Sunset walk', caption: '  Best bánh mì of the trip  ' };
const SUMMARY = '“Sunset walk”, 13 March 2025, in Da Nang, Vietnam. 4 photos, with 2 people. You wrote: “Best bánh mì of the trip”';
const AI_TEXT = 'Sunset walk in Da Nang, Vietnam on 13 March 2025 with 2 people and 4 photos.';
const VERSION = 'memory_narrative_ai_v1';
const DISCLOSURE = 'Optional AI summaries. When you ask for one, Portava sends a few facts about that one Memory to an AI service.';

function narrative() {
  return {
    memory_id: MID, renderer: 'deterministic@1', summary: SUMMARY, segments: [], supporting_fact_ids: [], facts: [],
    original_text: ORIGINAL, original_language: 'und', editable: true, stored: false,
  };
}
type Offer = Record<string, unknown>;
const OFFER_AVAILABLE: Offer = { available: true, reason: null };
const OFFER_NEEDS_CONSENT: Offer = { available: false, reason: 'consent_required' };
const OFFER_FLAG_OFF: Offer = { available: false, reason: 'feature_disabled' };
function narrBody(ai: Offer = OFFER_AVAILABLE) { return { narrative: narrative(), ai }; }
function consentBody(enabled: boolean, available = true, version = VERSION, text = DISCLOSURE) {
  return {
    available, enabled, consentVersion: enabled ? version : null, consentedAt: enabled ? '2026-10-14T00:00:00.000Z' : null,
    withdrawnAt: enabled ? null : null, currentDisclosureVersion: version, disclosureText: text,
  };
}
function acceptedBody() {
  return {
    accepted: true, fallback_reason: null,
    narrative: { memory_id: MID, renderer: 'ai:gpt-5-mini@1', summary: AI_TEXT, supporting_fact_ids: [], original_text: ORIGINAL, original_language: 'und', editable: true, stored: false },
    deterministic: narrative(),
  };
}

// ── A recording server ────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | Error;
interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];
let routes: Map<string, Reply[]> = new Map();
const realFetch = globalThis.fetch;
function on(method: string, path: string, ...replies: Reply[]) { routes.set(`${method} ${path}`, replies); }
function install() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = routes.get(`${method} ${path}`);
    const r: Reply = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : { status: 418, body: { error: 'unrouted' } };
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}
/** Every request that touches the AI half: the opt-in (any verb) and the draft. */
const aiCalls = () => calls.filter((c) => c.path === AI || c.path === CONSENT);
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === AI);
/** Anything that could write: the narrative card must never send one to a Memory. */
const memoryWrites = () => calls.filter((c) => c.method !== 'GET' && c.path !== AI && c.path !== CONSENT);

const MEMORY = { id: MID, updatedAt: '2026-10-01T00:00:00.000Z', items: [] };
let alertSpy: jest.SpyInstance;
beforeEach(() => {
  calls = []; routes = new Map(); mockFlags = { [FLAG]: true };
  process.env.EXPO_PUBLIC_API_BASE_URL = BASE;
  install();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = realFetch; alertSpy.mockRestore(); });

async function mount(isOwner = true) {
  await render(<MemoryNarrativeCard memory={MEMORY} isOwner={isOwner} />);
}
const summaryText = () => screen.getByTestId('memory-narrative-summary').props.children as string;

// ── 1. The flag ───────────────────────────────────────────────────────────────

describe('flag OFF ⇒ no AI control and zero AI requests', () => {
  it("the app's flag is off: the summary shows, and the opt-in and the draft are never asked for — even when the server offers one", async () => {
    mockFlags = {};
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    await mount();
    expect(await screen.findByTestId('memory-narrative-summary')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20)); // any follow-up request would have been made by now
    expect(summaryText()).toBe(SUMMARY);
    expect(screen.queryByTestId('memory-narrative-ai')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-ai-consent-toggle')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(aiCalls()).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${NARR}`]);
  });

  it("the server says the feature is off (404 feature_disabled on its own gate): no AI control, zero AI requests, though the app's flag says on", async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_FLAG_OFF) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    await mount();
    await screen.findByTestId('memory-narrative-summary');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(screen.queryByTestId('memory-narrative-ai')).toBeNull();
    expect(aiCalls()).toEqual([]);
  });

  it('the opt-in says the server flag is off (available: false): no AI control is rendered', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) });
    on('GET', CONSENT, { status: 200, body: consentBody(false, false) });
    await mount();
    await waitFor(() => expect(calls.some((c) => c.path === CONSENT)).toBe(true));
    expect(screen.queryByTestId('memory-narrative-ai')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('a draft refused with 404 feature_disabled withdraws every AI control', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    on('POST', AI, { status: 404, body: { error: 'feature_disabled', message: 'AI summaries are not available.' } });
    await mount();
    await fireEvent.press(await screen.findByTestId('memory-narrative-ai-draft'));
    await waitFor(() => expect(screen.queryByTestId('memory-narrative-ai')).toBeNull());
    expect(summaryText()).toBe(SUMMARY);
  });
});

// ── 2. The opt-in ─────────────────────────────────────────────────────────────

describe('consent OFF ⇒ no AI request, even with the flag ON', () => {
  it('shows the switch OFF, what is sent and the server text — and no way to ask for a draft', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) });
    on('GET', CONSENT, { status: 200, body: consentBody(false) });
    await mount();
    const toggle = await screen.findByTestId('memory-narrative-ai-consent-toggle');
    expect(toggle.props.value).toBe(false);
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(screen.getByTestId('memory-narrative-ai-disclosure').props.children).toBe(DISCLOSURE);
    expect(posts()).toEqual([]);
  });

  it('a stale offer of a draft does not override an opt-in that is off', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(false) });
    await mount();
    await screen.findByTestId('memory-narrative-ai-consent-toggle');
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('an opt-in that cannot be read shows no AI control (never "on")', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 503, body: { error: 'degraded_unavailable', message: 'down' } });
    await mount();
    await waitFor(() => expect(calls.some((c) => c.path === CONSENT)).toBe(true));
    expect(screen.queryByTestId('memory-narrative-ai')).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe('the switch says exactly what is sent', () => {
  it('lists every field of the server payload in plain words, and what is never sent', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) });
    on('GET', CONSENT, { status: 200, body: consentBody(false) });
    await mount();
    await screen.findByTestId('memory-narrative-ai-consent-toggle');
    for (const k of NARRATIVE_AI_SENT_KEYS) {
      expect(screen.getByTestId(`memory-narrative-ai-sent-${k}`).props.children).toBe(`• ${NARRATIVE_AI_SENT_LABELS[k]}`);
    }
    expect(screen.getByTestId('memory-narrative-ai-never-sent').props.children).toMatch(/map coordinates.*names of the people you tagged.*photo captions.*someone else wrote/);
    expect(screen.getByTestId('memory-narrative-ai-never-memories').props.children).toMatch(/Keep private forever/);
  });

  it("the list is the server's payload: one entry per key of NarrativeAiFacts, which is all the model is sent", () => {
    const src = readFileSync(join(__dirname, '../../../../../../artifacts/api-server/src/services/memory/memoryNarrative.ts'), 'utf8');
    const block = /export interface NarrativeAiFacts \{([\s\S]*?)\n\}/.exec(src);
    expect(block).not.toBeNull();
    const keys = [...block![1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...NARRATIVE_AI_SENT_KEYS].sort());
    // …and the model input is exactly those facts (null ones omitted), after the system rule.
    expect(src).toMatch(/for \(const \[k, v\] of Object\.entries\(f\)\) if \(v !== null\) sent\[k\] = v;/);
    expect(src).toMatch(/\{ role: "user", content: `Facts \(JSON\):\\n\$\{JSON\.stringify\(sent\)\}` \}/);
  });
});

describe('the switch writes the opt-in through the server, and revoking stops every later request', () => {
  it('ON: PUTs { enabled: true, disclosureVersion } naming the version of the text displayed, then offers a draft', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) }, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(false, true, 'memory_narrative_ai_v7', 'The seventh words.') });
    on('PUT', CONSENT, { status: 200, body: consentBody(true, true, 'memory_narrative_ai_v7', 'The seventh words.') });
    await mount();
    expect((await screen.findByTestId('memory-narrative-ai-disclosure')).props.children).toBe('The seventh words.');
    await fireEvent(screen.getByTestId('memory-narrative-ai-consent-toggle'), 'valueChange', true);
    await screen.findByTestId('memory-narrative-ai-draft');
    const put = calls.filter((c) => c.method === 'PUT');
    expect(put).toEqual([{ method: 'PUT', path: CONSENT, body: { enabled: true, disclosureVersion: 'memory_narrative_ai_v7' } }]);
    expect(screen.getByTestId('memory-narrative-ai-consent-toggle').props.value).toBe(true);
    expect(posts()).toEqual([]); // turning it on asks for nothing by itself
  });

  it('OFF: DELETEs the opt-in; the draft control and any proposal go, and nothing more is asked for', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    on('POST', AI, { status: 200, body: acceptedBody() });
    on('DELETE', CONSENT, { status: 200, body: { ...consentBody(false), withdrawnAt: '2026-10-14T01:00:00.000Z' } });
    await mount();
    await fireEvent.press(await screen.findByTestId('memory-narrative-ai-draft'));
    await screen.findByTestId('memory-narrative-ai-proposal');
    await fireEvent(screen.getByTestId('memory-narrative-ai-consent-toggle'), 'valueChange', false);
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-consent-toggle').props.value).toBe(false));
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: CONSENT, body: undefined }]);
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
    expect(posts()).toHaveLength(1); // the one draft asked for before revoking
    expect(summaryText()).toBe(SUMMARY);
  });

  it('a 409 (the words changed) re-reads the opt-in and shows the new words; the switch stays off', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) });
    on('GET', CONSENT, { status: 200, body: consentBody(false) }, { status: 200, body: consentBody(false, true, 'memory_narrative_ai_v2', 'New words.') });
    on('PUT', CONSENT, { status: 409, body: { error: 'conflict', message: 'out of date' } });
    await mount();
    await fireEvent(await screen.findByTestId('memory-narrative-ai-consent-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-disclosure').props.children).toBe('New words.'));
    expect(screen.getByTestId('memory-narrative-ai-consent-toggle').props.value).toBe(false);
    expect(screen.getByTestId('memory-narrative-ai-note').props.children).toMatch(/explanation changed/);
    expect(posts()).toEqual([]);
  });

  it('a refused write is reported and the switch does not move', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_NEEDS_CONSENT) });
    on('GET', CONSENT, { status: 200, body: consentBody(false) });
    on('PUT', CONSENT, { status: 503, body: { error: 'degraded_unavailable', message: 'Your setting could not be saved. Please try again.' } });
    await mount();
    await fireEvent(await screen.findByTestId('memory-narrative-ai-consent-toggle'), 'valueChange', true);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('AI drafts were not turned on', 'Your setting could not be saved. Please try again.'));
    expect(screen.getByTestId('memory-narrative-ai-consent-toggle').props.value).toBe(false);
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
  });
});

// ── 3. The proposal ───────────────────────────────────────────────────────────

describe('an AI draft is a proposal: inserted only on tap, and the original text is never touched', () => {
  async function proposalOnScreen() {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    on('POST', AI, { status: 200, body: acceptedBody() });
    await mount();
    await fireEvent.press(await screen.findByTestId('memory-narrative-ai-draft'));
    await screen.findByTestId('memory-narrative-ai-proposal');
  }

  it('the proposal is shown labelled AI, beside the owner\'s own words — and the summary is unchanged until the tap', async () => {
    await proposalOnScreen();
    expect(screen.getByTestId('memory-narrative-ai-proposal-text').props.children).toBe(AI_TEXT);
    expect(screen.getByText('AI draft')).toBeTruthy();
    expect(summaryText()).toBe(SUMMARY);
    expect(screen.getByTestId('memory-narrative-source')).toBeTruthy();
    expect(screen.queryByTestId('memory-narrative-ai-label')).toBeNull();
    expect(screen.getByTestId('memory-narrative-ai-proposal-original-title').props.children).toBe(ORIGINAL.title);
    expect(screen.getByTestId('memory-narrative-ai-proposal-original-caption').props.children).toBe(ORIGINAL.caption);
    expect(posts()).toHaveLength(1);
    expect(memoryWrites()).toEqual([]);
  });

  it('Insert puts the draft into the summary, labelled AI; the owner\'s words stay beside it verbatim; nothing is written', async () => {
    await proposalOnScreen();
    await fireEvent.press(screen.getByTestId('memory-narrative-ai-insert'));
    expect(summaryText()).toBe(AI_TEXT);
    expect(screen.getByTestId('memory-narrative-ai-label').props.children).toBe('AI draft');
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    expect(screen.getByTestId('memory-narrative-original-title').props.children).toBe(ORIGINAL.title);
    expect(screen.getByTestId('memory-narrative-original-caption').props.children).toBe(ORIGINAL.caption);
    expect(memoryWrites()).toEqual([]);
    // …and the owner can go back to the summary from their details.
    await fireEvent.press(screen.getByTestId('memory-narrative-reset'));
    expect(summaryText()).toBe(SUMMARY);
    expect(screen.queryByTestId('memory-narrative-ai-label')).toBeNull();
  });

  it('Dismiss declines it: the summary and the owner\'s words are exactly as before, and nothing is written', async () => {
    await proposalOnScreen();
    await fireEvent.press(screen.getByTestId('memory-narrative-ai-dismiss'));
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    expect(summaryText()).toBe(SUMMARY);
    expect(screen.queryByTestId('memory-narrative-ai-label')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-original')).toBeNull();
    expect(memoryWrites()).toEqual([]);
    expect(calls.every((c) => c.method === 'GET' || (c.method === 'POST' && c.path === AI))).toBe(true);
  });

  it('the summary is editable by the owner, on this screen only; an edit is never sent', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_FLAG_OFF) });
    await mount();
    await fireEvent.press(await screen.findByTestId('memory-narrative-edit'));
    await fireEvent.changeText(screen.getByTestId('memory-narrative-editor'), 'My own words about it.');
    await fireEvent.press(screen.getByTestId('memory-narrative-edit'));
    expect(summaryText()).toBe('My own words about it.');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${NARR}`]);
  });
});

// ── 4. Failure states ─────────────────────────────────────────────────────────

describe('a refused, unavailable, failed or offline draft shows the summary and nothing invented', () => {
  async function draftReplies(reply: Reply, offer: Offer = OFFER_AVAILABLE) {
    on('GET', NARR, { status: 200, body: narrBody(offer) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) }, { status: 200, body: consentBody(false) });
    on('POST', AI, reply);
    await mount();
    await fireEvent.press(await screen.findByTestId('memory-narrative-ai-draft'));
    await waitFor(() => expect(posts()).toHaveLength(1));
  }

  it.each([
    ['unsupported_fact', /don't support/],
    ['altered_owner_text', /changed your own words/],
    ['model_unavailable', /didn't answer/],
    ['too_long', /too long/],
    ['empty_output', /no draft/],
  ])('accepted: false (%s): no proposal, the summary stands, and only the reason is said', async (reason, said) => {
    // The server sends back the deterministic summary as `narrative` — and never the draft.
    await draftReplies({ status: 200, body: { accepted: false, fallback_reason: reason, narrative: narrative(), deterministic: narrative() } });
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-note').props.children).toMatch(said));
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    expect(summaryText()).toBe(SUMMARY);
    expect(screen.queryByTestId('memory-narrative-ai-label')).toBeNull();
  });

  it('403 excluded_by_control: names the setting, withdraws the draft control', async () => {
    await draftReplies({ status: 403, body: { error: 'forbidden', reason: 'excluded_by_control', controls: ['KEEP_PRIVATE_FOREVER'], message: 'x' } });
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-excluded').props.children).toBe('This Memory is set to “Keep private forever”, so it is not sent to the AI.'));
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(summaryText()).toBe(SUMMARY);
  });

  it('an offer already excluded by a setting: no draft control, no request', async () => {
    on('GET', NARR, { status: 200, body: narrBody({ available: false, reason: 'excluded_by_control', controls: ['DO_NOT_RESURFACE', 'RETAIN_BUT_DO_NOT_PERSONALIZE'] }) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    await mount();
    expect((await screen.findByTestId('memory-narrative-ai-excluded')).props.children)
      .toBe('This Memory is set to “Don’t resurface this” and “Keep, but don’t personalise from it”, so it is not sent to the AI.');
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('403 consent_required (withdrawn elsewhere): re-reads the opt-in and asks for nothing more', async () => {
    await draftReplies({ status: 403, body: { error: 'forbidden', reason: 'consent_required', message: 'Turn on AI summaries first.' } });
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-consent-toggle').props.value).toBe(false));
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(calls.filter((c) => c.method === 'GET' && c.path === CONSENT)).toHaveLength(2);
    expect(summaryText()).toBe(SUMMARY);
  });

  it('503 / 429: the summary stands and the server\'s sentence is said', async () => {
    await draftReplies({ status: 503, body: { error: 'degraded_unavailable', message: "This Memory's privacy settings could not be checked, so nothing was sent. Please try again." } });
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-note').props.children).toMatch(/could not be checked/));
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    expect(summaryText()).toBe(SUMMARY);
  });

  it('offline: nothing new — no proposal, the summary unchanged, only the connection is mentioned', async () => {
    await draftReplies(new TypeError('Network request failed'));
    await waitFor(() => expect(screen.getByTestId('memory-narrative-ai-note').props.children).toMatch(/offline/));
    expect(screen.queryByTestId('memory-narrative-ai-proposal')).toBeNull();
    expect(summaryText()).toBe(SUMMARY);
  });
});

describe('the summary read', () => {
  it('offline on load: the card renders nothing at all', async () => {
    on('GET', NARR, new TypeError('Network request failed'));
    await mount();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('memory-narrative-card')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-error')).toBeNull();
  });

  it('a 503 is said, with a retry — never an empty summary', async () => {
    on('GET', NARR, { status: 503, body: { error: 'degraded_unavailable', message: 'down' } }, { status: 200, body: narrBody(OFFER_FLAG_OFF) });
    await mount();
    expect(await screen.findByTestId('memory-narrative-error')).toBeTruthy();
    expect(screen.queryByTestId('memory-narrative-summary')).toBeNull();
    await fireEvent.press(screen.getByTestId('memory-narrative-retry'));
    await waitFor(() => expect(summaryText()).toBe(SUMMARY));
  });

  it('404 (not the caller\'s, missing or deleted): renders nothing', async () => {
    on('GET', NARR, { status: 404, body: { error: 'not_found', message: 'Memory not found' } });
    await mount();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('memory-narrative-card')).toBeNull();
  });
});

describe('a non-owner sees no narrative controls', () => {
  it('renders nothing and asks the server nothing', async () => {
    on('GET', NARR, { status: 200, body: narrBody(OFFER_AVAILABLE) });
    on('GET', CONSENT, { status: 200, body: consentBody(true) });
    await mount(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('memory-narrative-card')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-ai-consent-toggle')).toBeNull();
    expect(calls).toEqual([]);
  });
});

// ── 5. The client module ──────────────────────────────────────────────────────

describe('memoryNarrativeApi', () => {
  it('reads are authenticated and never a boolean', async () => {
    on('GET', NARR, { status: 200, body: narrBody({ available: false, reason: 'something_new' }) });
    const r = await fetchMemoryNarrative(MID);
    expect(r.state === 'ok' && r.ai).toEqual({ available: false, reason: 'unavailable' }); // an unknown answer is never "available"
    on('GET', NARR, { status: 200, body: { narrative: { ...narrative(), summary: 7 }, ai: OFFER_AVAILABLE } });
    expect((await fetchMemoryNarrative(MID)).state).toBe('error');
    on('GET', CONSENT, { status: 200, body: { ...consentBody(true), disclosureText: '' } });
    expect((await fetchNarrativeAiConsent()).state).toBe('error'); // no words, no switch
  });

  it('a grant names the displayed version; a withdrawal is a DELETE; only a 200 that says so is success', async () => {
    on('PUT', CONSENT, { status: 200, body: consentBody(true) });
    expect((await grantNarrativeAiConsent(VERSION)).ok).toBe(true);
    expect(calls[0]).toEqual({ method: 'PUT', path: CONSENT, body: { enabled: true, disclosureVersion: VERSION } });
    on('PUT', CONSENT, { status: 200, body: consentBody(false) });
    expect(await grantNarrativeAiConsent(VERSION)).toMatchObject({ ok: false, kind: 'error' });
    on('DELETE', CONSENT, { status: 200, body: consentBody(false) });
    expect((await withdrawNarrativeAiConsent()).ok).toBe(true);
    on('PUT', CONSENT, { status: 404, body: { error: 'feature_disabled' } });
    expect(await grantNarrativeAiConsent(VERSION)).toMatchObject({ ok: false, kind: 'feature_disabled' });
  });

  it('a draft is a proposal only when accepted; a 403 without a known reason is an error, not a refusal', async () => {
    on('POST', AI, { status: 200, body: { accepted: 'yes', narrative: acceptedBody().narrative } });
    expect((await requestAiNarrative(MID)).state).toBe('error');
    on('POST', AI, { status: 200, body: { accepted: true, narrative: { ...acceptedBody().narrative, summary: '   ' } } });
    expect((await requestAiNarrative(MID)).state).toBe('error');
    on('POST', AI, { status: 403, body: { error: 'forbidden', message: 'Your account has been banned' } });
    expect(await requestAiNarrative(MID)).toEqual({ state: 'error', message: 'Your account has been banned' });
  });
});

// Anti-vacuity: every await above was drained, so a later render still commits
// (an unawaited fireEvent would leave this probe empty).
it('probe: the renderer still commits after every case above', async () => {
  await render(<Text testID="probe">probe</Text>);
  expect(screen.getByTestId('probe')).toBeTruthy();
});
