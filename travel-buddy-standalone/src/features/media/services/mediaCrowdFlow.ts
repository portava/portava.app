/**
 * The two reads behind the NOW lens's "WHERE THE NIGHT IS MOVING" card (spec
 * §22; census-media MD162 §51). The pairing itself is
 * `state/crowdFlowPairing.ts`; this file only sequences the reads and folds
 * every failure into "no card".
 *
 *   1. The canonical Map gateway, asked ONLY for `crowd_flow` in the same
 *      city-scale viewport the Media Map uses. The NOW lens already sends the
 *      viewer's coarse location to `GET /media/world`; this is that same
 *      location, sent to the gateway the Media Map already calls.
 *   2. Only when a served flow could be paired at all: `GET /media/map`, the
 *      perspective counts per canonical place. Read from the NETWORK, not the
 *      §39 offline cache: a cached count carries the freshness it had when it
 *      was cached, and pairing that with a live flow would present an old
 *      photo as where the night is now.
 *
 * NEVER "NOTHING IS MOVING". A failed read, a disabled gateway
 * (`map_projection_enabled` off answers `enabled: false`), a layer the gateway
 * did not actually produce (`crowd_flow` absent from `sources` — the
 * `map_crowd_flow_enabled` flag off, no zone model, or a producer refusal), or
 * an unreadable count all resolve to an EMPTY list, and an empty list renders
 * no card at all. The card has no empty state on purpose.
 *
 * Network-free by construction: the fetchers are passed in, so node:test drives
 * every branch with fakes.
 */
import type { MapObject } from '../../../types/mapObjects.ts';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import {
  anyEndListsPlaces,
  pairNightFlows,
  readServedNightFlows,
  type NightFlowCardModel,
} from '../state/crowdFlowPairing.ts';

/** The gateway kind this card reads, and nothing else. */
export const NIGHT_FLOW_KINDS = ['crowd_flow'] as const;
/** One page of flows is plenty: the card shows at most MAX_NIGHT_FLOWS. */
export const NIGHT_FLOW_PAGE_LIMIT = 20;

/** What the gateway read must say for its flows to be usable. */
export type NightFlowGatewayResult =
  | { ok: true; enabled: boolean; sources: readonly string[]; objects: readonly MapObject[] }
  | { ok: false };

export type NightFlowClustersResult = { ok: true; clusters: readonly MediaMapCluster[] } | { ok: false };

export interface NightFlowSources {
  /** `GET /map/projection?kinds=crowd_flow` for the viewer's coarse viewport. */
  readFlows: (opts: { center: { lat: number; lng: number }; signal: AbortSignal }) => Promise<NightFlowGatewayResult>;
  /** `GET /media/map?city=` from the network. */
  readClusters: (opts: { city: string | null; signal: AbortSignal }) => Promise<NightFlowClustersResult>;
}

export interface LoadNightFlowOptions {
  /** The viewer's coarse location. Null ⇒ no viewport ⇒ nothing is read. */
  center: { lat: number; lng: number } | null;
  city: string | null;
  nowMs: number;
  signal: AbortSignal;
}

/** The cards to show, or `[]` for every reason there is nothing to show. Never throws. */
export async function loadNightFlowCards(
  opts: LoadNightFlowOptions,
  sources: NightFlowSources,
): Promise<NightFlowCardModel[]> {
  if (!opts.center) return [];
  let gateway: NightFlowGatewayResult;
  try {
    gateway = await sources.readFlows({ center: opts.center, signal: opts.signal });
  } catch {
    return [];
  }
  if (!gateway.ok || gateway.enabled !== true) return [];
  if (!Array.isArray(gateway.sources) || !gateway.sources.includes('crowd_flow')) return [];
  const flows = readServedNightFlows(Array.isArray(gateway.objects) ? gateway.objects : [], opts.nowMs);
  // No flow that could be paired ⇒ the counts are not read at all.
  if (flows.length === 0 || !anyEndListsPlaces(flows)) return [];
  if (opts.signal.aborted) return [];

  let counts: NightFlowClustersResult;
  try {
    counts = await sources.readClusters({ city: opts.city, signal: opts.signal });
  } catch {
    return [];
  }
  if (!counts.ok || !Array.isArray(counts.clusters)) return [];
  return pairNightFlows(flows, counts.clusters);
}
