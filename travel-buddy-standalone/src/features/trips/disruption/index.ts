/**
 * src/features/trips/disruption — §17.2's priority switch as the client obeys
 * it, and §17.3's rescue entry. The switch is derived by the server on the
 * Today projection; this module is where the client reads it from (TR317,
 * TR319) and where a traveller under it asks for a plan (TR318, TR320–TR328).
 */
export { attentionBanner, type TodayAttention, type PriorityMode } from '../today/tripToday.ts';
export * from './tripRescue.ts';
export { TripRescueEntry } from './TripRescueEntry.tsx';
