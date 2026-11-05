import { readCanonicalPlaceVisibility } from './places/placeGovernance.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isCanonicalPlaceAdmissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error
    && error.code === 'PT409' && error.message === 'canonical_place_unavailable';
}
/** Discovery's db/ identity is shared by curated and canonical place tables. */
export function discoveryCanonicalKey(value: string): string | null {
  const key = value.replace(/^db\//, '').toLowerCase();
  return UUID.test(key) ? key : null;
}

const osmKey = (value: string): string | null => {
  const key = value.replace(/^osm\//, '');
  return /^(node|way|relation)\/\d+$/.test(key) ? key : null;
};

/** Fresh aliases as well as direct canonical IDs: a curated UUID or an OSM
 * provider key must not revive a held place. Never use the Memory bridge's
 * structural cache for a moderation decision. */
export async function governDiscoveryPlaces<T>(sc: any, rows: readonly T[], idOf: (row: T) => string): Promise<{ rows: T[]; readable: boolean }> {
  const keys = [...new Set(rows.map(row => discoveryCanonicalKey(idOf(row))).filter((key): key is string => key !== null))];
  const osmKeys = [...new Set(rows.map(row => osmKey(idOf(row))).filter((key): key is string => key !== null))];
  if (!keys.length && !osmKeys.length) return { rows: [...rows], readable: true };
  const linked = new Map<string, Set<string>>();
  const communityIds = new Map<string, Set<string>>();
  const providerKeysById = new Map<string, string>();
  const add = (key: string, value: unknown) => {
    if (value == null) return;
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid canonical place alias');
    const links = linked.get(key) ?? new Set<string>(); links.add(value.toLowerCase()); linked.set(key, links);
  };
  const read = async (query: PromiseLike<any>, maximum: number) => {
    const result = await query;
    if (result?.error || !Array.isArray(result?.data) || result.count !== result.data.length || result.data.length > maximum) throw new Error('Unreadable canonical place aliases');
    return result.data as Record<string, any>[];
  };
  try {
    if (keys.length + osmKeys.length > 4096) throw new Error('Too many place aliases');
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batch = keys.slice(offset, offset + 100);
      const aliases = await read(sc.from('discovery_places').select('id,canonical_location_id,osm_id', { count: 'exact' }).in('id', batch).limit(batch.length + 1), batch.length);
      for (const row of aliases) {
        if (!batch.includes(row.id)) throw new Error('Unexpected canonical place alias');
        add(row.id, row.canonical_location_id);
        if (row.osm_id != null) {
          const providerKey = typeof row.osm_id === 'string' ? osmKey(row.osm_id) : null;
          if (!providerKey) throw new Error('Invalid community OSM alias');
          providerKeysById.set(row.id, providerKey);
          if (!osmKeys.includes(providerKey)) osmKeys.push(providerKey);
        }
      }
    }
    if (keys.length + osmKeys.length > 4096) throw new Error('Too many place aliases');
    for (let offset = 0; offset < osmKeys.length; offset += 100) {
      const batch = osmKeys.slice(offset, offset + 100);
      const [community, provider] = await Promise.all([
        read(sc.from('discovery_places').select('id,osm_id,canonical_location_id', { count: 'exact' }).in('osm_id', batch).limit(4097), 4096),
        read(sc.from('external_place_references').select('provider_place_id,place_id', { count: 'exact' }).eq('provider', 'osm').in('provider_place_id', batch).limit(batch.length + 1), batch.length),
      ]);
      for (const row of community) {
        if (!batch.includes(row.osm_id)) throw new Error('Unexpected OSM alias');
        // The community UUID can itself collide with a canonical row.
        add(row.osm_id, row.canonical_location_id);
        if (typeof row.id === 'string' && UUID.test(row.id)) {
          const id = row.id.toLowerCase(); keys.push(id);
          const ids = communityIds.get(row.osm_id) ?? new Set<string>(); ids.add(id); communityIds.set(row.osm_id, ids);
        }
      }
      for (const row of provider) {
        if (!batch.includes(row.provider_place_id)) throw new Error('Unexpected OSM reference');
        add(row.provider_place_id, row.place_id);
      }
    }
    // A community UUID may reach the registry only through its provider key.
    // Check that path even if the response contains no raw OSM candidate.
    for (const [id, providerKey] of providerKeysById) {
      for (const canonicalId of linked.get(providerKey) ?? []) add(id, canonicalId);
      communityIds.set(id, communityIds.get(providerKey) ?? new Set());
    }
  } catch {
    return { readable: false, rows: rows.filter(row => !discoveryCanonicalKey(idOf(row)) && !osmKey(idOf(row))) };
  }
  const state = await readCanonicalPlaceVisibility(sc, [...new Set([...keys, ...[...linked.values()].flatMap(ids => [...ids])])]);
  return {
    readable: state.ok,
    rows: rows.filter(row => {
      const direct = discoveryCanonicalKey(idOf(row));
      const key = direct ?? osmKey(idOf(row));
      if (!key) return true;
      const links = linked.get(key) ?? new Set<string>();
      const aliases = communityIds.get(key) ?? new Set<string>();
      if (!direct && !links.size && !aliases.size) return true;
      return state.ok && (!direct || !state.existingIds.has(direct) || state.visibleIds.has(direct))
        && [...links].every(id => state.visibleIds.has(id))
        && [...aliases].every(id => !state.existingIds.has(id) || state.visibleIds.has(id));
    }),
  };
}

/** Current facts for either Discovery identity source. Canonical rows take
 * precedence over same-ID community shadows, even when no longer servable. */
export async function readDiscoveryPlaceFacts(sc: any, ids: readonly string[], options: { includeInactive?: boolean } = {}): Promise<Record<string, any>[] | null> {
  const keys = [...new Set(ids.map(discoveryCanonicalKey).filter((key): key is string => key !== null))];
  if (keys.length > 4096) return null;
  const candidates: Record<string, any>[] = [];
  try {
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batch = keys.slice(offset, offset + 100);
      const [community, canonical] = await Promise.all([
        sc.from('discovery_places').select('id,name,status,submitted_by,lat,lng,category,place_type,image_url,city', { count: 'exact' }).in('id', batch).limit(batch.length + 1),
        sc.from('places').select('id,name,status,latitude,longitude,primary_category,merged_into_place_id,city', { count: 'exact' }).in('id', batch).limit(batch.length + 1),
      ]);
      if ([community, canonical].some(result => result?.error || !Array.isArray(result?.data)
        || result.count !== result.data.length || result.data.length > batch.length)) return null;
      const canonicalIds = new Set(canonical.data.map((row: any) => row.id));
      candidates.push(...community.data.filter((row: any) => !canonicalIds.has(row.id) && (options.includeInactive || row.status === 'active')));
      candidates.push(...canonical.data.filter((row: any) => options.includeInactive || (row.status === 'active' && row.merged_into_place_id === null))
        .map((row: any) => ({ ...row, lat: row.latitude, lng: row.longitude, category: row.primary_category, submitted_by: null, place_type: null })));
    }
    const governed = await governDiscoveryPlaces(sc, candidates, row => row.id);
    return governed.readable ? governed.rows : null;
  } catch { return null; }
}

/** Reviews and votes also accept gem IDs. Resolve that relationship before
 * serving or accepting activity, so an alternate ID cannot bypass a hold. */
export async function readPlaceInteractionVisibility(sc: any, id: string): Promise<boolean | null> {
  const key = discoveryCanonicalKey(id);
  if (!key) return false;
  const governed = await governDiscoveryPlaces(sc, [key], value => value);
  if (!governed.readable) return null;
  if (!governed.rows.length) return false;
  try {
    const gem = await sc.from('hidden_gems').select('id,canonical_place_id').eq('id', key).maybeSingle();
    if (gem?.error) return null;
    if (!gem?.data?.canonical_place_id) return true;
    const linked = await readCanonicalPlaceVisibility(sc, [gem.data.canonical_place_id]);
    return linked.ok ? linked.visibleIds.has(gem.data.canonical_place_id) : null;
  } catch { return null; }
}
