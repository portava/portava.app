import { routedMapState, type RoutedMapData } from './layoverRoutedMap.ts';
import { continuousCoverageOf, providerRouteGeometryOf, type ProviderRouteGeometry } from './layoverProviderGeometry.ts';
import { currentExperienceGeometry, type ExperienceGeometry } from './layoverExperienceGeometryBinding.ts';
import type { ExperiencePlan } from '../services/layoverExperiencePlans.ts';
export interface LayoverGoogleMapProps {
  experienceMap?: ExperienceGeometry | null; experiencePlan?: ExperiencePlan;
  data: RoutedMapData | null | undefined; currentSnapshotId?: string | null; selectedIds: readonly string[];
  airport: { lat: number | null; lng: number | null; iataCode: string }; nowMs: number; budgetActive?: boolean; offline?: boolean;
}
export function googleMapContent(props: LayoverGoogleMapProps) {
  if(props.experiencePlan){
    if(props.offline||props.budgetActive||props.currentSnapshotId!==props.experiencePlan.contract.snapshotId||!currentExperienceGeometry(props.experienceMap,props.experiencePlan,props.nowMs))return null;
    const map=props.experienceMap;
    return {lines:map.hops.map((hop,i)=>({id:`${map.planId}:${i}`,label:hop.direction==='return'?'Return to airport':i===0?'Airport to first stop':`Travel to stop ${i+1}`,direction:hop.direction,value:hop.geometry})),coverage:null,title:'your timed experience',multiStop:map.stopIds.length>1,planRoute:true};
  }
  if (props.offline || props.budgetActive || routedMapState(props.data, props.currentSnapshotId, props.nowMs) !== 'current') return null;
  const cards = props.data?.cards ?? [];
  const card = [...props.selectedIds].reverse().map(id => cards.find(c => c.id === id)).find(Boolean);
  const lines: Array<{ id: string; label: string; direction: 'outbound' | 'return'; value: ProviderRouteGeometry }> = [];
  if (card && (card.routing.band === 'SAFE' || card.routing.band === 'TIGHT')) {
    const back = providerRouteGeometryOf(card.routing.geometry?.returnLeg), out = providerRouteGeometryOf(card.routing.geometry?.outbound);
    if (out && props.selectedIds.length === 1) lines.push({ id: `${card.id}:out`, label: `To ${card.title}`, direction: 'outbound', value: out });
    if (back) lines.push({ id: `${card.id}:return`, label: `Return from ${card.title}`, direction: 'return', value: back });
  }
  const parsed = continuousCoverageOf(props.data?.envelope?.continuous);
  const coverage = parsed?.state === 'available' && Date.parse(parsed.expiresAt) > props.nowMs ? parsed : null;
  return { lines, coverage, title: card?.title ?? null, multiStop: props.selectedIds.length > 1, planRoute: false };
}
