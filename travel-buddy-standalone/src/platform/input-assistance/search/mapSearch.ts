/**
 * mapSearch — the Map search sheet as a field of the shared input platform.
 *
 * census-discovery §80 (lane W10-S1), row A08 reason 3, register D-W10-S1-5.
 *
 * The sheet used to run its own per-keystroke engine: two `GET /discovery/search`
 * requests (`type=all` and `type=saved`) per keystroke, off the platform GII
 * `:8` says every surface consumes. It is now the `map.search` field of the
 * `global_search` context and asks `POST /input-assistance/suggest` ONCE.
 *
 * The server serves this field as a SEARCH PAGE
 * (`artifacts/api-server/src/lib/inputAssistance/searchPage.ts`): the same rows
 * the two route requests returned, each a §42 suggestion carrying `mapResult`
 * (the search wire type, the display fields and ONLY the geometry keys the
 * Map's adapter reads), and the coverage of each lane on the envelope —
 * `refusal` for the fan-out, `laneRefusals.saved` for §27's "Saved items".
 *
 * This module is PURE (no React, no network, no token): it builds the request
 * body and turns the envelope back into the `UnifiedSearchResultLike` rows and
 * the two refusals the sheet already knew how to render, so the sheet's
 * notices did not have to change. The network call is
 * `requestMapSearchPage` in `services/inputAssistance.ts`.
 */
import type { UnifiedSearchResultLike } from '../../../features/map/search/searchAdapter.ts';
import type { SuggestRefusal } from '../types/inputSuggestion.ts';

/** The field id the server serves as a search page. Must match searchPage.ts. */
export const MAP_SEARCH_FIELD_ID = 'map.search';

/** The Discovery refusal shape, as the sheet reads it. */
export type MapSearchRefusal = SuggestRefusal;

export interface MapSearchPage {
  results: UnifiedSearchResultLike[];
  /** The `type=all` fan-out's coverage. Absent = complete. */
  refusal?: MapSearchRefusal;
  /** §27 "Saved items" coverage. Absent = complete. */
  savedRefusal?: MapSearchRefusal;
  /**
   * census-discovery §80 follow-up: the query had nothing searchable once the
   * key was prepared (a `validation` refusal — "🔥", "((", "@a"). That is "not
   * enough to search yet", never an outage, and the sheet must not word it as one.
   */
  tooShort?: boolean;
}

export type MapSearchPageResult = ({ ok: true } & MapSearchPage) | { ok: false; error: string };

export interface MapSearchOpts {
  lat?: number;
  lng?: number;
  city?: string;
  tz?: string;
}

/** The POST body. `lat`/`lng` ride at the top level, where the route reads them. */
export function buildMapSearchBody(query: string, opts: MapSearchOpts = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    context: 'global_search',
    fieldId: MAP_SEARCH_FIELD_ID,
    text: query,
    sessionContext: { surface: 'map' },
  };
  if (opts.lat != null && Number.isFinite(opts.lat)) body.lat = opts.lat;
  if (opts.lng != null && Number.isFinite(opts.lng)) body.lng = opts.lng;
  if (typeof opts.city === 'string' && opts.city.trim().length > 0) body.city = opts.city.trim();
  if (typeof opts.tz === 'string' && opts.tz.trim().length > 0) body.tz = opts.tz.trim();
  return body;
}

/**
 * Tolerant, like `services/discovery.ts` `parseRefusal`: a malformed refusal is
 * no refusal, and anything but `"partial"` reads as `"nothing"` (the stronger,
 * safer claim).
 */
export function parseMapSearchRefusal(raw: unknown): MapSearchRefusal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.class !== 'string' || typeof o.code !== 'string') return undefined;
  return {
    class: o.class,
    code: o.code,
    route: typeof o.route === 'string' ? o.route : '',
    coverage: o.coverage === 'partial' ? 'partial' : 'nothing',
    ...(Array.isArray(o.failedSources)
      ? { failedSources: o.failedSources.filter((x): x is string => typeof x === 'string') }
      : {}),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** The envelope, back into the rows and refusals the sheet renders. */
export function parseMapSearchEnvelope(body: unknown): MapSearchPage {
  const b = (body ?? {}) as Record<string, unknown>;
  const results: UnifiedSearchResultLike[] = [];
  for (const s of Array.isArray(b.suggestions) ? b.suggestions : []) {
    const o = s as Record<string, unknown>;
    const m = o?.mapResult as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') continue; // not a search-page row
    const id = str(o.entityId);
    const type = str(m.serverType);
    const title = str(o.label);
    if (!id || !type || title === null) continue;
    results.push({
      id,
      type,
      title,
      subtitle: str(m.subtitle),
      locationPreview: str(m.locationPreview),
      destinationRoute: str(m.destinationRoute),
      startsAt: str(m.startsAt),
      metadata: m.metadata && typeof m.metadata === 'object' ? (m.metadata as Record<string, unknown>) : null,
    });
  }
  const refusal = parseMapSearchRefusal(b.refusal);
  const lanes = (b.laneRefusals ?? {}) as Record<string, unknown>;
  const savedRefusal = parseMapSearchRefusal(lanes.saved);
  return {
    results: refusal?.class === 'validation' ? [] : results,
    ...(refusal?.class === 'validation' ? { tooShort: true } : {}),
    ...(refusal ? { refusal } : {}),
    ...(savedRefusal ? { savedRefusal } : {}),
  };
}
