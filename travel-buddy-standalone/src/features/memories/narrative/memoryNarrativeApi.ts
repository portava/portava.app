/**
 * memoryNarrativeApi — the app's half of census-highlights-memories H14 (§2
 * MemoryNarrativeService), H172 (§18 NarrativeDerivative, the optional AI
 * summary) and H265 (§28.16 the owner's own words). Server: PR #720,
 * artifacts/api-server/src/routes/memoryNarrative.ts, migration 3802.
 *
 *   GET    /api/memories/:id/narrative          the owner's summary, built from the
 *                                               Memory's own facts, and whether an
 *                                               AI draft is on offer
 *   POST   /api/memories/:id/narrative/ai       an AI draft the server checked against
 *                                               those facts — or the summary and why not
 *   GET    /api/me/memory-narrative-ai-consent  the caller's opt-in and the disclosure
 *   PUT    /api/me/memory-narrative-ai-consent  { enabled: true, disclosureVersion } —
 *                                               a grant of exactly the words displayed
 *   DELETE /api/me/memory-narrative-ai-consent  withdraw (always accepted)
 *
 * Every read answers a STATE, never a boolean: a failed read is never "nothing
 * to say", and an offline read is its own state so the card can show nothing
 * new rather than a guess. Nothing here writes a Memory: the routes are
 * read-only over Memories, and this module never calls PATCH /memories/:id —
 * the owner's title and caption are never touched from the narrative (§28.4,
 * §28.16).
 */
import { freshToken } from '../../../services/apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const NARRATIVE_CONSENT_PATH = '/api/me/memory-narrative-ai-consent';
const SHAPE = 'The server answered in a shape this app does not understand.';

// ── Shapes ────────────────────────────────────────────────────────────────────

/** H265: the owner's words exactly as stored. Rendered verbatim; never edited here. */
export interface OriginalText {
  readonly title: string | null;
  readonly caption: string | null;
}

/** The deterministic summary (`renderer` "deterministic@…"). */
export interface NarrativeView {
  readonly memoryId: string;
  readonly renderer: string;
  readonly summary: string;
  readonly originalText: OriginalText;
  /** "und": no language is stored for a Memory, and none is guessed. */
  readonly originalLanguage: string;
}

/** The three settings that keep a Memory from the model (the server's list). */
export type NarrativeExcludingControl = 'DO_NOT_RESURFACE' | 'KEEP_PRIVATE_FOREVER' | 'RETAIN_BUT_DO_NOT_PERSONALIZE';

/**
 * Whether an AI draft is on offer for THIS Memory, as the server judged it on
 * the GET. Advisory: the POST re-checks every gate. An answer this app does not
 * recognise is `unavailable` — never "available".
 */
export type AiOffer =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'feature_disabled' | 'unavailable' | 'consent_required' }
  | { readonly available: false; readonly reason: 'excluded_by_control'; readonly controls: readonly string[] };

export type NarrativeRead =
  | { state: 'ok'; narrative: NarrativeView; ai: AiOffer }
  /** Not the caller's Memory, a missing one or a deleted one (the server's one 404). */
  | { state: 'not_found' }
  | { state: 'offline' }
  | { state: 'error'; message: string };

export interface NarrativeAiConsent {
  /** The server's flag is on: a grant is possible at all. */
  readonly available: boolean;
  /** A grant that is valid for the CURRENT disclosure (the server decides). */
  readonly enabled: boolean;
  readonly consentedAt: string | null;
  readonly withdrawnAt: string | null;
  /** The version of `disclosureText`; a grant must name it. */
  readonly currentDisclosureVersion: string;
  /** The server's words, displayed verbatim beside the switch. */
  readonly disclosureText: string;
}

export type ConsentRead =
  | { state: 'ok'; consent: NarrativeAiConsent }
  | { state: 'offline' }
  | { state: 'error'; message: string };

export type ConsentWrite =
  | { ok: true; consent: NarrativeAiConsent }
  /** 404 feature_disabled: the feature is off — the card withdraws every AI control. */
  | { ok: false; kind: 'feature_disabled'; message: string }
  /** 409: the words displayed are not the current words — re-read and show them again. */
  | { ok: false; kind: 'stale_disclosure'; message: string }
  | { ok: false; kind: 'offline' | 'error'; message: string };

/** An AI draft the server ACCEPTED (`accepted: true`). A proposal: nothing is applied. */
export interface AiProposal {
  readonly memoryId: string;
  readonly renderer: string;
  readonly summary: string;
  readonly originalText: OriginalText;
}

export type AiDraftResult =
  | { state: 'proposal'; proposal: AiProposal }
  /**
   * `accepted: false` — the model failed, or its draft was refused by the server's
   * check. The deterministic summary stands; nothing from the draft reaches the app.
   */
  | { state: 'fallback'; reason: string }
  | { state: 'refused'; reason: 'feature_disabled' | 'consent_required' | 'excluded_by_control' | 'not_found'; message: string; controls: readonly string[] }
  | { state: 'rate_limited'; message: string }
  | { state: 'offline' }
  | { state: 'error'; message: string };

// ── Transport ─────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>;

class Offline extends Error {}

function isOfflineError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('network request failed') || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed');
}

async function call(path: string, init: RequestInit): Promise<{ status: number; json: Body | null }> {
  const token = await freshToken();
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (e) {
    if (isOfflineError(e)) throw new Offline();
    throw e;
  }
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json: json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Body) : null };
}

function messageOf(json: Body | null, fallback: string): string {
  return json && typeof json.message === 'string' && json.message ? json.message : fallback;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function originalTextOf(v: unknown): OriginalText | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Body;
  const title = o.title === null || typeof o.title === 'string' ? (o.title as string | null) : undefined;
  const caption = o.caption === null || typeof o.caption === 'string' ? (o.caption as string | null) : undefined;
  if (title === undefined || caption === undefined) return null;
  return { title, caption };
}

function narrativeOf(v: unknown): NarrativeView | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Body;
  const original = originalTextOf(n.original_text);
  if (typeof n.summary !== 'string' || typeof n.memory_id !== 'string' || typeof n.renderer !== 'string' || !original) return null;
  return {
    memoryId: n.memory_id,
    renderer: n.renderer,
    summary: n.summary,
    originalText: original,
    originalLanguage: typeof n.original_language === 'string' ? n.original_language : 'und',
  };
}

const OFFER_REASONS = ['feature_disabled', 'unavailable', 'consent_required'] as const;

function offerOf(v: unknown): AiOffer {
  if (!v || typeof v !== 'object') return { available: false, reason: 'unavailable' };
  const a = v as Body;
  if (a.available === true) return { available: true };
  if (a.reason === 'excluded_by_control') {
    const controls = Array.isArray(a.controls) ? a.controls.filter((c): c is string => typeof c === 'string') : [];
    return { available: false, reason: 'excluded_by_control', controls };
  }
  const r = (OFFER_REASONS as readonly unknown[]).includes(a.reason) ? (a.reason as (typeof OFFER_REASONS)[number]) : 'unavailable';
  return { available: false, reason: r };
}

function consentOf(json: Body | null): NarrativeAiConsent | null {
  if (!json) return null;
  if (typeof json.available !== 'boolean' || typeof json.enabled !== 'boolean') return null;
  if (typeof json.currentDisclosureVersion !== 'string' || !json.currentDisclosureVersion) return null;
  if (typeof json.disclosureText !== 'string' || !json.disclosureText) return null;
  return {
    available: json.available,
    enabled: json.enabled,
    consentedAt: str(json.consentedAt),
    withdrawnAt: str(json.withdrawnAt),
    currentDisclosureVersion: json.currentDisclosureVersion,
    disclosureText: json.disclosureText,
  };
}

const enc = encodeURIComponent;

// ── The summary ───────────────────────────────────────────────────────────────

export async function fetchMemoryNarrative(memoryId: string): Promise<NarrativeRead> {
  try {
    const { status, json } = await call(`/api/memories/${enc(memoryId)}/narrative`, { method: 'GET' });
    if (status === 404) return { state: 'not_found' };
    if (status !== 200 || !json) return { state: 'error', message: messageOf(json, 'The summary could not be loaded.') };
    const narrative = narrativeOf(json.narrative);
    if (!narrative) return { state: 'error', message: SHAPE };
    return { state: 'ok', narrative, ai: offerOf(json.ai) };
  } catch (e) {
    if (e instanceof Offline) return { state: 'offline' };
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ── The opt-in ────────────────────────────────────────────────────────────────

export async function fetchNarrativeAiConsent(): Promise<ConsentRead> {
  try {
    const { status, json } = await call(NARRATIVE_CONSENT_PATH, { method: 'GET' });
    if (status !== 200) return { state: 'error', message: messageOf(json, 'Your AI summary setting could not be read.') };
    const consent = consentOf(json);
    return consent ? { state: 'ok', consent } : { state: 'error', message: SHAPE };
  } catch (e) {
    if (e instanceof Offline) return { state: 'offline' };
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function writeConsent(init: RequestInit, want: boolean): Promise<ConsentWrite> {
  try {
    const { status, json } = await call(NARRATIVE_CONSENT_PATH, init);
    if (status === 200) {
      const consent = consentOf(json);
      // Only a 200 that says what was asked for is success.
      if (consent && consent.enabled === want) return { ok: true, consent };
      return { ok: false, kind: 'error', message: SHAPE };
    }
    if (status === 404 && json?.error === 'feature_disabled') return { ok: false, kind: 'feature_disabled', message: messageOf(json, 'This setting is not available.') };
    if (status === 409) return { ok: false, kind: 'stale_disclosure', message: messageOf(json, 'The explanation you saw is out of date. Please review it again.') };
    return { ok: false, kind: 'error', message: messageOf(json, 'Your setting could not be saved. Please try again.') };
  } catch (e) {
    if (e instanceof Offline) return { ok: false, kind: 'offline', message: 'You appear to be offline. Nothing was changed.' };
    return { ok: false, kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Turn the opt-in on, for exactly the disclosure the person was shown. The
 * version is the one the server served with that text — never a constant in
 * this app — so a grant can only ever name words that were on screen.
 */
export function grantNarrativeAiConsent(displayedDisclosureVersion: string): Promise<ConsentWrite> {
  return writeConsent({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, disclosureVersion: displayedDisclosureVersion }),
  }, true);
}

/** Turn the opt-in off. The server accepts a withdrawal whatever its flag says. */
export function withdrawNarrativeAiConsent(): Promise<ConsentWrite> {
  return writeConsent({ method: 'DELETE' }, false);
}

// ── The AI draft ──────────────────────────────────────────────────────────────

const REFUSAL_REASONS = ['consent_required', 'excluded_by_control'] as const;

/**
 * Ask for an AI draft of ONE Memory. Call only on the owner's tap, and only
 * while their opt-in is on. The answer is a PROPOSAL at most: nothing is applied
 * to the summary, and nothing is written anywhere, until the owner taps Insert.
 */
export async function requestAiNarrative(memoryId: string): Promise<AiDraftResult> {
  try {
    const { status, json } = await call(`/api/memories/${enc(memoryId)}/narrative/ai`, { method: 'POST' });
    if (status === 200 && json) {
      if (json.accepted === true) {
        const n = json.narrative as Body | undefined;
        const original = originalTextOf(n?.original_text);
        if (n && typeof n.summary === 'string' && n.summary.trim() && typeof n.renderer === 'string' && typeof n.memory_id === 'string' && original) {
          return { state: 'proposal', proposal: { memoryId: n.memory_id, renderer: n.renderer, summary: n.summary, originalText: original } };
        }
        return { state: 'error', message: SHAPE };
      }
      if (json.accepted === false) return { state: 'fallback', reason: typeof json.fallback_reason === 'string' ? json.fallback_reason : 'unknown' };
      return { state: 'error', message: SHAPE };
    }
    if (status === 404) {
      const reason = json?.error === 'feature_disabled' ? 'feature_disabled' : 'not_found';
      return { state: 'refused', reason, message: messageOf(json, 'AI summaries are not available.'), controls: [] };
    }
    if (status === 403 && (REFUSAL_REASONS as readonly unknown[]).includes(json?.reason)) {
      const controls = Array.isArray(json?.controls) ? (json!.controls as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      return { state: 'refused', reason: json!.reason as (typeof REFUSAL_REASONS)[number], message: messageOf(json, 'This Memory is not sent to the AI.'), controls };
    }
    if (status === 429) return { state: 'rate_limited', message: messageOf(json, 'Too many summaries. Please wait a moment.') };
    return { state: 'error', message: messageOf(json, 'An AI draft could not be made right now.') };
  } catch (e) {
    if (e instanceof Offline) return { state: 'offline' };
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
