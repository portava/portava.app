import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureMessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from './discoveryViewerScope.ts';
import { fetchOwnedApi } from './ownedApiRequest.ts';
import { pendingPlaceChanges, reconcileSavedPlaceRead, retryPendingPlaces, type PendingPlaceChange } from './discoveryBookmarks.ts';

export type SavedPlaceSource = 'wishlist' | 'community' | 'collections';
export interface SavedPlaceSummary {
  key: string; placeId: string; collectionEntityId: string | null; title: string; city: string | null; country: string | null;
  latitude: number | null; longitude: number | null; savedAt: string | null; sources: SavedPlaceSource[]; listIds: string[]; collectionIds: string[]; pending: boolean;
}
export interface SavedPlaceRead {
  state: 'ready' | 'partial' | 'offline' | 'unavailable';
  places: SavedPlaceSummary[];
  unavailableSources: SavedPlaceSource[];
}

const sources: SavedPlaceSource[] = ['wishlist','community','collections'];
const unavailable = (): SavedPlaceRead => ({state:'unavailable',places:[],unavailableSources:[...sources]});
const cacheKey = (id:string) => `portava_saved_place_library_v1:${id}`;

function validPlace(value: any): value is SavedPlaceSummary {
  return value && typeof value.key==='string' && typeof value.placeId==='string' && typeof value.title==='string'
    && Array.isArray(value.sources) && value.sources.every((s:SavedPlaceSource)=>sources.includes(s))
    && Array.isArray(value.collectionIds) && Array.isArray(value.listIds);
}

export function mergePendingPlaces(places: SavedPlaceSummary[], changes: PendingPlaceChange[]): SavedPlaceSummary[] {
  const merged = places.map(row => ({...row,listIds:[...row.listIds],sources:[...row.sources]}));
  for (const change of changes) {
    const place=change.place;
    const listId=place.listId ?? 'global';
    let row=merged.find(r=>r.placeId===place.id || r.key===place.id);
    if (!row && !change.add) continue;
    if (!row) {
      row={key:place.id,placeId:place.id,collectionEntityId:null,title:place.name,city:null,country:null,latitude:place.lat ?? null,longitude:place.lng ?? null,
        savedAt:new Date(place.savedAt).toISOString(),sources:[],listIds:[],collectionIds:[],pending:true};
      merged.push(row);
    }
    row.pending=!change.sent;
    if (change.add) {
      if (!row.sources.includes('wishlist')) row.sources.push('wishlist');
      if (!row.listIds.includes(listId)) row.listIds.push(listId);
    } else {
      row.listIds=row.listIds.filter(id=>id!==listId);
      if (!row.listIds.length) row.sources=row.sources.filter(s=>s!=='wishlist');
    }
  }
  return merged.filter(row=>row.sources.length).sort((a,b)=>(b.savedAt??'').localeCompare(a.savedAt??'') || a.key.localeCompare(b.key));
}

export async function loadSavedPlaces(): Promise<SavedPlaceRead> {
  const owner = captureMessagingOwnerRequest();
  if (!owner) return unavailable();
  const key = cacheKey(owner.ownerId);
  const scope = currentDiscoveryScope();
  const stillCurrent = () => owner.isCurrent();
  try {
    await retryPendingPlaces(owner.ownerId).catch(()=>{});
    const observed = await pendingPlaceChanges(owner.ownerId);
    const response = await fetchOwnedApi('/api/users/me/saved-places',{owner});
    const body = await response.json();
    if (!stillCurrent()) return unavailable();
    if (!response.ok || !['ready','partial'].includes(body?.state) || !Array.isArray(body.places) || !body.places.every(validPlace) || !Array.isArray(body.unavailableSources)) return unavailable();
    const changes = body.unavailableSources.includes('wishlist') ? await pendingPlaceChanges(owner.ownerId)
      : await reconcileSavedPlaceRead(owner.ownerId,observed,body.places);
    if (!stillCurrent()) return unavailable();
    // An acknowledged write missing from a current read can be held by moderation.
    const places = mergePendingPlaces(body.places,changes.filter(c=>!c.sent || body.places.some((p:SavedPlaceSummary)=>p.placeId===c.place.id)));
    await AsyncStorage.setItem(key,JSON.stringify(body.places)).catch(()=>{});
    return stillCurrent() ? {state:body.state,places,unavailableSources:body.unavailableSources} : unavailable();
  } catch {
    const scopeMatches = () => {
      const current = captureMessagingOwnerRequest();
      return isCurrentDiscoveryScope(scope) && current?.ownerId === owner.ownerId && current.sessionId === owner.sessionId;
    };
    if (!scopeMatches()) return unavailable();
    const cached=await AsyncStorage.getItem(key).catch(()=>null);
    const changes=await pendingPlaceChanges(owner.ownerId).catch(()=>[]);
    if (!scopeMatches() || (!cached && !changes.length)) return unavailable();
    try {
      const rows = cached ? JSON.parse(cached) : [];
      if (!Array.isArray(rows) || !rows.every(validPlace)) return unavailable();
      return {state:'offline',places:mergePendingPlaces(rows,changes),unavailableSources:[...sources]};
    } catch { return unavailable(); }
  }
}

export async function fileSavedPlace(placeId: string, collectionId: string): Promise<{ok:boolean}> {
  const owner=captureMessagingOwnerRequest();
  if (!owner) return {ok:false};
  try {
    const res=await fetchOwnedApi('/api/users/me/saved-places/collection',{owner,method:'PUT',body:{placeId,collectionId}});
    const result=await res.json();
    return {ok:owner.isCurrent() && res.ok && result?.ok===true && result.collectionId===collectionId};
  } catch { return {ok:false}; }
}
