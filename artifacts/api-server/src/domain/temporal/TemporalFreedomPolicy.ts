import type { FreedomWindow } from './TemporalFreedomEngine.js';

export interface TemporalSoftConstraint { key: string; value: string }
export interface TemporalFreedomPolicy {
  maxLatenessMinutes: number;
  unsafeActionsPermitted: false;
  uncertaintyShare: number;
  softConstraints: readonly TemporalSoftConstraint[];
}

/** Policy narrows an existing computed window; it cannot create time or permit an unsafe action. */
export function constrainFreedomWindow(window: FreedomWindow, policy: TemporalFreedomPolicy, nowMs: number): FreedomWindow {
  const maxLate = Number.isFinite(policy.maxLatenessMinutes) ? Math.max(0, policy.maxLatenessMinutes) : 0;
  const share = Number.isFinite(policy.uncertaintyShare) ? Math.max(0, Math.min(1, policy.uncertaintyShare)) : 1;
  const oldEnd = Date.parse(window.endsAt);
  const cap = window.requiredDestination && window.reservedMinutes !== null
    ? Date.parse(window.requiredDestination.arriveBy) + (maxLate - window.reservedMinutes) * 60000 : oldEnd;
  const end = Math.min(oldEnd, cap);
  const begins = Math.max(Date.parse(window.beginsAt), nowMs);
  const available = Math.min(window.usableMinutes ?? Infinity, Math.max(0, Math.floor((end - begins) / 60000)));
  const held = Math.ceil(available * share);
  return { ...window, endsAt: new Date(end).toISOString(),
    usableMinutes: available - held,
    riskBudget: { maxLatenessMinutes: maxLate, unsafeActionsPermitted: false },
    uncertaintyBudget: { reservedMinutes: held, share, basis: 'policy_reserve' },
    softConstraints: policy.softConstraints.map(p => ({ key: p.key, value: p.value })) };
}
