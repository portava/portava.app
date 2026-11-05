import { z } from 'zod';
import { readFlagState } from './capability/schemaCapability.js';
const disclosure = z.object({ version: z.string().min(1).max(64), title: z.string().min(1).max(100), what: z.string().min(1).max(1500), who: z.string().min(1).max(1500), retention: z.string().min(1).max(1500), off: z.string().min(1).max(1500) }).strict();
/** Deliberately no built-in grant wording: operator supplies reviewed, versioned text. */
export function routeFlowDisclosure(): z.infer<typeof disclosure> | null {
  try { const result = disclosure.safeParse(JSON.parse(process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE ?? 'null')); return result.success ? result.data : null; } catch { return null; }
}
export async function readRouteFlowConsent(db: any, userId: string) {
  const words = routeFlowDisclosure();
  const [flag, read] = await Promise.all([readFlagState(db, 'map_route_flow_consent_enabled'), db.from('route_flow_contribution_consent').select('enabled,consent_version,withdrawn_at').eq('user_id', userId).maybeSingle()]);
  if (flag === 'unreadable' || read.error) throw new Error('route_flow_consent_unreadable');
  return { available: flag === 'on' && words !== null, granted: read.data?.enabled === true && read.data?.withdrawn_at == null, current: words !== null && read.data?.consent_version === words.version, disclosure: words };
}
