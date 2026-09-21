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
  schemaVersion?: unknown;
  suggestions?: unknown;
  serverMs?: unknown;
}

export interface ParsedSuggestBody {
  requestId: string;
  policyVersion: string | null;
  /**
   * §48 (census G341) — the serve's RESPONSE-SHAPE version, independent of the
   * policy version. `null` when the serve did not send one, which is every
   * deployment before 2026-09-21 and is treated as schema 1 by
   * {@link isSchemaCompatible} — absent must not read as "unknown, refuse".
   */
  schemaVersion: number | null;
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
    schemaVersion: parseSchemaVersion(b.schemaVersion),
    suggestions: Array.isArray(b.suggestions) ? (b.suggestions as InputSuggestion[]) : [],
    serverMs: parseServerMs(b.serverMs),
  };
}

/**
 * §48 — a positive integer, or null. Not a default: a serve that sent garbage
 * for its own schema version is a serve whose shape nobody can vouch for, and
 * coercing that to 1 would be inventing the fact the field exists to carry.
 * `null` is handled by {@link isSchemaCompatible}, which treats ABSENT as 1 and
 * garbage the same way — see the reasoning there.
 */
export function parseSchemaVersion(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 1 || raw > 1000) return null;
  return Math.floor(raw);
}

/**
 * §48 — may this client render this serve's rows?
 *
 * The rule is MAJOR-only and one-directional:
 *
 *   server > client  ⇒ NO. The envelope may have changed in a way this build
 *                     cannot read. The caller degrades to "assistance
 *                     unavailable" (§38's ladder) rather than drawing a shape
 *                     it does not understand — a half-read row is worse than
 *                     no row, because the user cannot tell it is half-read.
 *   server <= client ⇒ YES. Either the same shape, or an older server whose
 *                     envelope this build is a superset of.
 *   absent           ⇒ YES. Every serve before this field existed, and §48's
 *                     own "preserve backward compatibility for active mobile
 *                     versions" cuts both ways: a NEWER client must not black
 *                     out against an older deployment either.
 *
 * Additive server changes must NOT bump the server's major — that is the whole
 * discipline this function depends on, and it is stated at the constant's
 * declaration on both sides.
 */
export function isSchemaCompatible(serverVersion: number | null, clientVersion: number): boolean {
  if (serverVersion == null) return true;
  return serverVersion <= clientVersion;
}

/** Exported so its own contract is assertable without building a whole body. */
export function parseServerMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > MAX_SERVER_MS) return undefined;
  return Math.round(raw);
}
