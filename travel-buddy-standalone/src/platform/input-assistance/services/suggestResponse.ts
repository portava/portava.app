/**
 * §41 — reading the suggest response envelope. PURE, and separate from
 * `inputAssistance.ts` for one reason: that module imports the Supabase-backed
 * token helper at load, so a node:test file cannot touch it, and until this
 * function was pulled out the envelope's coercions were unprovable.
 *
 * THAT WAS NOT THEORETICAL. The first version of the `serverMs` handling lived
 * inline in `inputAssistance.ts` and the component test that "proved" it
 * asserted a jest mock of `requestSuggestions` — so replacing `: undefined`
 * with `: 0` left the suite green. A test that cannot see the code it names is
 * a test of the fixture.
 *
 * THE ONE RULE HERE: a value the server did not send is ABSENT, never zero.
 * `serverMs` feeds §57's P95 suggestion latency (census G372); a fabricated 0
 * is indistinguishable from an instantaneous serve and would drag that quantile
 * toward a number nothing measured. Same for `requestId`: '' means "this serve
 * has no id", and `suggestBody`/the telemetry field turn that into null rather
 * than into a joinable-looking empty string.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export interface RawSuggestBody {
  requestId?: unknown;
  policyVersion?: unknown;
  suggestions?: unknown;
  serverMs?: unknown;
}

export interface ParsedSuggestBody {
  requestId: string;
  policyVersion: string | null;
  suggestions: InputSuggestion[];
  serverMs: number | undefined;
}

/** Wall-clock ceiling. A "latency" beyond this is a clock, not a serve. */
const MAX_SERVER_MS = 120_000;

export function parseSuggestBody(body: RawSuggestBody | null | undefined): ParsedSuggestBody {
  const b = (body ?? {}) as RawSuggestBody;
  return {
    requestId: typeof b.requestId === 'string' ? b.requestId : '',
    policyVersion: typeof b.policyVersion === 'string' && b.policyVersion.length > 0
      ? b.policyVersion
      : null,
    suggestions: Array.isArray(b.suggestions) ? (b.suggestions as InputSuggestion[]) : [],
    serverMs: parseServerMs(b.serverMs),
  };
}

/** Exported so its own contract is assertable without building a whole body. */
export function parseServerMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > MAX_SERVER_MS) return undefined;
  return Math.round(raw);
}
