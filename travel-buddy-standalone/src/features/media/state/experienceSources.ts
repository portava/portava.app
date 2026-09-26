/**
 * features/media — which experiences the EXPERIENCES lens resolves
 * (spec §3 / §23; census-media §19).
 *
 * §43 has no "list experiences" endpoint: `GET /media/experiences/:id` resolves
 * ONE canonical Event or Trip id through its own gate. So the lens has to be
 * handed ids, and until this module it was handed none — the World shell passed
 * a constant empty array and the lens could only ever render its empty state,
 * which also meant the §14 Event and Trip entry contexts had no surface to be
 * produced from.
 *
 * The ids come from canonical surfaces the viewer can already see, in this
 * order: an id deep-linked in (an Event or Trip screen sending the viewer here),
 * the viewer's OWN events (hosting or attending), the viewer's OWN trips, then
 * events near the viewer's coarse location. Every id is still resolved by the
 * server's per-kind gate; being listed here grants nothing.
 *
 * Bounded, because each id is its own request against a rate-limited route.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many experiences are resolved for one lens load. */
export const MAX_LENS_EXPERIENCES = 8;

export interface ExperienceSourceInputs {
  deepLinked?: readonly (string | null | undefined)[];
  myEvents?: readonly { id: string }[];
  myTrips?: readonly { id: string }[];
  nearbyEvents?: readonly { id: string }[];
}

export function experienceIdsFrom(inputs: ExperienceSourceInputs, cap = MAX_LENS_EXPERIENCES): string[] {
  const out: string[] = [];
  const push = (id: unknown) => {
    if (out.length >= cap) return;
    if (typeof id !== 'string' || !UUID_RE.test(id) || out.includes(id)) return;
    out.push(id);
  };
  for (const id of inputs.deepLinked ?? []) push(id);
  for (const e of inputs.myEvents ?? []) push(e?.id);
  for (const t of inputs.myTrips ?? []) push(t?.id);
  for (const e of inputs.nearbyEvents ?? []) push(e?.id);
  return out;
}
