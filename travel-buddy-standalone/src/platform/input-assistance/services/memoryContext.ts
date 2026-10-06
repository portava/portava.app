/**
 * Compass memory for input assistance — the client's pure half (spec §6
 * `allowMemoryContext`; census G25), built to OD-INPUT-3:
 *
 *   "Compass memory: Don't use it for input assistance by default. Add it only
 *    through a separate, clear opt-in with a way to inspect and revoke it."
 *
 * The server does the gating and the reading (lib/inputAssistance/memoryContext.ts:
 * policy → flag → opt-in, then the person's own CompassMemoryProjection). The
 * starters it produces arrive as ordinary `ai_suggestion` rows on the Compass
 * screen, so nothing here touches suggestions. This module holds the words the
 * person reads before opting in, and the parse of the inspect view.
 *
 * Pure — node:test-safe. Transport: memoryContextTransport.ts.
 */

/** Must equal the server's INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION; bump both with the words. */
export const MEMORY_CONTEXT_DISCLOSURE_VERSION = 'input_memory_context_v1';

export const MEMORY_CONTEXT_TITLE = 'Use my memories in Compass suggestions';

/**
 * ENGINEERING DRAFT of OD-INPUT-3, for the owner to approve before
 * `input_memory_context_enabled` is turned on. It says what is read (places
 * from the person's own memories), what for (suggesting prompts), who sees the
 * result (only them), that nothing new is kept, how to inspect (the list below
 * it) and how to revoke (the switch, effective immediately).
 */
export const MEMORY_CONTEXT_BODY =
  'With this on, Compass can look at the places in your own memories — like a city you visited — ' +
  'to suggest things to ask, such as planning another trip there. ' +
  'Only you see these suggestions, and this setting doesn’t save or share anything new. ' +
  'You can see below exactly what Compass may use, and turning this off stops it right away.';

export interface MemoryContextFact {
  city: string;
  country: string | null;
  occurredAt: string | null;
}

export interface MemoryContextView {
  available: boolean;
  enabled: boolean;
  currentDisclosureVersion: string;
  /** null = nothing was read (off, or not offered). [] = read, and empty. */
  facts: MemoryContextFact[] | null;
  /** True when the opt-in is on but the memories could not be read right now. */
  factsUnavailable: boolean;
}

/** Only the server's exact shape is a view; anything else is unreadable, not "off". */
export function parseMemoryContextView(body: unknown): MemoryContextView | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.available !== 'boolean' || typeof b.enabled !== 'boolean') return null;
  if (typeof b.currentDisclosureVersion !== 'string') return null;
  let facts: MemoryContextFact[] | null = null;
  if (Array.isArray(b.facts)) {
    facts = [];
    for (const f of b.facts) {
      if (!f || typeof f !== 'object') return null;
      const r = f as Record<string, unknown>;
      if (typeof r.city !== 'string' || !r.city.trim()) return null;
      facts.push({
        city: r.city,
        country: typeof r.country === 'string' ? r.country : null,
        occurredAt: typeof r.occurredAt === 'string' ? r.occurredAt : null,
      });
    }
  } else if (b.facts !== null && b.facts !== undefined) {
    return null;
  }
  return {
    available: b.available,
    enabled: b.enabled,
    currentDisclosureVersion: b.currentDisclosureVersion,
    facts,
    factsUnavailable: b.factsUnavailable === true,
  };
}

/** "Hội An, Vietnam" — how the inspect list names a fact. */
export function memoryFactLabel(f: MemoryContextFact): string {
  return f.country ? `${f.city}, ${f.country}` : f.city;
}
