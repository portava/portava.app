/** Current moderation visibility at a public serve boundary, including cached
 * projections. A place's real-world business status is deliberately separate.
 * No allow cache: withholding must affect the next request on every replica. */
export type CanonicalPlaceVisibility =
  | { ok: true; visibleIds: Set<string>; existingIds: Set<string> }
  | { ok: false; reason: 'unreadable' | 'too_many_places' | 'invalid_merge_graph' };

type VisibilityRow = { id: string; moderation_status: 'visible' | 'withheld'; merged_into_place_id: string | null };
const BATCH = 100;
const MAX_NODES = 4096;
const MAX_DEPTH = 32;

export async function readCanonicalPlaceVisibility(sc: any, ids: readonly string[]): Promise<CanonicalPlaceVisibility> {
  const requested = [...new Set(ids)];
  if (!requested.length) return { ok: true, visibleIds: new Set(), existingIds: new Set() };
  if (requested.length > MAX_NODES) return { ok: false, reason: 'too_many_places' };
  if (requested.some(id => typeof id !== 'string' || !id)) return { ok: false, reason: 'unreadable' };
  const rows = new Map<string, VisibilityRow | null>();
  let pending = requested;
  try {
    for (let depth = 0; pending.length; depth += 1) {
      if (depth >= MAX_DEPTH || rows.size + pending.length > MAX_NODES) return { ok: false, reason: 'invalid_merge_graph' };
      const next = new Set<string>();
      for (let offset = 0; offset < pending.length; offset += BATCH) {
        const batch = pending.slice(offset, offset + BATCH);
        const result = await sc.from('places')
          .select('id, moderation_status, merged_into_place_id', { count: 'exact' })
          .in('id', batch).limit(batch.length + 1);
        if (result?.error || !Array.isArray(result?.data) || !Number.isInteger(result?.count)
          || result.count !== result.data.length || result.data.length > batch.length) return { ok: false, reason: 'unreadable' };
        for (const id of batch) rows.set(id, null);
        const seen = new Set<string>();
        for (const row of result.data) {
          if (!row || !batch.includes(row.id) || seen.has(row.id)
            || !['visible', 'withheld'].includes(row.moderation_status)
            || !(row.merged_into_place_id === null || (typeof row.merged_into_place_id === 'string' && row.merged_into_place_id.length > 0))) {
            return { ok: false, reason: 'unreadable' };
          }
          seen.add(row.id); rows.set(row.id, row);
          if (row.merged_into_place_id && !rows.has(row.merged_into_place_id)) next.add(row.merged_into_place_id);
        }
      }
      pending = [...next].filter(id => !rows.has(id));
    }
    const visibleIds = new Set<string>();
    for (const id of requested) {
      const visited = new Set<string>();
      let current: string | null = id;
      let visible = true;
      while (current) {
        if (visited.has(current)) return { ok: false, reason: 'invalid_merge_graph' };
        visited.add(current);
        const row: VisibilityRow | null | undefined = rows.get(current);
        if (!row || row.moderation_status !== 'visible') { visible = false; break; }
        current = row.merged_into_place_id;
      }
      if (visible) visibleIds.add(id);
    }
    return { ok: true, visibleIds, existingIds: new Set(requested.filter(id => rows.get(id) != null)) };
  } catch { return { ok: false, reason: 'unreadable' }; }
}


/** Complete visible provider group, including arbitrarily old merge aliases.
 * Bounds are refusals, not silent truncation. Withheld subtrees contribute no refs. */
export async function readCanonicalPlaceGroup(sc: any, id: string): Promise<
  {ok:true;place:any;refs:any[]} | {ok:false;reason:'not_found'|'unreadable'|'invalid_merge_graph'|'too_many_places'}> {
  const visibility = await readCanonicalPlaceVisibility(sc, [id]);
  if (!visibility.ok) return visibility;
  if (!visibility.visibleIds.has(id)) return {ok:false,reason:'not_found'};
  try {
    let place: any;
    let current = id;
    const ancestors = new Set<string>();
    while (true) {
      if (ancestors.has(current) || ancestors.size >= MAX_DEPTH) return {ok:false,reason:'invalid_merge_graph'};
      ancestors.add(current);
      const result = await sc.from('places').select('*').eq('id',current).maybeSingle();
      if (result.error) return {ok:false,reason:'unreadable'};
      if (!result.data || result.data.moderation_status !== 'visible') return {ok:false,reason:'not_found'};
      place = result.data;
      if (!place.merged_into_place_id) break;
      current = place.merged_into_place_id;
    }
    const ids = new Set<string>([current]);
    let frontier = [current];
    for (let depth = 0; frontier.length; depth += 1) {
      if (depth >= MAX_DEPTH) return {ok:false,reason:'invalid_merge_graph'};
      const next: string[] = [];
      for (let offset = 0; offset < frontier.length; offset += BATCH) {
        const batch = frontier.slice(offset,offset+BATCH);
        for (let page = 0; ; page += 500) {
          const result = await sc.from('places').select('id,moderation_status,merged_into_place_id',{count:'exact'})
            .in('merged_into_place_id',batch).order('id').range(page,page+499);
          if (result.error || !Array.isArray(result.data) || !Number.isInteger(result.count)
            || result.count > MAX_NODES || result.data.length !== Math.min(500,Math.max(0,result.count-page))) return {ok:false,reason:'unreadable'};
          for (const row of result.data) {
            if (!row?.id || !batch.includes(row.merged_into_place_id) || !['visible','withheld'].includes(row.moderation_status)) return {ok:false,reason:'unreadable'};
            if (row.moderation_status === 'withheld') continue;
            if (ids.has(row.id)) return {ok:false,reason:'invalid_merge_graph'};
            ids.add(row.id); next.push(row.id);
            if (ids.size > MAX_NODES) return {ok:false,reason:'too_many_places'};
          }
          if (page+result.data.length >= result.count) break;
        }
      }
      frontier=next;
    }
    const refs:any[]=[];
    const allIds=[...ids];
    const seen=new Set<string>();
    for (let offset=0;offset<allIds.length;offset+=BATCH) {
      const batch=allIds.slice(offset,offset+BATCH);
      for(let page=0;;page+=500) {
        const result=await sc.from('external_place_references').select('*',{count:'exact'})
          .in('place_id',batch).order('id').range(page,page+499);
        if(result.error || !Array.isArray(result.data) || !Number.isInteger(result.count) || result.count>10000
          || result.data.length!==Math.min(500,Math.max(0,result.count-page))) return {ok:false,reason:'unreadable'};
        for(const row of result.data) {
          if(!row?.id || !batch.includes(row.place_id) || seen.has(row.id)) return {ok:false,reason:'unreadable'};
          seen.add(row.id);refs.push(row);
          if(refs.length>10000) return {ok:false,reason:'too_many_places'};
        }
        if(page+result.data.length>=result.count) break;
      }
    }
    // Moderation may have changed while paging the group. Recheck every source
    // immediately before delivery, including the originally requested alias.
    const finalVisibility=await readCanonicalPlaceVisibility(sc,[id,...ids]);
    if(!finalVisibility.ok) return finalVisibility;
    if(!finalVisibility.visibleIds.has(id) || !finalVisibility.visibleIds.has(place.id)) return {ok:false,reason:'not_found'};
    return {ok:true,place,refs:refs.filter(row=>finalVisibility.visibleIds.has(row.place_id))};
  } catch { return {ok:false,reason:'unreadable'}; }
}

/** Current canonical row without a provider-reference read (Intel, Place Days). */
export async function readCanonicalPlaceRow(sc:any,id:string):Promise<{ok:true;place:any}|{ok:false;reason:string}> {
 const visibility=await readCanonicalPlaceVisibility(sc,[id]);
 if(!visibility.ok)return visibility;
 if(!visibility.visibleIds.has(id))return {ok:false,reason:'not_found'};
 try {
  let current=id;const seen=new Set<string>();
  while(true){
   if(seen.has(current)||seen.size>=MAX_DEPTH)return {ok:false,reason:'invalid_merge_graph'};
   seen.add(current);
   const result=await sc.from('places').select('*').eq('id',current).maybeSingle();
   if(result.error)return {ok:false,reason:'unreadable'};
   if(!result.data||result.data.moderation_status!=='visible')return {ok:false,reason:'not_found'};
   if(!result.data.merged_into_place_id)return {ok:true,place:result.data};
   current=result.data.merged_into_place_id;
  }
 }catch{return {ok:false,reason:'unreadable'};}
}
