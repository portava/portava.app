/**
 * discoveryRecommendations — the client call to
 * `GET /v1/discovery/recommendations/:kind` (census-discovery §94, lane
 * W11-X2; §91.7 item 2; DC-01).
 *
 * The server serves `01` §4's three output kinds PDE ranks and no other route
 * served — Trails, Shared Moments and emerging discoveries — behind
 * `discovery_output_kinds_enabled` (3483, seeded FALSE), signed-in only
 * (api-server routes/discoveryOutputKinds.ts). Nothing called it. Callers gate
 * on the SAME flag through FeatureFlagsContext, so with the flag off no request
 * leaves the device (DiscoveryOutputKindsRail).
 *
 * `11` §9 answers, kept apart rather than collapsed into an empty list:
 *   200 → the ranked page, in the server's order, each item carrying the
 *         `recommendationId` its impression row carries (serve point 13);
 *   401 / no token → `signed_out` (no request is sent without a token);
 *   404 → `disabled` (the flag is off, or the kind is unknown);
 *   400 → `invalid` (emerging discoveries need a destination);
 *   503 and every other status → `unavailable`: a read failed, which is NOT
 *         "there is nothing to recommend";
 *   a thrown fetch → `network`; an unparseable body → `unavailable`.
 *
 * Its own module on purpose: `services/discovery.ts`'s carriers are pinned by
 * discoveryRefusalConsumers.guard (G1), and this route speaks `11` §9 status
 * codes, not the Discovery refusal envelope.
 */

export type OutputKind = 'trails' | 'shared_moments' | 'emerging_discoveries';

/** A served Trail (api-server services/trails TrailRow), as the rail reads it. */
export interface OutputKindTrail { id: string; title: string | null; destination: string | null; recommendationId?: string }
/** A served Shared Moment (api-server lib/discoveryCandidates/outputKinds RankableMoment). */
export interface OutputKindMoment { id: string; title: string | null; city: string | null; recommendationId?: string }
/** A served emerging discovery: the place and its trend state. */
export interface OutputKindEmerging { place: { id: string; name: string | null }; trendState: string; recommendationId?: string }

export type OutputKindItem = OutputKindTrail | OutputKindMoment | OutputKindEmerging;

export type OutputKindResult =
  | { ok: true; kind: OutputKind; rankedBy: string; items: OutputKindItem[]; /** census-discovery §105 (DV-83): the body carried a `partial` refusal — the rows are real, the list is incomplete. */ partial?: true }
  | { ok: false; reason: 'signed_out' | 'disabled' | 'invalid' | 'unavailable' | 'network' | 'not_configured' };

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

let _tokenSourceForTests: (() => Promise<string | null>) | null = null;

async function freshToken(): Promise<string | null> {
  try {
    // Required lazily, as services/discovery.ts does: a static apiToken → lib/supabase
    // edge would pull React Native in at module load and stop this loading under Node.
    return await (_tokenSourceForTests ?? (require('./apiToken.ts') as { freshToken: () => Promise<string | null> }).freshToken)();
  } catch {
    return null;
  }
}

/** One label per served item, whatever its kind — what a card prints. */
export function outputKindItemLabel(kind: OutputKind, item: OutputKindItem): string | null {
  if (kind === 'emerging_discoveries') return (item as OutputKindEmerging).place?.name ?? null;
  return (item as OutputKindTrail | OutputKindMoment).title ?? null;
}

/** The item's own id (an emerging discovery is its place). */
export function outputKindItemId(kind: OutputKind, item: OutputKindItem): string {
  return kind === 'emerging_discoveries' ? String((item as OutputKindEmerging).place?.id) : String((item as OutputKindTrail).id);
}

export async function getOutputKindRecommendations(
  kind: OutputKind,
  opts: { destination?: string | null } = {},
): Promise<OutputKindResult> {
  const base = apiBase();
  if (!base) return { ok: false, reason: 'not_configured' };
  const token = await freshToken();
  if (!token) return { ok: false, reason: 'signed_out' };
  const params = new URLSearchParams();
  if (opts.destination) params.set('destination', opts.destination);
  const qs = params.toString();
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/discovery/recommendations/${kind}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (res.status === 401) return { ok: false, reason: 'signed_out' };
  if (res.status === 404) return { ok: false, reason: 'disabled' };
  if (res.status === 400) return { ok: false, reason: 'invalid' };
  if (!res.ok) return { ok: false, reason: 'unavailable' };
  let body: { kind?: unknown; rankedBy?: unknown; items?: unknown; refusal?: { coverage?: unknown } | null };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!body || !Array.isArray(body.items)) return { ok: false, reason: 'unavailable' }; const coverage = body.refusal ? body.refusal.coverage : undefined; if (body.refusal && coverage !== 'partial') return { ok: false, reason: 'unavailable' };  // census-discovery §105 (DV-83, D-W11X2-60): a refusal beside a 200 is a failed read; `nothing` (or any unknown coverage) is never an empty page
  return {
    ok: true,
    kind,
    rankedBy: typeof body.rankedBy === 'string' ? body.rankedBy : 'none',
    items: body.items as OutputKindItem[], ...(coverage === 'partial' ? { partial: true as const } : {}),
  };
}

/** Test seam — the token SOURCE only, as services/discovery.ts's. */
export function _setOutputKindsTokenSourceForTests(fn: (() => Promise<string | null>) | null): void {
  _tokenSourceForTests = fn;
}
