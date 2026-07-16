/**
 * Shared formatting helpers for Layover Mode UI.
 */
import { color } from '../../theme/tokens.ts';
import type { LayoverTier } from '../../services/layover.ts';

/** Format an instant as HH:MM in the airport's timezone (falls back to UTC slice). */
export function fmtClock(iso: string | Date | null | undefined, tz?: string | null): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz ?? undefined,
    }).format(d);
  } catch {
    return `${d.toISOString().slice(11, 16)} UTC`;
  }
}

/** "135" → "2h 15m", "45" → "45m" */
export function fmtDur(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min < 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Remaining time until an instant, clamped at zero. */
export function remainingMin(targetIso: string | null | undefined, nowMs: number): number {
  if (!targetIso) return 0;
  const target = new Date(targetIso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - nowMs) / 60_000));
}

export function tierDotColor(tier: LayoverTier): string {
  switch (tier) {
    case 'too_short':    return color.signal;
    case 'airport_only': return color.warn;
    case 'quick_city':   return '#5AA9C4';
    case 'half_day':     return color.success;
    case 'overnight':    return '#9B7BD4';
    default:             return color.faint;
  }
}

export const REC_EMOJI: Record<string, string> = {
  food: '🍜', activity: '🎯', rest: '😴', meetup: '🤝',
  nightlife: '🌙', shopping: '🛍', culture: '🏛',
};

export function safetyColors(rating: string): { bg: string; fg: string } {
  switch (rating) {
    case 'safe':               return { bg: 'rgba(46,125,91,0.12)',  fg: color.success };
    case 'possible_but_risky': return { bg: 'rgba(200,133,26,0.14)', fg: color.warn };
    case 'not_recommended':    return { bg: 'rgba(255,77,46,0.12)',  fg: color.signalDim };
    case 'airport_only':       return { bg: 'rgba(10,61,74,0.10)',   fg: color.deep };
    default:                   return { bg: color.haze, fg: color.mute };
  }
}
