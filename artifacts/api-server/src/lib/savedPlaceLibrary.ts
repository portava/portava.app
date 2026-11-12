import { afterKey, readWhole } from './feedReads.js';
import { discoveryCanonicalKey, governDiscoveryPlaces, readDiscoveryPlaceFacts } from './discoveryPlaceGovernance.js';

/** Stable, private UUID targets for collection_items when a provider has no registry UUID. */
export const PROVIDER_REF_LIST = '__portava_collection_place_ref_v1__';
type Source = 'wishlist' | 'community' | 'collections';
type Row = Record<string, any>;
type Entry = { source: Source; id: string; savedAt: string | null; listId?: string; collectionId?: string; data?: Row; refId?: string };
type Summary = { key: string; placeId: string; collectionEntityId: string | null; title: string; coverUrl: string|null; city: string | null; country: string | null; latitude: number | null; longitude: number | null; savedAt: string | null; sources: Source[]; listIds: string[]; collectionIds: string[]; pending: boolean };
const sources: Source[] = ['wishlist', 'community', 'collections'];
const osm = (id: string) => /^(node|way|relation)\/\d+$/.test(id.replace(/^osm\//, '')) ? id.replace(/^osm\//, '') : null;
const chunks = <T>(rows: T[], size = 100): T[][] => Array.from({length: Math.ceil(rows.length / size)}, (_, i) => rows.slice(i * size, (i + 1) * size));
const coord = (n: unknown, limit: number) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
const str = (n: unknown) => typeof n === 'string' && n.trim() ? n.trim() : null;

async function allRows(build: () => any, key = 'id'): Promise<Row[]> {
  const read = await readWhole<Row>((after, size) => afterKey(build().order(key, { ascending: true }).limit(size), key, after), r => r[key]);
  if (!read.ok) throw new Error('Saved places unavailable');
  return read.value;
}

async function ownerEntries(sc: any, owner: string, source: Source): Promise<Entry[]> {
  if (source === 'wishlist') {
    const rows = await allRows(() => sc.from('wishlist_places').select('id,place_id,list_id,place_data,saved_at', {count:'exact'}).eq('user_id',owner));
    return rows.filter(r => r.list_id !== PROVIDER_REF_LIST).map(r => ({source,id:r.place_id,listId:r.list_id,savedAt:r.saved_at,data:r.place_data}));
  }
  if (source === 'community') {
    const rows = await allRows(() => sc.from('discovery_place_saves').select('place_id,saved_at',{count:'exact'}).eq('user_id',owner), 'place_id');
    return rows.map(r => ({source,id:r.place_id,savedAt:r.saved_at}));
  }
  const collections = await allRows(() => sc.from('collections').select('id',{count:'exact'}).eq('owner_id',owner));
  const entries: Entry[] = [];
  for (const ids of chunks(collections.map(c => c.id))) {
    const items = await allRows(() => sc.from('collection_items').select('id,collection_id,entity_id,saved_at',{count:'exact'}).in('collection_id',ids).eq('entity_type','place'));
    for (const r of items) entries.push({source,id:r.entity_id,collectionId:r.collection_id,savedAt:r.saved_at});
  }
  return resolveOwnerRefs(sc, owner, entries);
}

async function resolveOwnerRefs(sc: any, owner: string, entries: Entry[]): Promise<Entry[]> {
  const refs = new Map<string, Row>();
  for (const ids of chunks([...new Set(entries.map(r => r.id))])) {
    const rows = await allRows(() => sc.from('wishlist_places').select('id,place_id,place_data',{count:'exact'}).eq('user_id',owner).eq('list_id',PROVIDER_REF_LIST).in('id',ids));
    for (const r of rows) refs.set(r.id, r);
  }
  return entries.map(entry => {
    const ref = refs.get(entry.id);
    return ref ? {...entry, refId:entry.id, id:ref.place_id, data:ref.place_data} : entry;
  });
}

/** Resolve known OSM and other provider aliases before reading governed facts.
 * Keep the original provider ID as the identifier used to reopen a wishlist save. */
async function previews(sc: any, entries: Entry[]): Promise<Summary[]> {
  const visible = await governDiscoveryPlaces(sc, entries, row => row.id);
  if (!visible.readable) throw new Error('Place visibility unavailable');
  const aliases = new Map<string, string>();
  const providerGroups = new Map<string, Map<string, string[]>>();
  for (const r of visible.rows) {
    if (discoveryCanonicalKey(r.id)) continue;
    const providerId = osm(r.id);
    const parts = providerId ? ['osm', providerId] : /^([a-z][a-z0-9_-]*)\/(.+)$/i.exec(r.id)?.slice(1);
    if (!parts) continue;
    const [provider, key] = parts;
    const keys = providerGroups.get(provider) ?? new Map<string, string[]>();
    keys.set(key, [...(keys.get(key) ?? []), r.id]); providerGroups.set(provider, keys);
  }
  for (const [provider, keys] of providerGroups) {
    for (const batch of chunks([...keys.keys()])) {
      // Community listings can identify an OSM place even without a registry link.
      if (provider === 'osm') {
        const community = await allRows(() => sc.from('discovery_places').select('id,osm_id,canonical_location_id',{count:'exact'}).in('osm_id',batch));
        for (const r of community) for (const raw of keys.get(r.osm_id) ?? []) aliases.set(raw, r.id);
      }
      const registry = await allRows(() => sc.from('external_place_references').select('id,provider_place_id,place_id',{count:'exact'}).eq('provider',provider).in('provider_place_id',batch));
      for (const r of registry) for (const raw of keys.get(r.provider_place_id) ?? []) aliases.set(raw, r.place_id);
    }
  }
  const directIds = [...new Set(visible.rows.map(row => discoveryCanonicalKey(row.id)).filter((id): id is string => !!id))];
  for (const batch of chunks(directIds)) {
    const links = await allRows(() => sc.from('discovery_places').select('id,canonical_location_id',{count:'exact'}).in('id',batch));
    for (const r of links) if (r.canonical_location_id) aliases.set(r.id, r.canonical_location_id);
  }
  const ids = [...new Set(visible.rows.map(r => aliases.get(r.id) ?? aliases.get(discoveryCanonicalKey(r.id) ?? "") ?? discoveryCanonicalKey(r.id)).filter((id): id is string => !!id))];
  const facts = new Map<string, Row>();
  for (const batch of chunks(ids)) {
    const rows = await readDiscoveryPlaceFacts(sc, batch);
    if (!rows) throw new Error('Place previews unavailable');
    for (const r of rows) facts.set(r.id, r);
  }
  const output: Summary[] = [];
  for (const e of visible.rows) {
    const uuid = aliases.get(e.id) ?? aliases.get(discoveryCanonicalKey(e.id) ?? "") ?? discoveryCanonicalKey(e.id);
    const fact = uuid ? facts.get(uuid) : e.data;
    if (!fact) continue;
    const title = str(fact.name);
    if (!title) continue;
    output.push({key:uuid ?? (osm(e.id) ?? e.id), placeId:e.id, collectionEntityId:uuid ?? e.refId ?? null,
      title,coverUrl:str(fact.image_url),city:str(fact.city),country:str(fact.country ?? fact.country_code),latitude:coord(fact.lat ?? fact.latitude,90),longitude:coord(fact.lng ?? fact.longitude,180),
      savedAt:e.savedAt,sources:[e.source],listIds:e.listId?[e.listId]:[],collectionIds:e.collectionId?[e.collectionId]:[],pending:false});
  }
  return output;
}

export async function savedPlaceLibrary(sc: any, owner: string) {
  const result = await Promise.allSettled(sources.map(async source => previews(sc, await ownerEntries(sc,owner,source))));
  const unavailableSources: Source[] = [];
  const byKey = new Map<string,Summary>();
  result.forEach((r,i) => {
    if (r.status === 'rejected') { unavailableSources.push(sources[i]); return; }
    for (const place of r.value) {
      const old = byKey.get(place.key);
      if (!old) { byKey.set(place.key,place); continue; }
      for (const field of ['sources','listIds','collectionIds'] as const) Object.assign(old, {[field]:[...new Set([...old[field],...place[field]])]});
      old.collectionEntityId ??= place.collectionEntityId;
      if (place.savedAt && (!old.savedAt || place.savedAt > old.savedAt)) old.savedAt=place.savedAt;
    }
  });
  return {state:unavailableSources.length === 3 ? 'unavailable' : unavailableSources.length ? 'partial' : 'ready',unavailableSources,places:[...byKey.values()].sort((a,b)=>(b.savedAt??'').localeCompare(a.savedAt??'') || a.key.localeCompare(b.key))};
}

export async function collectionPlacePreviews(sc: any, owner: string, ids: string[]) {
  const entries = await resolveOwnerRefs(sc,owner,ids.map(id=>({id,source:'collections',savedAt:null})));
  const rows = await previews(sc,entries);
  return new Map(entries.flatMap(entry => {
    const row = rows.find(place => place.placeId === entry.id);
    return row ? [[entry.refId ?? entry.id, row] as const] : [];
  }));
}

export async function fileSavedPlaceForOwner(sc: any, owner: string, placeId: string, collectionId: string) {
  const collection=await sc.from('collections').select('id').eq('id',collectionId).eq('owner_id',owner).maybeSingle();
  if(collection.error)throw new Error('Collection unavailable');
  if(!collection.data)return null;
  const saved=await savedPlaceLibrary(sc,owner);
  const place=saved.places.find(p=>p.placeId===placeId || p.key===placeId || p.collectionEntityId===placeId);
  if(!place) { if(saved.unavailableSources.length)throw new Error('Saved places unavailable'); return null; }
  if (place.collectionIds.includes(collectionId)) return {collectionId,entityId:place.collectionEntityId};
  let entityId=place.collectionEntityId;
  if(!entityId) {
    const reference=await sc.from('wishlist_places').upsert({user_id:owner,place_id:place.placeId,list_id:PROVIDER_REF_LIST,
      place_data:{name:place.title,city:place.city,country:place.country,lat:place.latitude,lng:place.longitude}},
      {onConflict:'user_id,place_id,list_id'}).select('id').single();
    if(reference.error || !reference.data?.id)throw new Error('Could not retain provider place');
    entityId=reference.data.id;
  }
  const written=await sc.from('collection_items').upsert({collection_id:collectionId,entity_type:'place',entity_id:entityId},{onConflict:'collection_id,entity_type,entity_id',ignoreDuplicates:true});
  if(written.error)throw new Error('Could not file place');
  return {collectionId,entityId};
}
