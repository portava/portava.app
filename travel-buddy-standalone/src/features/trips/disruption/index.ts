/**
 * src/features/trips/disruption — §17.2's priority switch as the client obeys
 * it. The switch is derived by the server on the Today projection; this
 * module is the one place the client reads it from (TR317, TR319).
 */
export { attentionBanner, type TodayAttention, type PriorityMode } from '../today/tripToday.ts';
